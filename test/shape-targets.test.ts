import { QueryEngine } from "@comunica/query-sparql-rdfjs-lite";
import { Readable } from "node:stream";
import rdf from "rdf-ext";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { resourceExists } from "../lib/resource-retrieval";
import {
  matchingFocusNodes,
  rulesForResource,
  RULES,
  validationShapesOfRules,
} from "../lib/rules";
import { generateFocusNodeQuery } from "../lib/sparql-generation";
import { validateResource, validateShape } from "../lib/validation";
import {
  shapeWithReferencedShapes,
  VALIDATION_SHAPES,
} from "../lib/validation-shapes";
import { readFile } from "../util/config";
import { insertContentInDataset } from "../util/rdf-ext-helpers";
import { ex } from "./helpers";
import { store } from "./store";

vi.mock("@lblod/mu-auth-sudo", async () => ({
  querySudo: (await import("./store")).runOnStore,
}));

const FIXTURES = "test/fixtures/shape-targets/";

const loadFixture = async (name: string, dataset) =>
  insertContentInDataset(await readFile(FIXTURES + name), dataset);

const data = rdf.dataset();

// Loaded once: loading the rules again would add their blank nodes again
beforeAll(async () => {
  await loadFixture("validation-shapes.ttl", VALIDATION_SHAPES);
  await loadFixture("rules.ttl", RULES);
  await loadFixture("data.ttl", data);
});

describe("generateFocusNodeQuery", () => {
  // The focus nodes the query generated for a rule selects in the data, in
  // the order of the query
  async function selectedFocusNodes(rule: string, options = {}) {
    const query = generateFocusNodeQuery(RULES, ex(rule), {
      limit: 10,
      ...options,
    });
    const bindings = await (
      await new QueryEngine().queryBindings(query, {
        sources: [{ match: (...args) => Readable.from(data.match(...args)) }],
      })
    ).toArray();
    return bindings.map((binding) => binding.get("focusNode").value);
  }

  test.each([
    {
      name: "sh:targetClass, of a superclass as well",
      rule: "DocumentRule",
      expected: ["document", "report"],
    },
    {
      name: "sh:targetNode",
      rule: "NodeTargetRule",
      expected: ["session"],
    },
    {
      name: "sh:targetSubjectsOf",
      rule: "SubjectsOfRule",
      expected: ["session", "sessionWithoutDocument"],
    },
    {
      name: "sh:targetObjectsOf",
      rule: "ObjectsOfRule",
      expected: ["document"],
    },
    {
      name: "a SPARQL-based target",
      rule: "SessionRule",
      expected: ["session", "sessionWithoutDocument"],
    },
    {
      name: "a SPARQL-based target with declared prefixes",
      rule: "DeclaredPrefixesRule",
      expected: ["session", "sessionWithoutDocument"],
    },
    {
      name: "nothing for a target that selects nothing",
      rule: "OtherClassRule",
      expected: [],
    },
  ])("selects the focus nodes of $name", async ({ rule, expected }) => {
    expect(await selectedFocusNodes(rule)).toEqual(expected.map(ex));
  });

  test("restricts the focus nodes to the given ones", async () => {
    const options = { focusNodes: [ex("report"), ex("other")] };
    expect(await selectedFocusNodes("DocumentRule", options)).toEqual([
      ex("report"),
    ]);
  });

  test("selects at most limit focus nodes, offset selecting the next", async () => {
    const pages = [];
    for (const offset of [0, 1, 2]) {
      pages.push(
        await selectedFocusNodes("DocumentRule", { limit: 1, offset }),
      );
    }
    expect(pages).toEqual([[ex("document")], [ex("report")], []]);
  });

  test.each([undefined, 0, -1, 1.5])(
    "requires a positive limit, not %s",
    (limit) => {
      expect(() =>
        generateFocusNodeQuery(RULES, ex("DocumentRule"), { limit }),
      ).toThrow(/limit/);
    },
  );

  test("rejects a negative offset", () => {
    expect(() =>
      generateFocusNodeQuery(RULES, ex("DocumentRule"), {
        limit: 1,
        offset: -1,
      }),
    ).toThrow(/offset/);
  });

  test("generates no query for a deactivated rule", () => {
    expect(
      generateFocusNodeQuery(RULES, ex("DeactivatedRule"), {
        focusNodes: [ex("document")],
        limit: 1,
      }),
    ).toBeUndefined();
  });

  test("applies a rule without a target to the focus nodes", async () => {
    const options = { focusNodes: [ex("other")] };
    expect(await selectedFocusNodes("UntargetedRule", options)).toEqual([
      ex("other"),
    ]);
  });

  test("selects every resource for a rule without a target", async () => {
    expect(await selectedFocusNodes("UntargetedRule")).toEqual(
      [
        "audited",
        "document",
        "other",
        "report",
        "session",
        "sessionWithoutDocument",
      ].map(ex),
    );
  });

  test("applies a rule without a target to the resources that conform to it", async () => {
    store.data = data;
    const rule = rdf.namedNode(ex("UntargetedRule"));
    expect(await matchingFocusNodes(rule, { limit: 10 })).toEqual([
      ex("session"),
    ]);
  });
});

