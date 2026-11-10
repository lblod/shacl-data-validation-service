import rdf from "rdf-ext";
import { Changeset } from "../types";
import { toRdfExtTerm } from "./rdf-ext-helpers";

export function listUniqueSubjects(changesets: Changeset[]) {
  const subjects = rdf.termSet();
  changesets
    .flatMap((changeset) => changeset.inserts.concat(changeset.deletes))
    .forEach((quad) => subjects.add(toRdfExtTerm(quad.subject)));

  return subjects;
}
