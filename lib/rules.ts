import rdf from "rdf-ext";
import DatasetExt from "rdf-ext/lib/Dataset";
import { resource } from "rdf-utils-dataset";
import { insertContentInDataset, objectsForPredicate } from "../util/dataset";
import { isConformResource } from "./engine";

const RULES = rdf.dataset();

export async function loadRules() {
  insertContentInDataset("../config/rules.ttl", RULES);
}

export function getRuleResource(uri) {
  return resource(RULES, uri);
}

function rulesForResourceTypes(types) {
  const result = rdf.termSet();
  RULES.filter(
    (quad) =>
      quad.predicate.value === "http://www.w3.org/ns/shacl#targetClass" &&
      types.has(quad.object),
  ).forEach((quad) => result.add(quad.subject));
  return result;
}

export async function rulesForResource(resource: DatasetExt) {
  const resourceTypes = objectsForPredicate(
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    resource,
  );
  const rulesForTypes = rulesForResourceTypes(resourceTypes);

  const rules = rdf.dataset();

  for (const rule of rulesForTypes) {
    const ruleResource = getRuleResource(rule);

    // NOTE (22/10/2026): We need to check the input resource against each
    // individual rule.  Therefore, we need to create a new validator each time.
    const resourceConformsRule = await isConformResource(
      resource,
      ruleResource,
    );

    if (resourceConformsRule) {
      rules.addAll(ruleResource);
    }
  }

  return rules;
}
