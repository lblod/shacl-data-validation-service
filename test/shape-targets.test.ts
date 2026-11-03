import { QueryEngine } from "@comunica/query-sparql-rdfjs-lite";
import { Readable } from "node:stream";
import rdf from "rdf-ext";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { generateTargetQuery } from "../lib/sparql-generation";
import { validateResource, validateShape } from "../lib/validation";
import {
  shapeWithReferencedShapes,
  targetedShapesForResource,
  VALIDATION_SHAPES,
} from "../lib/validation-shapes";
import { readFile } from "../util/config";
import { insertContentInDataset } from "../util/dataset";

// The store the service queries, as a dataset
const store = vi.hoisted(() => ({ data: undefined }));

vi.mock("@lblod/mu-auth-sudo", () => ({ querySudo: runOnStore }));

function termToBinding(term) {
  switch (term.termType) {
    case "NamedNode":
      return { type: "uri", value: term.value };
    case "BlankNode":
      return { type: "bnode", value: term.value };
    default:
      return {
        type: "literal",
        value: term.value,
        ...(term.language && { "xml:lang": term.language }),
        datatype: term.datatype.value,
      };
  }
}

// Answers a query as querySudo does: a CONSTRUCT as bindings of s, p and o
async function runOnStore(query: string) {
  const sources = [
    { match: (...args) => Readable.from(store.data.match(...args)) },
  ];
  const engine = new QueryEngine();
  if (query.trimStart().startsWith("CONSTRUCT")) {
    const quads = await (await engine.queryQuads(query, { sources })).toArray();
    return {
      results: {
        bindings: quads.map((quad) => ({
          s: termToBinding(quad.subject),
          p: termToBinding(quad.predicate),
          o: termToBinding(quad.object),
        })),
      },
    };
  }
  const bindings = await (
    await engine.queryBindings(query, { sources })
  ).toArray();
  return {
    results: {
      bindings: bindings.map((binding) =>
        Object.fromEntries(
          [...binding].map(([variable, term]) => [
            variable.value,
            termToBinding(term),
          ]),
        ),
      ),
    },
  };
}

const FIXTURES = "test/fixtures/shape-targets/";
const EX = "http://example.org/";

const ex = (name: string) => EX + name;

const loadFixture = async (name: string, dataset) =>
  insertContentInDataset(await readFile(FIXTURES + name), dataset);

describe("generateTargetQuery", () => {
  const shapes = rdf.dataset();
  const data = rdf.dataset();

  // The URIs of the shapes the generated query selects in the data
  async function selectedShapes(options) {
    const targetQuery = generateTargetQuery(shapes, options);
    const bindings = await (
      await new QueryEngine().queryBindings(targetQuery.query, {
        sources: [{ match: (...args) => Readable.from(data.match(...args)) }],
      })
    ).toArray();
    return bindings
      .map(
        (binding) =>
          targetQuery.shapes[Number(binding.get("shape").value)].value,
      )
      .sort();
  }

  beforeAll(async () => {
    await loadFixture("target-shapes.ttl", shapes);
    await loadFixture("data.ttl", data);
  });

  test.each([
    {
      name: "sh:targetClass, sh:targetSubjectsOf and sh:targetObjectsOf",
      resource: "document",
      expected: ["ClassShape", "ObjectsOfShape", "SubjectsOfShape"],
    },
    {
      name: "sh:targetClass of a superclass",
      resource: "report",
      expected: ["ClassShape"],
    },
    {
      name: "sh:targetNode and SPARQL-based targets",
      resource: "session",
      expected: ["DeclaredPrefixesShape", "NodeTargetShape", "SparqlShape"],
    },
    {
      name: "no shape for a resource no target selects",
      resource: "other",
      expected: [],
    },
  ])("selects $name", async ({ resource, expected }) => {
    expect(await selectedShapes({ focusNodes: [ex(resource)] })).toEqual(
      expected.map(ex),
    );
  });

  test("generates no query for only a deactivated shape", () => {
    expect(
      generateTargetQuery(shapes, {
        shapes: [ex("DeactivatedShape")],
        focusNodes: [ex("document")],
      }),
    ).toBeUndefined();
  });

  test("applies a shape without a target to the focus nodes", async () => {
    const untargeted = ex("UntargetedShape");
    expect(
      await selectedShapes({
        shapes: [untargeted],
        focusNodes: [ex("other")],
      }),
    ).toEqual([untargeted]);
  });

  test("generates no query without shapes", () => {
    expect(
      generateTargetQuery(rdf.dataset(), { focusNodes: [ex("document")] }),
    ).toBeUndefined();
  });
});

describe("validation shapes for a resource", () => {
  const data = rdf.dataset();
  const resource = (name: string) => data.match(rdf.namedNode(ex(name)));

  // The shapes targeting a resource, with a store holding its data
  function targetingShapes(name: string) {
    store.data = resource(name);
    return targetedShapesForResource(ex(name));
  }

  async function targetingShapeUris(name: string) {
    return (await targetingShapes(name)).map((shape) => shape.value);
  }

  beforeAll(async () => {
    await loadFixture("validation-shapes.ttl", VALIDATION_SHAPES);
    await loadFixture("data.ttl", data);
  });

  test("selects a shape on its sh:targetClass", async () => {
    expect(await targetingShapeUris("document")).toEqual([ex("DocumentShape")]);
  });

  test("selects a shape on its SPARQL-based target", async () => {
    expect(await targetingShapeUris("session")).toEqual([ex("SessionShape")]);
  });

  test("selects nothing for a resource no target selects", async () => {
    expect(await targetingShapeUris("other")).toEqual([]);
  });

  test("includes a property shape node shapes share", async () => {
    for (const name of ["document", "report"]) {
      const [shape] = await targetingShapes(name);
      expect(
        shapeWithReferencedShapes(shape).match(rdf.namedNode(ex("hasTitle")))
          .size,
      ).toBeGreaterThan(0);
    }
  });

  // The report of a resource against the shape targeting it
  async function reportOf(name: string) {
    const [shape] = await targetingShapes(name);
    return validateShape(resource(name), shape, ex(name));
  }

  test("validates against the shared property shape", async () => {
    expect((await reportOf("document")).conforms).toBe(true);
    expect(await targetingShapeUris("report")).toEqual([ex("ReportShape")]);
    expect((await reportOf("report")).conforms).toBe(false);
  });

  test("validates against a shape selected on its SPARQL-based target", async () => {
    expect((await reportOf("session")).conforms).toBe(true);
    expect(await targetingShapeUris("sessionWithoutDocument")).toEqual([
      ex("SessionShape"),
    ]);
    expect((await reportOf("sessionWithoutDocument")).conforms).toBe(false);
  });

  test("gives a report per shape targeting the resource", async () => {
    store.data = resource("audited");
    const results = await validateResource(ex("audited"));
    expect(
      results.map(({ shape, report }) => [shape.value, report.conforms]).sort(),
    ).toEqual([
      [ex("AuditedAuthorShape"), false],
      [ex("AuditedTitleShape"), true],
    ]);
  });

  test("gives no reports when no shape targets the resource", async () => {
    store.data = resource("other");
    expect(await validateResource(ex("other"))).toEqual([]);
  });

  test("gives nothing for a resource that doesn't exist", async () => {
    store.data = rdf.dataset();
    expect(await validateResource(ex("unknown"))).toBeUndefined();
  });
});
