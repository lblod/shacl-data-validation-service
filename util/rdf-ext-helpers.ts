import * as datasetIo from "@rdfjs/io/dataset.js";
import rdf from "rdf-ext";
import DatasetExt from "rdf-ext/lib/Dataset";
import NamedNodeExt from "rdf-ext/lib/NamedNode";
import { resource } from "rdf-utils-dataset";

export async function insertContentInDataset(content, dataset) {
  // TODO: make text/turtle configurable?
  // Parsed with rdf-ext, like the validation report, so their blank nodes get
  // different labels from the same counter. With another factory, the blank
  // node of a property shape could have the label of a node of the report,
  // e.g. the report itself, and its sh:sourceShape would point at that node.
  const ds = await datasetIo.fromText("text/turtle", content, {
    factory: rdf,
  });
  dataset.addAll(ds);

  return dataset;
}

export function extractResource(
  uri: NamedNodeExt,
  dataset: DatasetExt,
): DatasetExt {
  return resource(dataset, uri);
}

// TODO: Can this be cleaner with a traverser?
export function objectsForPredicate(predicate: string, dataset: DatasetExt) {
  const objects = rdf.termSet();
  dataset
    .filter((quad) => quad.predicate.value === predicate)
    .forEach((quad) => objects.add(quad.object));

  return objects;
}

// TODO: This should probably be(come) part of some factory to convert SPARQL
// query results JSON to rdf-ext objects
export function toRdfExtTerm(term) {
  switch (term.type) {
    case "uri":
      return rdf.namedNode(term.value);
    case "literal":
    case "typed-literal": {
      const datatype = term.datatype && rdf.namedNode(term.datatype);
      return rdf.literal(term.value, datatype || term["xml:lang"]);
    }
    case "bnode":
      return rdf.blankNode(term.value);
    default:
      return term;
  }
}

export function toDataset(bindings) {
  return rdf.dataset(
    bindings.map((b) =>
      rdf.quad(
        toRdfExtTerm(b["s"]),
        toRdfExtTerm(b["p"]),
        toRdfExtTerm(b["o"]),
      ),
    ),
  );
}
