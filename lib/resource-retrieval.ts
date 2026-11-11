import { querySudo as query } from "@lblod/mu-auth-sudo";
import { sparqlEscapeUri } from "mu";
import rdf from "rdf-ext";
import { toDataset } from "../util/rdf-ext-helpers";
import { generateConstructQuery } from "./sparql-generation";
import { VALIDATION_SHAPES } from "./validation-shapes";

export async function resourceExists(uri: string) {
  const typesData = await query(`SELECT DISTINCT ?type {
    ${sparqlEscapeUri(uri)} a ?type .
  }`);

  return typesData.results.bindings.length > 0;
}

// The data of a resource needed to validate it against a shape, retrieved with
// a query generated from that shape, see lib/sparql-generation.ts
export async function getShapeData(shape, uri: string) {
  const constructQuery = generateConstructQuery(VALIDATION_SHAPES, {
    shapes: [shape],
    focusNodes: [uri],
  });
  if (!constructQuery) return rdf.dataset();

  const result = await query(constructQuery);
  return toDataset(result?.results?.bindings ?? []);
}
