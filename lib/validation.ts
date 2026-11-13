import rdf from "rdf-ext";
import { validateResourceWithSparqlTargets } from "./engine";
import {
  shapeWithReferencedShapes,
  targetedShapesForResource,
} from "./validation-shapes";

// The validation shapes whose targets select the resource, with the shapes they
// refer to, or undefined if no shape selects it
export async function validationShapesForResource(uri: string) {
  const targetedShapes = await targetedShapesForResource(uri);
  if (!targetedShapes.length) return undefined;

  const shapes = rdf.dataset();
  for (const shape of targetedShapes) {
    shapes.addAll(shapeWithReferencedShapes(shape));
  }

  return shapes;
}

/*
 * Validates a resource against its validation shapes. Returns the SHACL
 * validation report, or undefined if no validation shape applies to the
 * resource.
 */
export async function validate(resource, uri: string) {
  const shapes = await validationShapesForResource(uri);
  if (!shapes) return undefined;
  return validateResourceWithSparqlTargets(resource, shapes);
}
