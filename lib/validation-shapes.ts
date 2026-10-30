import rdf from "rdf-ext";
import { select } from "shacl-engine/lib/sparql.js";
import { getResource, insertContentInDataset } from "../util/dataset";
import { listFiles } from "../util/config";

const VALIDATION_SHAPES_FOLDER = "config/validation-shapes/";
const SH = "http://www.w3.org/ns/shacl#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

export const VALIDATION_SHAPES = rdf.dataset();

export async function loadValidationShapes() {
  const shapeFiles = await listFiles(VALIDATION_SHAPES_FOLDER);
  await Promise.all(
    shapeFiles.map((filepath) =>
      insertContentInDataset("../" + filepath, VALIDATION_SHAPES),
    ),
  );
}

export async function getValidationShape(uri) {
  return getResource(uri, VALIDATION_SHAPES);
}

// Node shapes with a SPARQL-based target and the SELECT query of their target
function sparqlTargetedShapes() {
  const shapes = [];
  for (const quad of VALIDATION_SHAPES.match(null, rdf.namedNode(SH + "target"))) {
    const target = quad.object;
    const isSparqlTarget =
      VALIDATION_SHAPES.match(
        target,
        rdf.namedNode(RDF_TYPE),
        rdf.namedNode(SH + "SPARQLTarget"),
      ).size > 0;
    const [select] = VALIDATION_SHAPES.match(target, rdf.namedNode(SH + "select"));
    if (isSparqlTarget && select) {
      shapes.push({ shape: quad.subject, query: select.object.value });
    }
  }
  return shapes;
}

// A shape with the blank nodes and the named shapes it refers to, e.g. its
// sh:property shapes. Unlike getValidationShape, it doesn't include the other
// shapes sharing the same namespace (e.g. pp:A and pp:B in pp: <…#>).
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

// The shapes with a SPARQL-based target selecting focus nodes in the resource,
// with those focus nodes
export async function sparqlTargetFocusNodes(resource) {
  const result = [];
  for (const { shape, query } of sparqlTargetedShapes()) {
    const bindings = await select({
      dataset: resource,
      factory: rdf,
      query,
      bindings: [],
    });
    const focusNodes = bindings
      .map((binding) => binding.get(rdf.variable("this")))
      .filter(Boolean);
    if (focusNodes.length) {
      result.push({ shape, focusNodes });
    }
  }
  return result;
}

/*
 * Shapes with a SPARQL-based target select the resources they apply to
 * themselves, they don't need a rule. Returns the shapes whose target selects a
 * focus node in the resource.
 */
export async function targetedShapesForResource(resource) {
  const shapes = rdf.termSet();
  for (const { shape } of await sparqlTargetFocusNodes(resource)) {
    shapes.add(shape);
  }
  return shapes;
}
