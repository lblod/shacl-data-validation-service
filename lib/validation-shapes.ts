import type { DatasetCore, Term } from "@rdfjs/types";
import rdf from "rdf-ext";
import { getObjects, insertContentInDataset } from "../util/rdf-ext-helpers";
import { listFiles, readFile } from "../util/config";
import { PREFIXES, TermType } from "../constants";
import { getShapeData } from "./resource-retrieval";

const VALIDATION_SHAPES_FOLDER = "config/validation-shapes/";

const SHAPE_REFERENCES = ["node", "property", "qualifiedValueShape", "not"];
const SHAPE_LIST_REFERENCES = ["and", "or", "xone"];

// Only used through the functions of this module, set by initValidationShapes
let VALIDATION_SHAPES = rdf.dataset();

// The validation shapes in the turtle files of the folder, checked
async function loadValidationShapes(folder: string) {
  const shapes = rdf.dataset();
  const shapeFiles = await listFiles(folder);
  for (const filePath of shapeFiles) {
    const fileContents = await readFile(filePath);
    await insertContentInDataset(fileContents, shapes);
  }
  checkReferencedShapes(shapes, "Validation shapes");
  return shapes;
}

// Loads the validation shapes the functions of this module use. Returns them,
// e.g. for tests that generate queries from them.
export async function initValidationShapes(folder = VALIDATION_SHAPES_FOLDER) {
  VALIDATION_SHAPES = await loadValidationShapes(folder);
  return VALIDATION_SHAPES;
}

// Whether a validation shape is loaded
export const hasValidationShape = (shape: Term) =>
  VALIDATION_SHAPES.match(shape).size > 0;

// The data of a resource needed to validate it against a validation shape
export const getValidationShapeData = (shape: Term, uri: string) =>
  getShapeData(shape, uri, VALIDATION_SHAPES);

// The members of an RDF list in the shapes
function getListMembers(shapes, list) {
  const members = [];
  const visited = rdf.termSet();
  const toVisit = [list];
  while (toVisit.length) {
    const listNode = toVisit.pop();
    if (visited.has(listNode)) continue;
    visited.add(listNode);
    const first = getObjects(shapes, listNode, PREFIXES.rdf + "first");
    const rest = getObjects(shapes, listNode, PREFIXES.rdf + "rest");
    members.push(...first);
    toVisit.push(...rest);
  }
  return members;
}

// The shapes the shapes refer to, e.g. with sh:node, each with the shape that
// refers to it
export function listShapeReferences(shapes: DatasetCore) {
  const references = [];
  for (const name of SHAPE_REFERENCES) {
    const quads = shapes.match(null, rdf.namedNode(PREFIXES.sh + name));
    for (const quad of quads) {
      references.push({ from: quad.subject, shape: quad.object });
    }
  }
  for (const name of SHAPE_LIST_REFERENCES) {
    const quads = shapes.match(null, rdf.namedNode(PREFIXES.sh + name));
    for (const quad of quads) {
      const members = getListMembers(shapes, quad.object);
      for (const shape of members) {
        references.push({ from: quad.subject, shape });
      }
    }
  }

  return references;
}

// The validator treats a reference to a shape that isn't loaded as a shape
// without constraints, so its checks would silently never run. The description
// names the shapes in the error, e.g. "Rules".
export function checkReferencedShapes(shapes, description: string) {
  const references = listShapeReferences(shapes);
  const missing = references.filter(({ shape }) => !shapes.match(shape).size);
  if (missing.length) {
    const details = missing
      .map(({ from, shape }) => `${shape.value} (from ${from.value})`)
      .join(", ");
    throw new Error(`${description} refer to missing shapes: ${details}`);
  }
}

// A shape with the blank nodes and the named shapes it refers to, e.g. its
// sh:property shapes, which node shapes can share. The shapes are the
// validation shapes by default, or e.g. the rules.
export function shapeWithReferencedShapes(shape, shapes = VALIDATION_SHAPES) {
  const result = rdf.dataset();
  const visited = rdf.termSet();
  const toVisit = [shape];
  while (toVisit.length) {
    const term = toVisit.pop();
    if (visited.has(term)) continue;
    visited.add(term);
    for (const quad of shapes.match(term)) {
      result.add(quad);
      if (quad.object.termType !== TermType.Literal) {
        toVisit.push(quad.object);
      }
    }
  }
  return result;
}
