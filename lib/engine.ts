import rdfDataModel from "@rdfjs/data-model";
import rdf from "rdf-ext";
import Validator from "shacl-engine/Validator.js";
import { targetResolvers } from "shacl-engine/sparql.js";

export async function validateResource(resource, shapes) {
  const validator = new Validator(shapes, { factory: rdfDataModel });
  const report = await validator.validate({ dataset: resource });

  return report;
}

// Also resolves SPARQL-based targets (sh:target [ a sh:SPARQLTarget ]), see
// targetedShapesForResource. With debug, the report also has a result for each
// passed validation, with severity shn:Debug
// (https://schemas.link/shacl-next#Debug), which doesn't affect conforms.
export async function validateResourceWithSparqlTargets(
  resource,
  shapes,
  { debug = false } = {},
) {
  const validator = new Validator(shapes, {
    factory: rdf,
    targetResolvers,
    debug,
  });
  const report = await validator.validate({ dataset: resource });

  return report;
}

export async function isConformResource(resource, shapes) {
  const report = await validateResource(resource, shapes);

  return report.conforms;
}
