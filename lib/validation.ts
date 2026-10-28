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
 * Validates a resource against its validation shapes. Returns the URIs of the
 * validation shapes and the SHACL validation report, without a report if no
 * validation shape applies to the resource.
 */
export async function validate(resource) {
  const { uris, shapes } = await validationShapesForResource(resource);
  if (!uris.length) {
    return { shapeUris: uris };
  }
  const report = await validateResourceWithSparqlTargets(resource, shapes);
  return { shapeUris: uris, report };
}
