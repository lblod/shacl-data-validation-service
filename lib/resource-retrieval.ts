import { querySudo as query } from "@lblod/mu-auth-sudo";
import { sparqlEscapeUri } from "mu";
import rdf from "rdf-ext";
import {
  generateConstructQuery,
  generateTargetQuery,
} from "./sparql-generation";
import { VALIDATION_SHAPES } from "./validation-shapes";

// modified from lib-decision-validation
function toRdfExtTerm(triple) {
  switch (triple.type) {
    case "uri":
      return rdf.namedNode(triple.value);
    case "bnode":
      return rdf.blankNode(triple.value);
    case "literal":
    case "typed-literal":
      return rdf.literal(
        triple.value,
        triple["xml:lang"] ||
          (triple.datatype ? rdf.namedNode(triple.datatype) : undefined),
      );
    default:
      return triple;
  }
}

// modified from lib-decision-validation
function toDataset(bindings) {
  return rdf.dataset(
    bindings.map((b) =>
      rdf.quad(
        toRdfExtTerm(b["s"]),
        toRdfExtTerm(b["p"]),
        toRdfExtTerm(b["o"]),
      ),
    ),
  );
}

export async function getResource(uri) {
  const typesData = await query(`SELECT DISTINCT ?type {
    ${sparqlEscapeUri(uri)} a ?type .
  }`);

  if (typesData.results.bindings.length > 0) {
    return getShapesData(uri);
  }
}

// The shapes whose targets select the resource in the store
async function getTargetingShapes(uri: string) {
  const targetQuery = generateTargetQuery(VALIDATION_SHAPES, {
    focusNodes: [uri],
  });
  if (!targetQuery) return [];
  const result = await query(targetQuery.query);
  return (result?.results?.bindings ?? []).map(
    (binding) => targetQuery.shapes[Number(binding.shape.value)],
  );
}

// The data of a resource the shapes that apply to it need to validate it,
// retrieved with a query generated from those shapes, see
// lib/sparql-generation.ts
async function getShapesData(uri: string) {
  const shapes = await getTargetingShapes(uri);
  if (!shapes.length) return rdf.dataset();

  const constructQuery = generateConstructQuery(VALIDATION_SHAPES, {
    shapes,
    focusNodes: [uri],
  });
  if (!constructQuery) return rdf.dataset();

  const result = await query(constructQuery);
  return toDataset(result?.results?.bindings ?? []);
}
