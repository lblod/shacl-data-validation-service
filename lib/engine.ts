import rdf from "rdf-ext";
import Validator from "shacl-engine/Validator.js";

// With debug, the report also has a result for each passed validation, with
// severity shn:Debug (https://schemas.link/shacl-next#Debug), which doesn't
// affect conforms. The report's dataset is built with the factory, which
// needs dataset().
export async function validateResource(
  resource,
  shapes,
  { debug = false } = {},
) {
  const validator = new Validator(shapes, { factory: rdf, debug });
  const report = await validator.validate({ dataset: resource });

  return report;
}

export async function isConformResource(resource, shapes) {
  const report = await validateResource(resource, shapes);

  return report.conforms;
}
