import { QueryEngine } from "@comunica/query-sparql-rdfjs-lite";
import { Readable } from "node:stream";
import rdf from "rdf-ext";
import { insertContentInDataset } from "../util/dataset";
import { listFiles } from "../util/config";
import { generateTargetQuery } from "./sparql-generation";

const VALIDATION_SHAPES_FOLDER = "config/validation-shapes/";

export const VALIDATION_SHAPES = rdf.dataset();

export async function loadValidationShapes() {
  const shapeFiles = await listFiles(VALIDATION_SHAPES_FOLDER);
  await Promise.all(
    shapeFiles.map((filepath) =>
      insertContentInDataset("../" + filepath, VALIDATION_SHAPES),
    ),
  );
}

// A shape with the blank nodes and the named shapes it refers to, e.g. its
// sh:property shapes, which node shapes can share.
export function shapeWithReferencedShapes(shape) {
  const result = rdf.dataset();
  const visited = rdf.termSet();
  const toVisit = [shape];
  while (toVisit.length) {
    const term = toVisit.pop();
    if (visited.has(term)) continue;
    visited.add(term);
    for (const quad of VALIDATION_SHAPES.match(term)) {
      result.add(quad);
      if (quad.object.termType !== "Literal") {
        toVisit.push(quad.object);
      }
    }
  }
  return result;
}

/*
 * The shapes whose targets select a focus node in the resource. A shape with a
 * sh:targetNode is always selected: like the validator, its target doesn't
 * depend on the data.
 */
export async function targetedShapesForResource(resource) {
  const targetQuery = generateTargetQuery(VALIDATION_SHAPES);
  if (!targetQuery) return [];
  const bindings = await (
    await new QueryEngine().queryBindings(targetQuery.query, {
      sources: [{ match: (...args) => Readable.from(resource.match(...args)) }],
    })
  ).toArray();
  return bindings.map(
    (binding) => targetQuery.shapes[Number(binding.get("shape").value)],
  );
}
