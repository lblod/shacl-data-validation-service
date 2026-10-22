import rdfDataModel from "@rdfjs/data-model";
import Validator from "shacl-engine/Validator.js";

export async function validateResource(resource, shapes) {
  const validator = new Validator(shapes, { factory: rdfDataModel });
  const report = await validator.validate({ dataset: resource });

  return report;
}

export async function isConformResource(resource, shapes) {
  const report = await validateResource(resource, shapes);

  return report.conforms;
}
