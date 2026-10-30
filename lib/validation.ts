import { createHash } from "node:crypto";
import rdf from "rdf-ext";
import { objectsForPredicate } from "../util/dataset";
import { validateResourceWithSparqlTargets } from "./engine";
import { rulesForResource } from "./rules";
import {
  getValidationShape,
  shapeWithReferencedShapes,
  targetedShapesForResource,
} from "./validation-shapes";

const VALIDATION_SHAPE = "http://mu.semte.ch/vocabularies/ext/validationShape";
const CONFORMS_MESSAGE = "http://mu.semte.ch/vocabularies/ext/conformsMessage";
const MESSAGE_PATH = "http://mu.semte.ch/vocabularies/ext/messagePath";
const SH = "http://www.w3.org/ns/shacl#";
const DEBUG = "https://schemas.link/shacl-next#Debug";
// The URIs of the validation results, see identifyResults
const VALIDATION_RESULTS = "http://data.lblod.info/id/validation-results/";

/*
 * The validation shapes to validate a resource against, with their URIs:
 * - the validation shapes linked by the rules applicable to the resource
 * - the validation shapes whose SPARQL-based target selects a focus node in
 *   the resource, they don't need a rule (e.g. the publicatieplicht shapes)
 */
export async function validationShapesForResource(resource) {
  // NOTE (22/10/2026): We lose the connection between validation shape and
  // rule here, that might be an issue when interpreting the report.  It is
  // probably nice if can convert the engine's report to something more
  // readable that says which rule was violated and why.
  const rules = await rulesForResource(resource);
  const ruleShapes = objectsForPredicate(VALIDATION_SHAPE, rules);
  const targetedShapes = await targetedShapesForResource(resource);

  const shapes = rdf.dataset();
  for (const shape of ruleShapes) {
    shapes.addAll(await getValidationShape(shape.value));
  }
  for (const shape of targetedShapes) {
    shapes.addAll(shapeWithReferencedShapes(shape));
  }

  const uris = [
    ...new Set([...ruleShapes, ...targetedShapes].map((shape) => shape.value)),
  ];
  return { uris, shapes };
}

/*
 * The result of a passed validation (shn:Debug) has the message of its shape
 * (sh:message), which describes the failure. Replaces it with the message the
 * shape has for a passed validation (ext:conformsMessage), if any.
 */
function useConformsMessages(report, shapes) {
  const dataset = report.dataset;
  const resultMessage = rdf.namedNode(SH + "resultMessage");
  const passed = dataset.match(
    null,
    rdf.namedNode(SH + "resultSeverity"),
    rdf.namedNode(DEBUG),
  );
  for (const { subject: result } of passed) {
    for (const { object: shape } of dataset.match(
      result,
      rdf.namedNode(SH + "sourceShape"),
    )) {
      const messages = shapes.match(shape, rdf.namedNode(CONFORMS_MESSAGE));
      if (!messages.size) continue;
      for (const quad of [...dataset.match(result, resultMessage)]) {
        dataset.delete(quad);
      }
      for (const { object: message } of messages) {
        dataset.add(rdf.quad(result, resultMessage, message));
      }
    }
  }
}

/*
 * Fills the variables of the result messages: {?value} with the value of the
 * result, and {?name} with the values the value has in the data for each
 * property the shape lists with ext:messagePath, by the local name of the
 * property, e.g. {?bronUriAfwijkendeNotatie}. SHACL only fills the parameters
 * of the constraint.
 */