describe("validation shapes for a resource", () => {
  const resource = (name: string) => data.match(rdf.namedNode(ex(name)));

  // The validation shapes the rules that apply to a resource link to, with a
  // store holding its data
  async function shapesFor(name: string) {
    store.data = resource(name);
    return validationShapesOfRules(await rulesForResource(ex(name)));
  }

  async function shapeUrisFor(name: string) {
    return [...(await shapesFor(name))].map((shape) => shape.value).sort();
  }

  test("selects a shape through a rule's sh:targetClass", async () => {
    expect(await shapeUrisFor("document")).toEqual([ex("DocumentShape")]);
  });

  test("selects a shape through a rule's SPARQL-based target", async () => {
    expect(await shapeUrisFor("session")).toEqual([ex("SessionShape")]);
  });

  test("selects nothing for a resource no rule applies to", async () => {
    expect(await shapeUrisFor("other")).toEqual([]);
  });

  test("includes a property shape node shapes share", async () => {
    for (const name of ["document", "report"]) {
      const [shape] = await shapesFor(name);
      expect(
        shapeWithReferencedShapes(shape).match(rdf.namedNode(ex("hasTitle")))
          .size,
      ).toBeGreaterThan(0);
    }
  });

  // The report of a resource against the shape a rule selects for it
  async function reportOf(name: string) {
    const [shape] = await shapesFor(name);
    return validateShape(resource(name), shape, ex(name));
  }

  test("validates against the shared property shape", async () => {
    expect((await reportOf("document")).conforms).toBe(true);
    expect(await shapeUrisFor("report")).toEqual([ex("ReportShape")]);
    expect((await reportOf("report")).conforms).toBe(false);
  });

  test("validates against a shape selected through a SPARQL-based target", async () => {
    expect((await reportOf("session")).conforms).toBe(true);
    expect(await shapeUrisFor("sessionWithoutDocument")).toEqual([
      ex("SessionShape"),
    ]);
    expect((await reportOf("sessionWithoutDocument")).conforms).toBe(false);
  });

  test("gives a report per shape the rules link to", async () => {
    store.data = resource("audited");
    const { results, errors } = await validateResource(ex("audited"));
    expect(
      results.map(({ shape, report }) => [shape.value, report.conforms]).sort(),
    ).toEqual([
      [ex("AuditedAuthorShape"), false],
      [ex("AuditedTitleShape"), true],
    ]);
    expect(errors).toEqual([]);
  });

  test("gives no reports when no rule applies to the resource", async () => {
    store.data = resource("other");
    expect(await validateResource(ex("other"))).toEqual({
      results: [],
      errors: [],
    });
  });

  test("finds no resource that doesn't exist", async () => {
    store.data = rdf.dataset();
    expect(await resourceExists(ex("unknown"))).toBe(false);
  });
});
