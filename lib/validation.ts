import rdf from "rdf-ext";
import { validateFocusNode } from "./engine";
import { getShapeData } from "./resource-retrieval";
import {
  shapeWithReferencedShapes,
  targetedShapesForResource,
} from "./validation-shapes";

// Validates a resource on its data against a validation shape, with the shapes
// it refers to
export async function validateShape(data, shape, uri: string) {
  return validateFocusNode(
    data,
    shapeWithReferencedShapes(shape),
    shape,
    rdf.namedNode(uri),
  );
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
