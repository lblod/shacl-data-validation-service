import fromFile from "rdf-utils-fs/fromFile.js";
import { readdir } from "node:fs/promises";
import { VALIDATION_SHAPES, RULES } from "../app";

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

async function insertContentInDataset(filename, dataset) {
  // TODO: use @rdfjs/io instead
  const filenameUrl = new URL(filename, import.meta.url);
  for await (const quad of fromFile(filenameUrl.pathname)) {
    dataset.add(quad);
  }
  return dataset;
}

async function readValidationShapeFiles() {
  const shapeFiles = await listValidationShapeFiles();
  shapeFiles.forEach((filepath) =>
    insertContentInDataset("../" + filepath, VALIDATION_SHAPES),
  );
}

export async function readConfigFiles() {
  await readValidationShapeFiles();

  insertContentInDataset("../config/rules.ttl", RULES);
}
