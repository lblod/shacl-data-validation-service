import rdf from "rdf-ext";
import Validator from "shacl-engine/Validator.js";

export async function validateResource(resource, shapes) {
  // The report's dataset is built with the factory, which needs dataset()
  const validator = new Validator(shapes, { factory: rdf });
  const report = await validator.validate({ dataset: resource });

  return report;
}

export async function isConformResource(resource, shapes) {
  const report = await validateResource(resource, shapes);

  return report.conforms;
}
