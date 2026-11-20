import { updateSudo as update } from "@lblod/mu-auth-sudo";
import envvar from "env-var";
import type { NodeObject } from "jsonld";
import jsonld from "jsonld";
import { sparqlEscapeUri, uuid } from "mu";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import rdf from "rdf-ext";
import { localName } from "../util/iri";
import { shapeResources } from "./validation-shapes";

// NOTE (03/11/2026): Very rudimentary way to persist validation reports.  We
// just write the report's dataset as N-Triples or as JSON-LD.  Better ways to
// handle the report will be added in the future.

const REPORT_GRAPH = envvar
  .get("REPORT_GRAPH")
  .default("http://mu.semte.ch/graphs/shacl-validation-reports")
  .asString();

const RESOURCE_BASE = envvar
  .get("REPORT_RESOURCE_BASE")
  .default("http://data.lblod.info/id/shacl-validation-reports/")
  .asString();

export const REPORTS_DIR = "/share/";

const MAX_REPORTS = envvar.get("MAX_REPORTS").default("100").asIntPositive();

const REPORT_FORMAT = envvar
  .get("REPORT_FORMAT")
  .default("n-triples")
  .asEnum(["n-triples", "json-ld"]);

const EXTENSIONS = { "n-triples": "nt", "json-ld": "jsonld" };

// TODO: Overlap with similar constant in rules
const PREDICATES = {
  CREATED: rdf.namedNode("http://purl.org/dc/terms/created"),
  RESULT: rdf.namedNode("http://www.w3.org/ns/shacl#result"),
  SOURCE_SHAPE: rdf.namedNode("http://www.w3.org/ns/shacl#sourceShape"),
  TYPE: rdf.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
  UUID: rdf.namedNode("http://mu.semte.ch/vocabularies/core/uuid"),
};

const TYPES = {
  REPORT: rdf.namedNode("http://www.w3.org/ns/shacl#ValidationReport"),
  RESULT: rdf.namedNode("http://www.w3.org/ns/shacl#ValidationResult"),
};

function replaceTerm(oldTerm, newTerm, dataset) {
  dataset.forEach((quad) => {
    // NOTE (24/11/2026): We ignore quads where subject and object are oldTerm
    // as this does not occur in validation reports.
    if (quad.subject.equals(oldTerm)) {
      dataset.delete(quad);
      dataset.add(rdf.quad(newTerm, quad.predicate, quad.object));
    }
    if (quad.object.equals(oldTerm)) {
      dataset.delete(quad);
      dataset.add(rdf.quad(quad.subject, quad.predicate, newTerm));
    }
  });
}

// NOTE (24/11/2026): This modifies the provided dataset, avoid calling it when
// looping over that same dataset.
function replaceBlankNode(blankNode, baseUri, dataset) {
  // Construct full URI
  const nodeUuid = uuid();
  const uri = baseUri + nodeUuid;
  const node = rdf.namedNode(uri);

  // Replace all references the the blank node
  replaceTerm(blankNode, node, dataset);

  // Add UUID triple
  dataset.add(rdf.quad(node, PREDICATES.UUID, rdf.literal(nodeUuid)));

  return node;
}

function processReportDataset(report) {
  // NOTE (25/11/2026): This processing modifies the report's dataset so we make
  // a clone first.
  const dataset = report.dataset.clone();

  // Replace validation report blank node with proper URI + UUID
  const validationReports = dataset.filter(
    (quad) =>
      quad.predicate.equals(PREDICATES.TYPE) &&
      quad.object.equals(TYPES.REPORT),
  );

  for (const validationReport of validationReports) {
    const reportNode = replaceBlankNode(
      validationReport.subject,
      RESOURCE_BASE + "report/",
      dataset,
    );

    // Add report creation date triple
    const now = new Date().toISOString();
    dataset.add(
      rdf.quad(
        reportNode,
        PREDICATES.CREATED,
        rdf.literal(
          now,
          rdf.namedNode("http://www.w3.org/2001/XMLSchema#dateTime"),
        ),
      ),
    );

    // Process validation results in report
    const validationResults = dataset.filter(
      (quad) =>
        quad.subject.equals(reportNode) &&
        quad.predicate.equals(PREDICATES.RESULT),
    );

    validationResults.forEach((result) =>
      replaceBlankNode(result.object, RESOURCE_BASE + "result/", dataset),
    );

    // Add source shapes linked by the report's results
    dataset
      .filter((quad) => quad.predicate.equals(PREDICATES.SOURCE_SHAPE))
      .forEach((sourceShape) => {
        const shapes = shapeResources([sourceShape.object]);
        dataset.addAll(shapes);
      });

    // NOTE (25/11/2026):
    // - At this point the only blank nodes in dataset should be (indirectly
    //   linked) source shapes.  Therefore, we do not filter more specifically
    //   for source shape blank nodes.  This way all other shapes linked by the
    //   source shapes are also covered, as well as the `sh:sourceShape` quads
    //   referencing a result's source shape.
    // - Source shapes that are identified by blank nodes will be assigned a URI
    //   per report referencing them.  So the same source shape will be
    //   inserted multiple times for different reports under different URIs.
    const blankNodes = rdf.termSet();
    dataset
      .filter((quad) => quad.subject.termType === "BlankNode")
      .forEach((quad) => blankNodes.add(quad.subject));

    blankNodes.forEach((bnode) => {
      replaceBlankNode(bnode, RESOURCE_BASE + "source-shape/", dataset);
    });
  }

  return dataset;
}

// TODO: Batch inserts
export async function insertReport(report) {
  const dataset = processReportDataset(report);

  const triples = dataset.toString();
  const insertQuery = `INSERT DATA {
     GRAPH ${sparqlEscapeUri(REPORT_GRAPH)} {
       ${triples}
     }
   }`;
  await update(insertQuery);
}

function timestamp() {
  return new Date().toJSON().replace(/-|T|:|\.|Z/gi, "");
}

// Removes the oldest reports beyond MAX_REPORTS. Their timestamps sort reports
// by age.
async function removeOldReports() {
  const reports = (await fs.readdir(REPORTS_DIR))
    .filter((file) => file.includes("--report"))
    .sort();
  const oldReports = reports.slice(0, -MAX_REPORTS);
  for (const report of oldReports) {
    await fs.rm(REPORTS_DIR + report);
  }
}

// A report's filename starts with a timestamp, which sorts reports by age. A
// report of a validation against a single shape is named after that shape.
// The extension is the one of the REPORT_FORMAT.
function reportFilename(shape?) {
  const extension = EXTENSIONS[REPORT_FORMAT];
  if (!shape) return `${timestamp()}--report.${extension}`;
  const name = localName(shape.value);
  return `${timestamp()}--report-${name}.${extension}`;
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
  const filename = reportFilename(shape);
  const filePath = REPORTS_DIR + filename;

  await fs.writeFile(filePath, await serializeReport(report));
  await removeOldReports();
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
async function reportJsonLd(report) {
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
