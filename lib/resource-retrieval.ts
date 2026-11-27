import { querySudo as query } from "@lblod/mu-auth-sudo";
import { sparqlEscapeUri } from "mu";
import type { DatasetCore } from "@rdfjs/types";
import rdf from "rdf-ext";
import { toDataset } from "../util/rdf-ext-helpers";
import {
  generateConstructQuery,
  generateRuleQueries,
} from "./sparql-generation";

export async function resourceExists(uri: string) {
  const typesData = await query(`SELECT DISTINCT ?type {
    ${sparqlEscapeUri(uri)} a ?type .
  }`);

  return typesData.results.bindings.length > 0;
}

/*
 * The data of a resource needed to validate it against a shape, retrieved with
 * a query generated from that shape in the shapes, e.g. the validation shapes
 * or the rules, with the triples the SPARQL rules of the shape (sh:rule)
 * construct on the store, see lib/sparql-generation.ts. The data is always
 * retrieved for
 * a single resource. The query doesn't use the targets of the shape: the rules
 * decide which resources a validation shape validates, and the targets of a
 * rule already selected the resource.
 */
export async function getShapeData(shape, uri: string, shapes: DatasetCore) {
  if (!uri)
    throw new Error(`No resource to retrieve the data of ${shape.value}`);
  const options = { shapes: [shape], focusNodes: [uri] };
  const queries = [
    generateConstructQuery(shapes, options),
    ...generateRuleQueries(shapes, options),
  ].filter((generated): generated is string => Boolean(generated));

  const data = rdf.dataset();
  // In series, like the validation of the shapes
  for (const constructQuery of queries) {
    const result = await query(constructQuery);
    data.addAll(toDataset(result?.results?.bindings ?? []));
  }
  return data;
}
