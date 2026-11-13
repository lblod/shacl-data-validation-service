import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import envvar from "env-var";
import rdf from "rdf-ext";

// NOTE (03/11/2026): Very rudimentary way to persist validation reports.  We
// just write the report's dataset as N-Triples or as JSON-LD.  Better ways to
// handle the report will be added in the future.

const REPORTS_DIR = "/share/";

const ONLY_KEEP_LATEST_REPORT = envvar
  .get("ONLY_KEEP_LATEST_REPORT")
  .default("false")
  .asBool();

const MAX_REPORTS = envvar.get("MAX_REPORTS").default("100").asIntPositive();

const REPORT_FORMAT = envvar
  .get("REPORT_FORMAT")
  .default("n-triples")
  .asEnum(["n-triples", "json-ld"]);

const EXTENSIONS = { "n-triples": "nt", "json-ld": "jsonld" };

function timestamp() {
  return new Date().toJSON().replace(/-|T|:|\.|Z/gi, "");
}

/*
 * Removes the older versions of the report with the given name, or else the
 * oldest reports beyond MAX_REPORTS. Their timestamps sort reports by age, so
 * the report just written comes last.
 */
async function removeOldReports(name: string) {
  const reports = (await fs.readdir(REPORTS_DIR))
    .filter((file) => file.includes("--report"))
    .sort();
  const oldReports = ONLY_KEEP_LATEST_REPORT
    ? reports.filter((file) => file.endsWith("--" + name)).slice(0, -1)
    : reports.slice(0, -MAX_REPORTS);
  for (const report of oldReports) {
    await fs.rm(REPORTS_DIR + report);
  }
}

