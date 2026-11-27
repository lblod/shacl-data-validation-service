import type { DatasetCore } from "@rdfjs/types";
import rdf from "rdf-ext";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { VALIDATION_SHAPE_PREDICATE } from "../constants";
import {
  checkRules,
  initRules,
  matchingFocusNodes,
  rulesForResource,
  validationShapesOfRules,
} from "../lib/rules";
import { validateResource } from "../lib/validation";
import { initValidationShapes } from "../lib/validation-shapes";
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

const values = (terms) => [...terms].map((term) => term.value).sort();

let rules: DatasetCore;

beforeAll(async () => {
  // The rules link to the validation shapes, which are checked to be loaded
  await initValidationShapes(FIXTURES + "validation-shapes/");
  rules = await initRules(FIXTURES + "rules/");
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
    expect((await rulesForResource(ex("thing"))).size).toBe(0);
  });

  test("links to each validation shape once", async () => {
    const rules = await rulesForResource(ex("activeOrg"));
    expect(values(validationShapesOfRules(rules))).toEqual(
      ["AltLabelShape", "LocalShape", "StatusShape"].map(ex),
    );
  });

  test("validates a resource against the shapes of its rules", async () => {
    // ex:StatusShape conforms although its target doesn't select ex:pendingOrg
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

  test("selects at most limit resources", async () => {
    expect(await matchingFocusNodes(rule, { limit: 2 })).toEqual(
      ["activeOrg", "inactiveOrg"].map(ex),
    );
  });
});

describe("checkRules", () => {
  // Added to the loaded rules for one test, and removed after it
  const added = [];

  const add = (...quad) => {
    const [subject, predicate, object] = quad.map((value) =>
      rdf.namedNode(value),
    );
    const triple = rdf.quad(subject, predicate, object);
    rules.add(triple);
    added.push(triple);
  };

  afterEach(() => {
    for (const triple of added.splice(0)) rules.delete(triple);
    vi.restoreAllMocks();
  });

  test("accepts the rules", () => {
    expect(() => checkRules(rules)).not.toThrow();
  });

  test("rejects a link to a validation shape that isn't loaded", () => {
    add(ex("ActiveRule"), VALIDATION_SHAPE_PREDICATE, ex("MissingShape"));
    expect(() => checkRules(rules)).toThrow(/MissingShape/);
  });

  test("rejects a rule without a validation shape", () => {
    add(
      ex("UnlinkedRule"),
      "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
      "http://www.w3.org/ns/shacl#NodeShape",
    );
    expect(() => checkRules(rules)).toThrow(/UnlinkedRule/);
  });

  test("rejects a rule referring to a shape that isn't loaded", () => {
    add(ex("ActiveRule"), "http://www.w3.org/ns/shacl#node", ex("Missing"));
    expect(() => checkRules(rules)).toThrow(/Rules refer to missing shapes/);
  });
});
