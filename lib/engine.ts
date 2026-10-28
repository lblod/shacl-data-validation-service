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
// targetedShapesForResource
export async function validateResourceWithSparqlTargets(resource, shapes) {
  const validator = new Validator(shapes, { factory: rdf, targetResolvers });
  const report = await validator.validate({ dataset: resource });

  return report;
}

export async function isConformResource(resource, shapes) {
  const report = await validateResource(resource, shapes);

  return report.conforms;
}