// A report of a validation against a single shape is named after that shape.
// The hash keeps shapes with the same local name apart. The extension is the
// one of the REPORT_FORMAT.
function reportFilename(shape?) {
  const extension = EXTENSIONS[REPORT_FORMAT];
  if (!shape) return `report.${extension}`;
  const localName = shape.value
    .replace(/^.*[#/:]/, "")
    .replace(/[^A-Za-z0-9_-]/g, "_");
  const hash = createHash("sha256").update(shape.value).digest("hex");
  return `report-${localName}-${hash.slice(0, 8)}.${extension}`;
}

// The report object refers to its RDF factory, which can't be serialized as
// JSON. Its dataset is the SHACL validation report.
function serializeReport(report) {
  if (REPORT_FORMAT === "json-ld") {
    return JSON.stringify(reportJsonLd(report), null, 2);
  }
  return report.dataset.toString();
}

export async function writeReportFile(report, shape?) {
  const name = reportFilename(shape);
  const filePath = REPORTS_DIR + timestamp() + "--" + name;

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  await fs.writeFile(filePath, serializeReport(report));
  await removeOldReports(name);
}

const SH = "http://www.w3.org/ns/shacl#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

// The JSON-LD context of the report: the SHACL terms by their local name,
// embedded in each JSON-LD report
const REPORT_CONTEXT = JSON.parse(
  readFileSync("config/contexts/validation-report.jsonld", "utf-8"),
)["@context"];

// The terms of the context by their IRI, in the order of the context, without
// the prefixes, e.g. sh
const TERMS = new Map<string, string>(
  Object.entries(REPORT_CONTEXT)
    .map(([term, definition]) => [
      term,
      typeof definition === "string" ? definition : definition["@id"],
    ])
    .filter(([term, iri]) => !term.includes(":") && iri?.startsWith("sh:"))
    .map(([term, iri]) => [expand(iri), term]),
);

function expand(iri: string) {
  return iri.replace(/^sh:/, SH);
}

function compact(iri: string) {
  return iri.startsWith(SH) ? "sh:" + iri.slice(SH.length) : iri;
}

function getContextDefinition(term: string) {
  const definition = REPORT_CONTEXT[term];
  return typeof definition === "object" ? definition : {};
}

/*
 * The SHACL validation report as JSON-LD, with REPORT_CONTEXT embedded: the
 * report with its results (result), each with its focus node, value, path,
 * severity, source shape and constraint component, and the result messages by
 * language (resultMessage). Properties outside the context have their IRI as
 * key. The values are sorted, so the same report gives the same JSON.
 */
export function reportJsonLd(report) {
  const dataset = report.dataset;
  const [reportNode] = [
    ...dataset.match(
      null,
      rdf.namedNode(RDF + "type"),
      rdf.namedNode(SH + "ValidationReport"),
    ),
  ].map(({ subject }) => subject);
  return {
    "@context": REPORT_CONTEXT,
    ...nodeToJsonLd(dataset, reportNode, []),
  };
}

// A blank node needs its @id when other values refer to it as well: when it's
// embedded and referred to elsewhere, or when it's the report and referred to
function needsBlankNodeId(dataset, term, path) {
  const references = dataset.match(null, null, term).size;
  return path.length ? references > 1 : references > 0;
}

// A node of the report as a JSON-LD object with its properties. The path holds
// the nodes it is embedded in, to not embed a node in itself.
function nodeToJsonLd(dataset, term, path) {
  const object = {};
  if (term.termType === "NamedNode") {
    object["@id"] = compact(term.value);
  } else if (needsBlankNodeId(dataset, term, path)) {
    object["@id"] = `_:${term.value}`;
  }
  const values = new Map<string, unknown[]>();
  for (const { predicate, object: value } of dataset.match(term)) {
    if (predicate.value === RDF + "type") {
      values.set("@type", [
        ...(values.get("@type") ?? []),
        compact(value.value),
      ]);
      continue;
    }
    let key = TERMS.get(predicate.value) ?? predicate.value;
    let item = valueToJsonLd(dataset, value, key, [...path, term]);
    // A term with a @list container only holds a well-formed list, another
    // value goes by the IRI of the property
    if (
      getContextDefinition(key)["@container"] === "@list" &&
      !Array.isArray(item)
    ) {
      key = predicate.value;
      item = valueToJsonLd(dataset, value, key, [...path, term]);
    }
    values.set(key, [...(values.get(key) ?? []), item]);
  }
  const keys = [...values.keys()].sort(
    (a, b) => getKeyOrder(a) - getKeyOrder(b) || a.localeCompare(b),
  );
  for (const key of keys) {
    const items = values.get(key);
    const container = getContextDefinition(key)["@container"];
    if (container === "@language") {
      object[key] = languageMap(
        items as { "@value": string; "@language"?: string }[],
      );
    } else if (container === "@list") {
      object[key] = items[0];
    } else if (container === "@set" || items.length > 1) {
      object[key] = items.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
    } else {
      object[key] = items[0];
    }
  }
  return object;
}

// The position of a key: @id and @type first, then the terms of the context
function getKeyOrder(key: string) {
  if (key === "@id") return -2;
  if (key === "@type") return -1;
  const index = [...TERMS.values()].indexOf(key);
  return index === -1 ? TERMS.size : index;
}

// The value of a property as JSON-LD, given the definition of its key
function valueToJsonLd(dataset, term, key: string, path) {
  const definition = getContextDefinition(key);
  const coerced = definition["@type"] === "@id";
  if (term.termType === "Literal") {
    const datatype = term.datatype?.value;
    if (term.language || definition["@container"] === "@language") {
      return { "@value": term.value, "@language": term.language || undefined };
    }
    if (
      datatype === XSD + "boolean" &&
      ["true", "false"].includes(term.value)
    ) {
      return term.value === "true";
    }
    if (datatype === XSD + "string") {
      return coerced ? { "@value": term.value } : term.value;
    }
    return { "@value": term.value, "@type": compact(datatype) };
  }
  if (term.termType === "BlankNode") {
    // A blank node without properties, or one it is embedded in, e.g. the
    // report, by its @id
    if (
      dataset.match(term).size === 0 ||
      path.some((ancestor) => ancestor.equals(term))
    ) {
      return { "@id": `_:${term.value}` };
    }
    const list = rdfList(dataset, term);
    if (list) {
      const items = list.map((item) => valueToJsonLd(dataset, item, key, path));
      return definition["@container"] === "@list" ? items : { "@list": items };
    }
    return nodeToJsonLd(dataset, term, path);
  }
  // A named node with properties in the report, e.g. a result, is embedded,
  // unless that would make a cycle
  const embed =
    dataset.match(term).size > 0 &&
    !path.some((ancestor) => ancestor.equals(term));
  if (embed) return nodeToJsonLd(dataset, term, path);
  return coerced ? compact(term.value) : { "@id": compact(term.value) };
}

// The items of an RDF list starting at the node, if it's a well-formed one:
// each list node a blank node only the previous node refers to, as JSON-LD
// requires to write it as a list
function rdfList(dataset, term) {
  const items = [];
  let current = term;
  while (current.value !== RDF + "nil") {
    if (
      current.termType !== "BlankNode" ||
      dataset.match(null, null, current).size !== 1
    ) {
      return undefined;
    }
    const [first] = [...dataset.match(current, rdf.namedNode(RDF + "first"))];
    const [rest] = [...dataset.match(current, rdf.namedNode(RDF + "rest"))];
    if (!first || !rest) return undefined;
    items.push(first.object);
    current = rest.object;
  }
  return items;
}

// Messages by language, @none for messages without one
function languageMap(items: { "@value": string; "@language"?: string }[]) {
  const map = {};
  for (const item of items.sort((a, b) =>
    a["@value"].localeCompare(b["@value"]),
  )) {
    const language = item["@language"] ?? "@none";
    map[language] =
      map[language] === undefined
        ? item["@value"]
        : [map[language], item["@value"]].flat();
  }
  return map;
}
