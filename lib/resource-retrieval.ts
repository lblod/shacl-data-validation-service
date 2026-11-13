import { querySudo as query } from "@lblod/mu-auth-sudo";
import { sparqlEscapeUri } from "mu";
import rdf from "rdf-ext";
import { toDataset } from "../util/rdf-ext-helpers";
import {
  generateConstructQuery,
  generateRuleQueries,
} from "./sparql-generation";
import { VALIDATION_SHAPES } from "./validation-shapes";

export async function resourceExists(uri: string) {
  const typesData = await query(`SELECT DISTINCT ?type {
    ${sparqlEscapeUri(uri)} a ?type .
  }`);

  return typesData.results.bindings.length > 0;
}

// The data of a resource needed to validate it against a shape, retrieved with
// a query generated from that shape, with the triples the SPARQL rules of the
// shape (sh:rule) construct on the store, see lib/sparql-generation.ts
export async function getShapeData(shape, uri: string) {
  const options = { shapes: [shape], focusNodes: [uri] };
  const queries = [
    generateConstructQuery(VALIDATION_SHAPES, options),
    ...generateRuleQueries(VALIDATION_SHAPES, options),
  ].filter(Boolean);

  const data = rdf.dataset();
  // In series, like the validation of the shapes
  for (const constructQuery of queries) {
    const result = await query(constructQuery);
    data.addAll(toDataset(result?.results?.bindings ?? []));
  }
  return data;
}
