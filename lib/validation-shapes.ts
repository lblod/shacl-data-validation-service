import rdf from "rdf-ext";
import { extractResource, insertContentInDataset } from "../util/dataset";
import { listFiles, readFile } from "../util/config";

const VALIDATION_SHAPES_FOLDER = "config/validation-shapes/";

export const VALIDATION_SHAPES = rdf.dataset();

export async function loadValidationShapes() {
  const shapeFiles = await listFiles(VALIDATION_SHAPES_FOLDER);
  for (const filePath of shapeFiles) {
    const fileContents = await readFile(filePath);
    await insertContentInDataset(fileContents, VALIDATION_SHAPES);
  }
}

export function shapeResources(shapeUris) {
  const shapes = rdf.dataset();
  for (const uri of shapeUris) {
    const shapeResource = extractResource(uri, VALIDATION_SHAPES);
    shapes.addAll(shapeResource);
  }
  return shapes;
}
