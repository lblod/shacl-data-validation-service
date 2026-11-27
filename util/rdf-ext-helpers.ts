import * as datasetIo from "@rdfjs/io/dataset.js";
import rdf from "rdf-ext";
import { BindingType } from "../constants";

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

// The objects of the triples in the dataset with the subject and predicate
export function getObjects(dataset, subject, predicate: string) {
  return [...dataset.match(subject, rdf.namedNode(predicate))].map(
    ({ object }) => object,
  );
}

// TODO: This should probably be(come) part of some factory to convert SPARQL
// query results JSON to rdf-ext objects
export function toRdfExtTerm(term) {
  switch (term.type) {
    case BindingType.Uri:
      return rdf.namedNode(term.value);
    case BindingType.Literal:
    case BindingType.TypedLiteral: {
      const datatype = term.datatype && rdf.namedNode(term.datatype);
      return rdf.literal(term.value, datatype || term["xml:lang"]);
    }
    case BindingType.BlankNode:
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
