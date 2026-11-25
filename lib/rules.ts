import { querySudo as query } from "@lblod/mu-auth-sudo";
import type { DatasetCore, Term } from "@rdfjs/types";
import rdf from "rdf-ext";
import { BindingType, VALIDATION_SHAPE_PREDICATE } from "../constants";
import * as env from "../env";
import { listFiles, readFile } from "../util/config";
import { getObjects, insertContentInDataset } from "../util/rdf-ext-helpers";
import { validateFocusNode } from "./engine";
import { getShapeData } from "./resource-retrieval";
import {
  type FocusNodeQueryOptions,
  generateFocusNodeQuery,
} from "./sparql-generation";
import {
  checkReferencedShapes,
  hasValidationShape,
  isActiveValidationShape,
  isDeactivated,
  shapeWithReferencedShapes,
} from "./validation-shapes";

/*
 * A rule is a SHACL node shape that decides which resources are validated
 * against the validation shapes it links to with ext:validationShape. Its
 * targets select the resources it may apply to; a rule without a target may
 * apply to every resource. Of those, it applies to the ones that conform to
 * the property shapes of the rule. The targets of the validation shapes don't
 * matter.
 */

const RULES_FOLDER = "config/rules/";

// Only used through the functions of this module
const RULES = rdf.dataset();

export async function loadRules(folder = RULES_FOLDER) {
  const ruleFiles = await listFiles(folder);
  for (const filePath of ruleFiles) {
    const fileContents = await readFile(filePath);
    await insertContentInDataset(fileContents, RULES);
  }
  checkRules(RULES);
}

/*
 * Every rule links to validation shapes that are loaded
 */
export function checkRules(rules: DatasetCore) {
  checkReferencedShapes(rules, "Rules");

  const missing = [];
  const links = rules.match(null, rdf.namedNode(VALIDATION_SHAPE_PREDICATE));
  for (const { subject: rule, object: shape } of links) {
    if (!hasValidationShape(shape)) {
      missing.push(`${shape.value} (from ${rule.value})`);
    }
  }
  if (missing.length) {
    throw new Error(
      `Rules refer to missing validation shapes: ${missing.join(", ")}`,
    );
  }
}

// The rules that aren't deactivated
export function listRules() {
  const rules = rdf.termSet();
  const links = RULES.match(null, rdf.namedNode(VALIDATION_SHAPE_PREDICATE));
  for (const { subject } of links) {
    if (!isDeactivated(RULES, subject)) rules.add(subject);
  }
  return rules;
}

// Whether a resource conforms to a rule, validated on the data of the rule for
// that resource only
async function conformsToRule(rule, uri: string) {
  const data = await getShapeData(rule, uri, RULES);
  const report = await validateFocusNode(
    data,
    shapeWithReferencedShapes(rule, RULES),
    rule,
    rdf.namedNode(uri),
  );
  return report.conforms;
}

export type MatchOptions = {
  // Restricts the resources to these, e.g. the resource being validated
  focusNodes?: string[];
  // The maximum number of resources the targets select, FOCUS_NODE_LIMIT by
  // default
  limit?: number;
  // The number of resources the targets select to skip, to get the next ones
  offset?: number;
};

// The SELECT query for the resources the targets of a rule select, see
// generateFocusNodeQuery
export const focusNodeQuery = (
  rule: string | Term,
  options: FocusNodeQueryOptions,
) => generateFocusNodeQuery(RULES, rule, options);

/*
 * The resources a rule applies to: of the resources its targets select, at
 * most limit of them, the ones that conform to the rule. The data of each
 * resource is retrieved and validated separately, so the data of one resource
 * can't make another conform. The limit and offset apply to the selected
 * resources, so a page can hold fewer matching resources than the limit.
 */
export async function matchingFocusNodes(rule, options: MatchOptions = {}) {
  const { limit = env.FOCUS_NODE_LIMIT, ...rest } = options;
  const selectQuery = focusNodeQuery(rule, { ...rest, limit });
  if (!selectQuery) return [];

  const result = await query(selectQuery);
  // A target can select literals, which aren't resources to validate
  const candidates = (result?.results?.bindings ?? [])
    .filter(({ focusNode }) => focusNode?.type === BindingType.Uri)
    .map(({ focusNode }) => focusNode.value);

  const matching = [];
  // In series: one query at a time on the store
  for (const candidate of candidates) {
    if (await conformsToRule(rule, candidate)) matching.push(candidate);
  }
  return matching;
}

// The rules that apply to a resource
export async function rulesForResource(uri: string) {
  const matching = rdf.termSet();
  for (const rule of listRules()) {
    const focusNodes = await matchingFocusNodes(rule, {
      focusNodes: [uri],
      limit: 1,
    });
    if (focusNodes.includes(uri)) matching.add(rule);
  }
  return matching;
}

// The validation shapes the rules link to that aren't deactivated
export function validationShapesOfRules(rules) {
  const shapes = rdf.termSet();
  for (const rule of rules) {
    const linked = getObjects(RULES, rule, VALIDATION_SHAPE_PREDICATE);
    for (const shape of linked) {
      if (isActiveValidationShape(shape)) shapes.add(shape);
    }
  }
  return shapes;
}
