import rdf from "rdf-ext";
import * as env from "../env";
import { validateFocusNode } from "./engine";
import { rulesForResource, validationShapesOfRules } from "./rules";
import {
  getValidationShapeData,
  shapeWithReferencedShapes,
} from "./validation-shapes";

// Validates a resource on its data against a validation shape, with the shapes
// it refers to. With REPORT_DEBUG_RESULTS, the report also has the passed
// validations.
export async function validateShape(data, shape, uri: string) {
  return validateFocusNode(
    data,
    shapeWithReferencedShapes(shape),
    shape,
    rdf.namedNode(uri),
    { debug: env.REPORT_DEBUG_RESULTS },
  );
}

/*
 * Validates a resource against each validation shape the rules that apply to
 * it link to, on the data of that shape. Returns the SHACL validation report of
 * each validated shape in results, and each shape whose validation failed with
 * its error in errors. No rule applies to a resource that doesn't exist, so
 * both are empty.
 */
export async function validateResource(uri: string) {
  const results = [];
  const errors = [];
  // In series: one query at a time on the store, and a failing shape doesn't
  // stop the others
  const shapes = validationShapesOfRules(await rulesForResource(uri));
  for (const shape of shapes) {
    try {
      const data = await getValidationShapeData(shape, uri);
      results.push({ shape, report: await validateShape(data, shape, uri) });
    } catch (error) {
      errors.push({ shape, error });
    }
  }
  return { results, errors };
}
