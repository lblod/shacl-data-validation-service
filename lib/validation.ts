import rdf from "rdf-ext";
import { validateResourceWithSparqlTargets } from "./engine";
import {
  shapeWithReferencedShapes,
  targetedShapesForResource,
} from "./validation-shapes";

// The validation shapes whose targets select the resource, with their URIs
export async function validationShapesForResource(uri: string) {
  const targetedShapes = await targetedShapesForResource(uri);

  const shapes = rdf.dataset();
  for (const shape of targetedShapes) {
    shapes.addAll(shapeWithReferencedShapes(shape));
  }

  return { uris: targetedShapes.map((shape) => shape.value), shapes };
}

/*
 * Validates a resource against its validation shapes. Returns the URIs of the
 * validation shapes and the SHACL validation report, without a report if no
 * validation shape applies to the resource.
 */
export async function validate(resource, uri: string) {
  const { uris, shapes } = await validationShapesForResource(uri);
  if (!uris.length) {
    return { shapeUris: uris };
  }
  const report = await validateResourceWithSparqlTargets(resource, shapes);
  return { shapeUris: uris, report };
}
