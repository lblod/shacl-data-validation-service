import Quad from "rdf-ext/lib/Quad";

export type Changeset = {
  inserts: Quad[];
  deletes: Quad[];
};
