import rdfDataset from "@rdfjs/dataset";
import rdf from "rdf-ext";
import { resource } from "rdf-utils-dataset";
import { insertContentInDataset } from "../util/dataset";

const RULES = rdfDataset.dataset();

export async function loadRules() {
  insertContentInDataset("../config/rules.ttl", RULES);
}

export function listRuleForType(resourceType: string) {
  const rulesForType = RULES.match(
    undefined,
    rdf.namedNode("http://www.w3.org/ns/shacl#targetClass"),
    rdf.namedNode(resourceType),
  );
  // FIXME: Should use the Dataset(Ext) map instead, or define a traverser
  return Array.from(rulesForType).map((quad) => quad.subject.value);
}

export function getRuleResource(uri) {
  return resource(RULES, rdf.namedNode(uri));
}
