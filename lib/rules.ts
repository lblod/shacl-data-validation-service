import rdf from "rdf-ext";
import DatasetExt from "rdf-ext/lib/Dataset";
import { resource } from "rdf-utils-dataset";
import { listFiles, readFile } from "../util/config";
import { insertContentInDataset, objectsForPredicate } from "../util/dataset";
import { isConformResource } from "./engine";

const RULES = rdf.dataset();

const PREDICATES = {
  TARGET_CLASS: "http://www.w3.org/ns/shacl#targetClass",
  TYPE: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
};

const RULES_FOLDER = "config/rules/";

export async function loadRules() {
  const ruleFiles = await listFiles(RULES_FOLDER);
  for (const filePath of ruleFiles) {
    const fileContents = await readFile(filePath);
    await insertContentInDataset(fileContents, RULES);
  }
}

export function getRuleResource(uri) {
  return resource(RULES, uri);
}

function rulesForResourceTypes(types) {
  const result = rdf.termSet();
  RULES.filter(
    (quad) =>
      quad.predicate.value === PREDICATES.TARGET_CLASS &&
      types.has(quad.object),
  ).forEach((quad) => result.add(quad.subject));
  return result;
}

export async function rulesForResource(resource: DatasetExt) {
  const resourceTypes = objectsForPredicate(PREDICATES.TYPE, resource);
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
