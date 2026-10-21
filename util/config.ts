import { readdir } from "node:fs/promises";
import { VALIDATION_SHAPES } from "../app";
import { insertContentInDataset } from "./dataset";

const VALIDATION_SHAPES_FOLDER = "config/validation-shapes/";

async function listFiles(dir) {
  try {
    const files = await readdir(dir);
    return files;
  } catch (err) {
    console.error(`\n>> ERROR: failed to read files from ${dir}`);
    return [];
  }
}

async function listValidationShapeFiles() {
  try {
    const files = await listFiles(VALIDATION_SHAPES_FOLDER);
    return files.map((filename) => VALIDATION_SHAPES_FOLDER + filename);
  } catch (err) {
    console.error(
      `\n>> ERROR: Encountered and error when reading the validation shape files: ${err}`,
    );
    return [];
  }
}

export async function loadValidationShapes() {
  const shapeFiles = await listValidationShapeFiles();
  shapeFiles.forEach((filepath) =>
    insertContentInDataset("../" + filepath, VALIDATION_SHAPES),
  );
}