function fillMessageVariables(report, shapes, data) {
  const dataset = report.dataset;
  const resultMessage = rdf.namedNode(SH + "resultMessage");
  for (const { object: result } of dataset.match(
    null,
    rdf.namedNode(SH + "result"),
  )) {
    const [value] = [...dataset.match(result, rdf.namedNode(SH + "value"))];
    const [shape] = [
      ...dataset.match(result, rdf.namedNode(SH + "sourceShape")),
    ];
    if (!value) continue;
    const variables = { value: value.object.value };
    for (const { object: path } of shape
      ? shapes.match(shape.object, rdf.namedNode(MESSAGE_PATH))
      : []) {
      const name = path.value.replace(/^.*[/#]/, "");
      // Sorted, so the message is the same for the same data
      variables[name] = [...data.match(value.object, path)]
        .map(({ object }) => object.value)
        .sort()
        .join(", ");
    }
    for (const quad of [...dataset.match(result, resultMessage)]) {
      const message = quad.object.value.replace(
        /\{\?(\w+)\}/g,
        (variable, name) => variables[name] ?? variable,
      );
      if (message === quad.object.value) continue;
      dataset.delete(quad);
      dataset.add(
        rdf.quad(
          result,
          resultMessage,
          rdf.literal(message, quad.object.language || undefined),
        ),
      );
    }
  }
}

/*
 * Gives each validation result (sh:result, and the results it details,
 * sh:detail) a URI instead of a blank node, so e.g. the JSON-LD report (see
 * reportJsonLd in lib/report.ts) can be linked to. The URI is a hash of the focus node, source shape, constraint component
 * and value of the result, and of the result it details, so a result has the
 * same URI in every validation of the same data.
 */
function identifyResults(report) {
  const dataset = report.dataset;
  const results = rdf.termMap();
  const uris = new Set<string>();
  const identify = (result, parent = "") => {
    if (result.termType !== "BlankNode" || results.has(result)) return;
    const key = [
      "focusNode",
      "sourceShape",
      "sourceConstraintComponent",
      "value",
    ]
      .map((property) =>
        [...dataset.match(result, rdf.namedNode(SH + property))]
          .map(({ object }) => `${object.termType}:${object.value}`)
          .join(" "),
      )
      .concat(parent)
      .join("\n");
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
    let uri = VALIDATION_RESULTS + hash;
    for (let n = 2; uris.has(uri); n++) {
      uri = `${VALIDATION_RESULTS}${hash}-${n}`;
    }
    results.set(result, uri);
    uris.add(uri);
    for (const { object: detail } of dataset.match(
      result,
      rdf.namedNode(SH + "detail"),
    )) {
      identify(detail, uri);
    }
  };
  for (const { object: result } of dataset.match(
    null,
    rdf.namedNode(SH + "result"),
  )) {
    identify(result);
  }
  const term = (node) =>
    results.has(node) ? rdf.namedNode(results.get(node)) : node;
  for (const quad of [...dataset]) {
    if (!results.has(quad.subject) && !results.has(quad.object)) continue;
    dataset.delete(quad);
    dataset.add(
      rdf.quad(term(quad.subject), quad.predicate, term(quad.object)),
    );
  }
}

/*
 * Adds the names of the source shapes of the results (sh:name) to the report,
 * e.g. the name of the check of the publicatieplicht a result is for, which is
 * the same for each type of document.
 */
function addShapeNames(report, shapes) {
  const dataset = report.dataset;
  const name = rdf.namedNode(SH + "name");
  for (const { object: shape } of [
    ...dataset.match(null, rdf.namedNode(SH + "sourceShape")),
  ]) {
    for (const quad of shapes.match(shape, name)) {
      dataset.add(rdf.quad(shape, name, quad.object));
    }
  }
}

/*
 * Validates a resource against its validation shapes. Returns the URIs of the
 * validation shapes and the SHACL validation report, without a report if no
 * validation shape applies to the resource. With debug, the report also has
 * the passed validations, see validateResourceWithSparqlTargets, with the
 * messages of their shapes for a passed validation, see useConformsMessages.
 * The variables of the result messages are filled, see fillMessageVariables,
 * the results have a URI, see identifyResults, and their source shapes their
 * name, see addShapeNames.
 */
export async function validate(resource, { debug = false } = {}) {
  const { uris, shapes } = await validationShapesForResource(resource);
  if (!uris.length) {
    return { shapeUris: uris };
  }
  const report = await validateResourceWithSparqlTargets(resource, shapes, {
    debug,
  });
  if (debug) useConformsMessages(report, shapes);
  fillMessageVariables(report, shapes, resource);
  identifyResults(report);
  addShapeNames(report, shapes);
  return { shapeUris: uris, report };
}
