import fromFile from "rdf-utils-fs/fromFile.js";

export async function insertContentInDataset(filename, dataset) {
  // TODO: use @rdfjs/io instead
  const filenameUrl = new URL(filename, import.meta.url);
  for await (const quad of fromFile(filenameUrl.pathname)) {
    dataset.add(quad);
  }
  return dataset;
}
