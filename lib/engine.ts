import rdf from "rdf-ext";
import Validator from "shacl-engine/Validator.js";

/*
 * Validates a focus node against a shape. shapes also holds the shapes it refers
 * to. The validator doesn't resolve the target of the shape: the data can hold
 * other resources the target selects, without the data to validate those.
 */
export async function validateFocusNode(data, shapes, shape, focusNode) {
  const validator = new Validator(shapes, { factory: rdf });
  return validator.validate({ dataset: data, terms: [focusNode] }, [
    { terms: [shape] },
  ]);
}
