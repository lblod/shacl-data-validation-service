import rdf from "rdf-ext";
import { resource } from "rdf-utils-dataset";
import { insertContentInDataset } from "../util/dataset";

const RULES = rdf.dataset();

export async function loadRules() {
  insertContentInDataset("../config/rules.ttl", RULES);
}

// Get a set of terms that are the URIs rules that have resourceType as sh:targetClass
export function listRulesForType(resourceType: string) {
  const subjects = rdf.termSet();

  RULES.match(
    undefined,
    rdf.namedNode("http://www.w3.org/ns/shacl#targetClass"),
    rdf.namedNode(resourceType),
  ).forEach((quad) => subjects.add(quad.subject));

  return subjects;
}

  );
  // FIXME: Should use the Dataset(Ext) map instead, or define a traverser
  return Array.from(rulesForType).map((quad) => quad.subject.value);
}

export function getRuleResource(uri) {
  return resource(RULES, rdf.namedNode(uri));
}
