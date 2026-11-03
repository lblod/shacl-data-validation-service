import rdf from "rdf-ext";
import DatasetExt from "rdf-ext/lib/Dataset";
import { listFiles, readFile } from "../util/config";
import {
  extractResource,
  insertContentInDataset,
  objectsForPredicate,
} from "../util/rdf-ext-helpers";
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
    const ruleResource = extractResource(rule, RULES);

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
