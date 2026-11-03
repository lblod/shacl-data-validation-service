import rdf from "rdf-ext";
import { Changeset } from "../types";

export function listUniqueSubjects(changesets: Changeset[]) {
  const subjects = rdf.termSet();
  changesets
    .flatMap((changeset) => changeset.inserts.concat(changeset.deletes))
    .forEach((quad) => subjects.add(rdf.namedNode(quad.subject.value)));

  return subjects;
}
