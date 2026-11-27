import rdf from "rdf-ext";
import Validator from "shacl-engine/Validator.js";

/*
 * shacl-engine skips the validation of an empty data graph, so a focus node
 * without any retrieved data would conform to every shape, e.g. one with a
 * sh:minCount. Validating an empty data graph with this triple instead keeps
 * the result: no path from a focus node reaches it.
 */
const NOT_EMPTY = rdf.quad(
  rdf.namedNode("urn:x-shacl-data-validation:data"),
  rdf.namedNode("urn:x-shacl-data-validation:isNotEmpty"),
  rdf.literal("true"),
);

/*
 * Validates a focus node against a shape. shapes also holds the shapes it refers
 * to. The validator doesn't resolve the target of the shape: the data can hold
 * other resources the target selects, without the data to validate those.
 * With debug, the report also has a result for each passed validation, with
 * severity shn:Debug (https://schemas.link/shacl-next#Debug), which doesn't
 * affect conforms. The report's dataset is built with the factory, which needs
 * dataset().
 */
export async function validateFocusNode(
  data,
  shapes,
  shape,
  focusNode,
  { debug = false } = {},
) {
  const validator = new Validator(shapes, { factory: rdf, debug });
  const dataset = data.size ? data : rdf.dataset([NOT_EMPTY]);
  return validator.validate({ dataset, terms: [focusNode] }, [
    { terms: [shape] },
  ]);
}
