import rdf from "rdf-ext";
import { getResource, insertContentInDataset } from "../util/dataset";
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

export async function getValidationShape(uri) {
  return getResource(uri, VALIDATION_SHAPES);
}
