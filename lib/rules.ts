import { querySudo as query } from "@lblod/mu-auth-sudo";
import type { DatasetCore } from "@rdfjs/types";
import rdf from "rdf-ext";
import {
  BindingType,
  PREFIXES,
  VALIDATION_SHAPE_PREDICATE,
} from "../constants";
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
  listShapeReferences,
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

// Only used through the functions of this module, set by initRules
let RULES = rdf.dataset();

// The rules in the turtle files of the folder, checked
async function loadRules(folder: string) {
  const rules = rdf.dataset();
  const ruleFiles = await listFiles(folder);
  for (const filePath of ruleFiles) {
    const fileContents = await readFile(filePath);
    await insertContentInDataset(fileContents, rules);
  }
  checkRules(rules);
  return rules;
}

// Loads the rules the functions of this module use. Returns them, e.g. for
// tests that generate queries from them.
export async function initRules(folder = RULES_FOLDER) {
  RULES = await loadRules(folder);
  return RULES;
}

/*
 * Every rule links to at least one validation shape using VALIDATION_SHAPE_PREDICATE.
 * Each validation shape must be loaded in the local store.
 */
export function checkRules(rules: DatasetCore) {
  checkReferencedShapes(rules, "Rules");

  const referred = rdf.termSet(
    listShapeReferences(rules).map(({ shape }) => shape),
  );
  const withoutShape = [];
  const nodeShapes = rules.match(
    null,
    rdf.namedNode(PREFIXES.rdf + "type"),
    rdf.namedNode(PREFIXES.sh + "NodeShape"),
  );
  for (const { subject } of nodeShapes) {
    const links = rules.match(
      subject,
      rdf.namedNode(VALIDATION_SHAPE_PREDICATE),
    );
    if (!referred.has(subject) && !links.size) withoutShape.push(subject.value);
  }
  if (withoutShape.length) {
    throw new Error(
      `Rules without a validation shape: ${withoutShape.join(", ")}`,
    );
  }

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

export function listRules() {
  const rules = rdf.termSet();
  const links = RULES.match(null, rdf.namedNode(VALIDATION_SHAPE_PREDICATE));
  for (const { subject } of links) rules.add(subject);
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

/*
 * The resources a rule applies to: of the resources its targets select, at
 * most limit of them, the ones that conform to the rule. The data of each
 * resource is retrieved and validated separately, so the data of one resource
 * can't make another conform. The limit applies to the selected resources, so
 * fewer resources than the limit can match.
 */
export async function matchingFocusNodes(rule, options: FocusNodeQueryOptions) {
  const result = await query(generateFocusNodeQuery(RULES, rule, options));
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

// The validation shapes the rules link to
export function validationShapesOfRules(rules) {
  const shapes = rdf.termSet();
  for (const rule of rules) {
    const linked = getObjects(RULES, rule, VALIDATION_SHAPE_PREDICATE);
    for (const shape of linked) shapes.add(shape);
  }
  return shapes;
}
