import { querySudo as query } from "@lblod/mu-auth-sudo";
import rdf from "rdf-ext";
import { getObjects, insertContentInDataset } from "../util/rdf-ext-helpers";
import { listFiles, readFile } from "../util/config";
import { generateTargetQuery } from "./sparql-generation";
import { PREFIXES } from "../constants";

const VALIDATION_SHAPES_FOLDER = "config/validation-shapes/";

const SHAPE_REFERENCES = ["node", "property", "qualifiedValueShape", "not"];
const SHAPE_LIST_REFERENCES = ["and", "or", "xone"];

export const VALIDATION_SHAPES = rdf.dataset();

export async function loadValidationShapes() {
  const shapeFiles = await listFiles(VALIDATION_SHAPES_FOLDER);
  for (const filePath of shapeFiles) {
    const fileContents = await readFile(filePath);
    await insertContentInDataset(fileContents, VALIDATION_SHAPES);
  }
  checkReferencedShapes();
}

// The members of an RDF list
function getListMembers(list) {
  const members = [];
  const visited = rdf.termSet();
  const toVisit = [list];
  while (toVisit.length) {
    const listNode = toVisit.pop();
    if (visited.has(listNode)) continue;
    visited.add(listNode);
    const first = getObjects(
      VALIDATION_SHAPES,
      listNode,
      PREFIXES.rdf + "first",
    );
    const rest = getObjects(VALIDATION_SHAPES, listNode, PREFIXES.rdf + "rest");
    members.push(...first);
    toVisit.push(...rest);
  }
  return members;
}

// The validator treats a reference to a shape that isn't loaded as a shape
// without constraints, so its checks would silently never run.
function checkReferencedShapes() {
  const references = [];
  for (const name of SHAPE_REFERENCES) {
    const quads = VALIDATION_SHAPES.match(
      null,
      rdf.namedNode(PREFIXES.sh + name),
    );
    for (const quad of quads) {
      references.push({ from: quad.subject, shape: quad.object });
    }
  }
  for (const name of SHAPE_LIST_REFERENCES) {
    const quads = VALIDATION_SHAPES.match(
      null,
      rdf.namedNode(PREFIXES.sh + name),
    );
    for (const quad of quads) {
      for (const shape of getListMembers(quad.object)) {
        references.push({ from: quad.subject, shape });
      }
    }
  }

  const missing = references.filter(
    ({ shape }) => !VALIDATION_SHAPES.match(shape).size,
  );
  if (missing.length) {
    const details = missing
      .map(({ from, shape }) => `${shape.value} (from ${from.value})`)
      .join(", ");
    throw new Error(`Validation shapes refer to missing shapes: ${details}`);
  }
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

// The shapes whose targets select the resource in the store
export async function targetedShapesForResource(uri: string) {
  const targetQuery = generateTargetQuery(VALIDATION_SHAPES, {
    focusNodes: [uri],
  });
  if (!targetQuery) return [];
  const result = await query(targetQuery.query);
  return (result?.results?.bindings ?? []).map(
    (binding) => targetQuery.shapes[Number(binding.shape.value)],
  );
}
