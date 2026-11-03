import DataFactory from "@rdfjs/data-model/Factory.js";
import DatasetFactory from "@rdfjs/dataset/Factory.js";
import FormatsFactory from "@rdfjs/formats/Factory.js";
import formats from "@rdfjs/formats/pretty.js";
import * as datasetIo from "@rdfjs/io/dataset.js";
import { Environment } from "rdf-ext";

// TODO: Copied from rdfjs/io's test support,  it should be possible to simplify
// this.
const factory = new Environment([DataFactory, DatasetFactory, FormatsFactory]);

factory.formats.import(formats);

export async function insertContentInDataset(content, dataset) {
  // TODO: make text/turtle configurable?
  const ds = await datasetIo.fromText("text/turtle", content, { factory });
  dataset.addAll(ds);

  return dataset;
}
