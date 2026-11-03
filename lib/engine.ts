import rdf from "rdf-ext";
import Validator from "shacl-engine/Validator.js";
import { targetResolvers } from "shacl-engine/sparql.js";

// Also resolves SPARQL-based targets (sh:target [ a sh:SPARQLTarget ])
export async function validateResourceWithSparqlTargets(resource, shapes) {
  const validator = new Validator(shapes, { factory: rdf, targetResolvers });
  const report = await validator.validate({ dataset: resource });

  return report;
}
