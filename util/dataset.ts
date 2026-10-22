import rdf from "rdf-ext";
import DatasetExt from "rdf-ext/lib/Dataset";
import { resource } from "rdf-utils-dataset";
import fromFile from "rdf-utils-fs/fromFile.js";

export async function insertContentInDataset(filename, dataset) {
  // TODO: use @rdfjs/io instead
  const filenameUrl = new URL(filename, import.meta.url);
  for await (const quad of fromFile(filenameUrl.pathname)) {
    dataset.add(quad);
  }
  return dataset;
}

export async function getResource(uri, dataset) {
  return resource(dataset, rdf.namedNode(uri));
}

// TODO: Can this be cleaner with a traverser?
export function objectsForPredicate(predicate: string, dataset: DatasetExt) {
  const objects = rdf.termSet();
  dataset
    .filter((quad) => quad.predicate.value === predicate)
    .forEach((quad) => objects.add(quad.object));

  return objects;
}
