import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import envvar from "env-var";
import jsonld from "jsonld";
import type { NodeObject } from "jsonld";

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
async function serializeReport(report) {
  if (REPORT_FORMAT === "json-ld") {
    return JSON.stringify(await reportJsonLd(report), null, 2);
  }
  return report.dataset.toString();
}

export async function writeReportFile(report, shape?) {
  const name = reportFilename(shape);
  const filePath = REPORTS_DIR + timestamp() + "--" + name;

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  await fs.writeFile(filePath, await serializeReport(report));
  await removeOldReports(name);
}

// The JSON-LD context of the report: the SHACL terms by their local name,
// embedded in each JSON-LD report
const REPORT_CONTEXT = JSON.parse(
  readFileSync("config/contexts/validation-report.jsonld", "utf-8"),
)["@context"];

/*
 * The SHACL validation report as JSON-LD, with REPORT_CONTEXT embedded: the
 * report with its results (result), each with its focus node, value, path,
 * severity, source shape and constraint component, and the result messages by
 * language (resultMessage). The report is canonicalised first, so its blank
 * nodes get the same labels, and the same report gives the same JSON.
 */
export async function reportJsonLd(report) {
  // RDFC-1.0, the default algorithm
  const nquads = await jsonld.canonize(report.dataset.toString(), {
    inputFormat: "application/n-quads",
    format: "application/n-quads",
  });
  const expanded = await jsonld.fromRDF(nquads, {
    format: "application/n-quads",
  });
  // The results are embedded in the report, each node once (@once, the
  // default), so a node that refers back to the report isn't embedded again
  return jsonld.frame(expanded.map(withNativeBooleans), {
    "@context": REPORT_CONTEXT,
    "@type": "sh:ValidationReport",
  });
}

const XSD_BOOLEAN = "http://www.w3.org/2001/XMLSchema#boolean";

// The node with its booleans, e.g. conforms, as JSON booleans. With
// useNativeTypes, jsonld.js also gives plain strings the type xsd:string,
// which keeps them out of the language map of resultMessage.
function withNativeBooleans(node: NodeObject): NodeObject {
  return Object.fromEntries(
    Object.entries(node).map(([key, values]) => [
      key,
      Array.isArray(values) ? values.map(nativeBoolean) : values,
    ]),
  );
}

function nativeBoolean(value) {
  const isBoolean =
    value["@type"] === XSD_BOOLEAN &&
    ["true", "false"].includes(value["@value"]);
  return isBoolean ? { "@value": value["@value"] === "true" } : value;
}
