import rdf from "rdf-ext";
import { validateResourceWithSparqlTargets } from "./engine";
import {
  shapeWithReferencedShapes,
  targetedShapesForResource,
} from "./validation-shapes";

// The validation shapes whose targets select the resource, with their URIs, or
// undefined if no shape selects it
export async function validationShapesForResource(uri: string) {
  const targetedShapes = await targetedShapesForResource(uri);
  if (!targetedShapes.length) return undefined;

  const shapes = rdf.dataset();
  for (const shape of targetedShapes) {
    shapes.addAll(shapeWithReferencedShapes(shape));
  }

  return { uris: targetedShapes.map((shape) => shape.value), shapes };
}

/*
 * Validates a resource against its validation shapes. Returns the URIs of the
 * validation shapes and the SHACL validation report, or undefined if no
 * validation shape applies to the resource.
 */
export async function validate(resource, uri: string) {
  const shapesForResource = await validationShapesForResource(uri);
  if (!shapesForResource) return undefined;
  const { uris, shapes } = shapesForResource;
  const report = await validateResourceWithSparqlTargets(resource, shapes);
  return { shapeUris: uris, report };
}
