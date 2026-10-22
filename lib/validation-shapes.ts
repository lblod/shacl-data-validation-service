import rdf from "rdf-ext";
import { getResource, insertContentInDataset } from "../util/dataset";
import { listFiles } from "../util/config";

const VALIDATION_SHAPES_FOLDER = "config/validation-shapes/";

export const VALIDATION_SHAPES = rdf.dataset();

export async function loadValidationShapes() {
  const shapeFiles = await listFiles(VALIDATION_SHAPES_FOLDER);
  shapeFiles.forEach((filepath) =>
    insertContentInDataset("../" + filepath, VALIDATION_SHAPES),
  );
}

export async function getValidationShape(uri) {
  return getResource(uri, VALIDATION_SHAPES);
}
