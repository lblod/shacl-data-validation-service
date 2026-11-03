import rdf from "rdf-ext";
import { validateFocusNode } from "./engine";
import { getShapeData, resourceExists } from "./resource-retrieval";
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
 * data of that shape. Returns a SHACL validation report per shape, nothing if
 * the resource doesn't exist.
 */
export async function validateResource(uri: string) {
  if (!(await resourceExists(uri))) return undefined;

  const shapes = await targetedShapesForResource(uri);
  return Promise.all(
    shapes.map(async (shape) => ({
      shape,
      report: await validateShape(await getShapeData(shape, uri), shape, uri),
    })),
  );
}
