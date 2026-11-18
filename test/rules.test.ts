import rdf from "rdf-ext";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { VALIDATION_SHAPE_PREDICATE } from "../constants";
import {
  checkRules,
  listRules,
  matchingFocusNodes,
  RULES,
  rulesForResource,
  validationShapesOfRules,
} from "../lib/rules";
import { validateResource } from "../lib/validation";
import { VALIDATION_SHAPES } from "../lib/validation-shapes";
import { readFile } from "../util/config";
import { insertContentInDataset } from "../util/rdf-ext-helpers";
import { ex } from "./helpers";
import { store } from "./store";

vi.mock("@lblod/mu-auth-sudo", async () => ({
  querySudo: vi.fn((await import("./store")).runOnStore),
}));

const FIXTURES = "test/fixtures/rules/";

const loadFixture = async (name: string, dataset) =>
  insertContentInDataset(await readFile(FIXTURES + name), dataset);

const values = (terms) => terms.map((term) => term.value).sort();

beforeAll(async () => {
  await loadFixture("validation-shapes.ttl", VALIDATION_SHAPES);
  await loadFixture("rules.ttl", RULES);
  store.data = rdf.dataset();
  await loadFixture("data.ttl", store.data);
});

describe("rules for a resource", () => {
  test.each([
    {
      resource: "activeOrg",
      expected: ["ActiveRule", "LocalRule", "OpenRule", "SingleStatusRule"],
    },
    { resource: "inactiveOrg", expected: ["SingleStatusRule"] },
    { resource: "pendingOrg", expected: ["OpenRule", "SingleStatusRule"] },
    { resource: "twoStatusOrg", expected: ["ActiveRule"] },
  ])(
    "applies the rules $resource is selected by and conforms to",
    async ({ resource, expected }) => {
      expect(values(await rulesForResource(ex(resource)))).toEqual(
        expected.map(ex),
      );
    },
  );

  test("doesn't apply a rule to a resource its target doesn't select", async () => {
    // ex:thing conforms to ex:SingleStatusRule, which targets organizations
    expect(await rulesForResource(ex("thing"))).toEqual([]);
  });

  test("leaves out a deactivated rule", () => {
    expect(values(listRules())).not.toContain(ex("DeactivatedRule"));
  });

  test("links to each validation shape once", async () => {
    const rules = await rulesForResource(ex("activeOrg"));
    expect(values(validationShapesOfRules(rules))).toEqual(
      ["AltLabelShape", "LocalShape", "StatusShape"].map(ex),
    );
  });

  test("validates a resource against the shapes of its rules", async () => {
    const { results, errors } = await validateResource(ex("pendingOrg"));
    expect(
      results.map(({ shape, report }) => [shape.value, report.conforms]).sort(),
    ).toEqual([
      [ex("AltLabelShape"), false],
      [ex("StatusShape"), true],
    ]);
    expect(errors).toEqual([]);
  });
});

describe("matchingFocusNodes", () => {
  const rule = rdf.namedNode(ex("SingleStatusRule"));

  test("selects the resources a rule applies to", async () => {
    expect(await matchingFocusNodes(rule, { limit: 10 })).toEqual(
      ["activeOrg", "inactiveOrg", "pendingOrg"].map(ex),
    );
  });

  test("selects at most limit resources, offset selecting the next", async () => {
    expect(await matchingFocusNodes(rule, { limit: 2 })).toEqual(
      ["activeOrg", "inactiveOrg"].map(ex),
    );
    // ex:twoStatusOrg is selected, but doesn't conform
    expect(await matchingFocusNodes(rule, { limit: 2, offset: 2 })).toEqual([
      ex("pendingOrg"),
    ]);
  });
});

describe("checkRules", () => {
  const added = [];
  const add = (...quad) => {
    const [subject, predicate, object] = quad.map((value) =>
      rdf.namedNode(value),
    );
    const triple = rdf.quad(subject, predicate, object);
    RULES.add(triple);
    added.push(triple);
  };

  afterEach(() => {
    for (const triple of added.splice(0)) RULES.delete(triple);
    vi.restoreAllMocks();
  });

  test("accepts the rules", () => {
    expect(() => checkRules()).not.toThrow();
  });

  test("rejects a link to a validation shape that isn't loaded", () => {
    add(ex("ActiveRule"), VALIDATION_SHAPE_PREDICATE, ex("MissingShape"));
    expect(() => checkRules()).toThrow(/MissingShape/);
  });

  test("rejects a rule referring to a shape that isn't loaded", () => {
    add(ex("ActiveRule"), "http://www.w3.org/ns/shacl#node", ex("Missing"));
    expect(() => checkRules()).toThrow(/Rules refer to missing shapes/);
  });

  test("warns about a linked validation shape with a target", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    add(ex("ActiveRule"), VALIDATION_SHAPE_PREDICATE, ex("TargetedShape"));
    checkRules();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("TargetedShape"));
  });
});
