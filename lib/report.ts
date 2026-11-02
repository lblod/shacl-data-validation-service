import fs from "fs";
import envvar from "env-var";
import rdf from "rdf-ext";

const REPORTS_DIR = "/share/";

const KEEP_ALL_REPORTS = envvar
  .get("KEEP_ALL_REPORTS")
  .default("false")
  .asBool();

function timestamp() {
  return new Date().toJSON().replace(/-|T|:|\.|Z/gi, "");
}

export function writeReportFile(report) {
  const filenamePrefix = KEEP_ALL_REPORTS ? timestamp() + "--" : "";
  const filePath = REPORTS_DIR + filenamePrefix + "report.nt";

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  // The report object refers to its RDF factory, which can't be serialized as
  // JSON. Its dataset is the SHACL validation report.
  fs.writeFileSync(filePath, report.dataset.toString());
}

const SH = "http://www.w3.org/ns/shacl#";
const SHN = "https://schemas.link/shacl-next#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

// The JSON-LD context of the report: the SHACL terms by their local name. The
// service serves the file at /contexts/validation-report.jsonld, the report
// refers to it by REPORT_CONTEXT_URL. The test cases use it too, for the terms
// of the SHACL test suite by their prefixed name, e.g. mf:entries.
export const REPORT_CONTEXT_FILE = "config/contexts/validation-report.jsonld";
export const REPORT_CONTEXT = JSON.parse(
  fs.readFileSync(REPORT_CONTEXT_FILE, "utf-8"),
)["@context"];
export const REPORT_CONTEXT_URL = envvar
  .get("REPORT_CONTEXT_URL")
  .default("http://localhost:8897/contexts/validation-report.jsonld")
  .asUrlString();

// The SHACL terms of the context by their IRI, in the order of the context:
// not the prefixes, e.g. sh, nor the terms of the test cases, which have a
// prefixed name, e.g. mf:entries
const TERMS = new Map(
  Object.entries(REPORT_CONTEXT)
    .map(([term, definition]) => [
      term,
      typeof definition === "string" ? definition : definition["@id"],
    ])
    .filter(([term, iri]) => !term.includes(":") && iri?.startsWith("sh:"))
    .map(([term, iri]) => [expand(iri), term]),
);

function expand(iri: string) {
  return iri.replace(/^sh:/, SH).replace(/^shn:/, SHN);
}

function compact(iri: string) {
  if (iri.startsWith(SH)) return "sh:" + iri.slice(SH.length);
  if (iri.startsWith(SHN)) return "shn:" + iri.slice(SHN.length);
  return iri;
}

function definition(term: string) {
  const definition = REPORT_CONTEXT[term];
  return typeof definition === "object" ? definition : {};
}

/*
 * The SHACL validation report as JSON-LD, with REPORT_CONTEXT, referred to by
 * its URL (REPORT_CONTEXT_URL): the report
 * with its results (result), each with its URI (@id, see identifyResults in
 * lib/validation.ts) and its source shape with the name of the shape
 * (sourceShape, with name), and the result messages by language
 * (resultMessage). Properties outside the context have their IRI as key. The
 * values are sorted, so the same report gives the same JSON.
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
  return { "@context": REPORT_CONTEXT_URL, ...node(dataset, reportNode, []) };
}

function node(dataset, term, path) {
  const object =
    term.termType === "NamedNode" ? { "@id": compact(term.value) } : {};
  const values = new Map<string, unknown[]>();
  for (const { predicate, object: value } of dataset.match(term)) {
    if (predicate.value === RDF + "type") {
      values.set("@type", [
        ...(values.get("@type") ?? []),
        compact(value.value),
      ]);
      continue;
    }
    const key = TERMS.get(predicate.value) ?? predicate.value;
    values.set(key, [
      ...(values.get(key) ?? []),
      json(dataset, value, key, [...path, term]),
    ]);
  }
  const keys = [...values.keys()].sort(
    (a, b) => order(a) - order(b) || a.localeCompare(b),
  );
  for (const key of keys) {
    const items = values.get(key);
    const container = definition(key)["@container"];
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
function order(key: string) {
  if (key === "@id") return -2;
  if (key === "@type") return -1;
  const index = [...TERMS.values()].indexOf(key);
  return index === -1 ? TERMS.size : index;
}

function json(dataset, term, key: string, path) {
  const coerced = definition(key)["@type"] === "@id";
  if (term.termType === "Literal") {
    const datatype = term.datatype?.value;
    if (term.language || definition(key)["@container"] === "@language") {
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
    if (dataset.match(term, null, null).size === 0)
      return { "@id": `_:${term.value}` };
    const list = rdfList(dataset, term);
    if (list) {
      const items = list.map((item) => json(dataset, item, key, path));
      return definition(key)["@container"] === "@list"
        ? items
        : { "@list": items };
    }
    return node(dataset, term, path);
  }
  // A named node with properties in the report, e.g. a result or a source
  // shape with its name, is embedded, unless that would make a cycle
  const embed =
    dataset.match(term, null, null).size > 0 &&
    !path.some((ancestor) => ancestor.equals(term));
  if (embed) return node(dataset, term, path);
  return coerced ? compact(term.value) : { "@id": compact(term.value) };
}

// The items of an RDF list starting at the node, if it's one
function rdfList(dataset, term) {
  const items = [];
  let current = term;
  while (current.value !== RDF + "nil") {
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
