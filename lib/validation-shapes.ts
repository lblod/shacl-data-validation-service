import rdf from "rdf-ext";
import { listFiles, readFile } from "../util/config";
import { insertContentInDataset } from "../util/rdf-ext-helpers";

const VALIDATION_SHAPES_FOLDER = "config/validation-shapes/";

export const VALIDATION_SHAPES = rdf.dataset();

// TODO: Ensure all referenced shapes are actually defined as well, throw error
// otherwise
export async function loadValidationShapes() {
  const shapeFiles = await listFiles(VALIDATION_SHAPES_FOLDER);
  for (const filePath of shapeFiles) {
    const fileContents = await readFile(filePath);
    await insertContentInDataset(fileContents, VALIDATION_SHAPES);
  }
}

export function shapeResources(shapeUris) {
  const shapes = rdf.dataset();
  shapeUris.forEach((uri) => shapeWithReferencedShapes(uri, shapes));

  return shapes;
}

// A shape with the blank nodes and the named shapes it refers to, e.g. its
// sh:property shapes, which node shapes can share.
function shapeWithReferencedShapes(startingShape, resultingShapes) {
  const visited = rdf.termSet();
  const toVisit = [startingShape];

  while (toVisit.length) {
    const term = toVisit.pop();

    if (!visited.has(term)) {
      visited.add(term);

      VALIDATION_SHAPES.match(term).forEach((quad) => {
        resultingShapes.add(quad);

        if (
          quad.object.termType === "NamedNode" ||
          quad.object.termType === "BlankNode"
        ) {
          toVisit.push(quad.object);
        }
      });
    }
  }
}
