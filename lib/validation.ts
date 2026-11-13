import rdf from "rdf-ext";
import { PREFIXES } from "../constants";
import { getObjects } from "../util/rdf-ext-helpers";
import { validateFocusNode } from "./engine";
import { getShapeData } from "./resource-retrieval";
import {
  shapeWithReferencedShapes,
  targetedShapesForResource,
} from "./validation-shapes";

/*
 * Fills the variables of the result messages: {?value} with the value of the
 * result, and {?name} with the values the value has in the data for each
 * property the shape lists with ext:messagePath, by the local name of the
 * property, e.g. {?nameVariable}. SHACL only fills the parameters
 * of the constraint.
 */
function fillMessageVariables(report, shapes, data) {
  const dataset = report.dataset;
  const resultMessage = rdf.namedNode(PREFIXES.sh + "resultMessage");

  const results = getObjects(dataset, null, PREFIXES.sh + "result");
  for (const result of results) {
    const [value] = getObjects(dataset, result, PREFIXES.sh + "value");
    if (!value) continue;
    const [shape] = getObjects(dataset, result, PREFIXES.sh + "sourceShape");
    const paths = shape
      ? getObjects(shapes, shape, PREFIXES.ext + "messagePath")
      : [];

    const variables = { value: value.value };
    for (const path of paths) {
      const name = path.value.replace(/^.*[/#]/, "");
      const values = getObjects(data, value, path.value).map(
        (term) => term.value,
      );
      // Sorted, so the message is the same for the same data
      variables[name] = values.sort().join(", ");
    }

    // A copy, as the loop replaces the messages in the dataset
    const messages = [...dataset.match(result, resultMessage)];
    for (const quad of messages) {
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

// Validates a resource on its data against a validation shape, with the shapes
// it refers to. The variables of the result messages are filled, see
// fillMessageVariables.
export async function validateShape(data, shape, uri: string) {
  const shapes = shapeWithReferencedShapes(shape);
  const report = await validateFocusNode(
    data,
    shapes,
    shape,
    rdf.namedNode(uri),
  );
  fillMessageVariables(report, shapes, data);
  return report;
}

/*
 * Validates a resource against each validation shape that targets it, on the
 * data of that shape. Returns the SHACL validation report of each validated
 * shape in results, and each shape whose validation failed with its error in
 * errors. A resource that doesn't exist has no targeting shapes, so both are
 * empty.
 */
export async function validateResource(uri: string) {
  const results = [];
  const errors = [];
  // In series: one query at a time on the store, and a failing shape doesn't
  // stop the others
  for (const shape of await targetedShapesForResource(uri)) {
    try {
      const data = await getShapeData(shape, uri);
      results.push({ shape, report: await validateShape(data, shape, uri) });
    } catch (error) {
      errors.push({ shape, error });
    }
  }
  return { results, errors };
}
