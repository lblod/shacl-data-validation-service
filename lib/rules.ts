import { querySudo as query } from "@lblod/mu-auth-sudo";
import rdf from "rdf-ext";
import { PREFIXES } from "../constants";
import * as env from "../env";
import { listFiles, readFile } from "../util/config";
import { getObjects, insertContentInDataset } from "../util/rdf-ext-helpers";
import { validateFocusNode } from "./engine";
import { getShapeData } from "./resource-retrieval";
import { generateFocusNodeQuery, TARGET_PREDICATES } from "./sparql-generation";
import {
  checkReferencedShapes,
  shapeWithReferencedShapes,
  VALIDATION_SHAPES,
} from "./validation-shapes";

/*
 * A rule is a SHACL node shape that decides which resources are validated
 * against the validation shapes it links to with ext:validationShape. Its
 * targets select the resources it may apply to, and it applies to those that
 * conform to it, e.g. to its property shapes. The targets of the validation
 * shapes don't matter.
 */

const RULES_FOLDER = "config/rules/";
const VALIDATION_SHAPE = PREFIXES.ext + "validationShape";

export const RULES = rdf.dataset();

export async function loadRules() {
  const ruleFiles = await listFiles(RULES_FOLDER);
  for (const filePath of ruleFiles) {
    const fileContents = await readFile(filePath);
    await insertContentInDataset(fileContents, RULES);
  }
  checkRules();
}

const isDeactivated = (shapes, shape) =>
  getObjects(shapes, shape, PREFIXES.sh + "deactivated").some(
    (object) => object.value === "true",
  );

/*
 * Every rule links to validation shapes that are loaded, and refers to shapes
 * that are loaded. A linked validation shape with a target of its own gets a
 * warning: the target doesn't decide what the shape validates, but it
 * restricts the data retrieved for it to the resources it selects.
 */
export function checkRules() {
  checkReferencedShapes(RULES, "Rules");

  const missing = [];
  const links = RULES.match(null, rdf.namedNode(VALIDATION_SHAPE));
  for (const { subject: rule, object: shape } of links) {
    if (!VALIDATION_SHAPES.match(shape).size) {
      missing.push(`${shape.value} (from ${rule.value})`);
    } else if (
      TARGET_PREDICATES.some(
        (name) =>
          getObjects(VALIDATION_SHAPES, shape, PREFIXES.sh + name).length,
      )
    ) {
      console.warn(
        `\n>> WARNING: Validation shape ${shape.value} of rule ${rule.value} has a target, which restricts the data retrieved to validate a resource`,
      );
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
  const links = RULES.match(null, rdf.namedNode(VALIDATION_SHAPE));
  for (const { subject } of links) rules.add(subject);
  return [...rules].filter((rule) => !isDeactivated(RULES, rule));
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

/*
 * The resources a rule applies to: of the resources its targets select, at
 * most limit of them, the ones that conform to the rule. The data of each
 * resource is retrieved and validated separately, so the data of one resource
 * can't make another conform. The limit and offset apply to the selected
 * resources, so a page can hold fewer matching resources than the limit.
 */
export async function matchingFocusNodes(rule, options: MatchOptions = {}) {
  const { limit = env.FOCUS_NODE_LIMIT, ...rest } = options;
  const focusNodeQuery = generateFocusNodeQuery(RULES, rule, {
    ...rest,
    limit,
  });
  if (!focusNodeQuery) return [];

  const result = await query(focusNodeQuery);
  // A target can select literals, which aren't resources to validate
  const candidates = (result?.results?.bindings ?? [])
    .filter(({ focusNode }) => focusNode?.type === "uri")
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
  const matching = [];
  for (const rule of listRules()) {
    const focusNodes = await matchingFocusNodes(rule, {
      focusNodes: [uri],
      limit: 1,
    });
    if (focusNodes.includes(uri)) matching.push(rule);
  }
  return matching;
}

// The validation shapes the rules link to that aren't deactivated
export function validationShapesOfRules(rules) {
  const shapes = rdf.termSet();
  for (const rule of rules) {
    const linked = getObjects(RULES, rule, VALIDATION_SHAPE);
    for (const shape of linked) {
      if (!isDeactivated(VALIDATION_SHAPES, shape)) shapes.add(shape);
    }
  }
  return [...shapes];
}
