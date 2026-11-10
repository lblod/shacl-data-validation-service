import { QueryEngine } from "@comunica/query-sparql-rdfjs-lite";
import { Readable } from "node:stream";
import rdf from "rdf-ext";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { generateTargetQuery } from "../lib/sparql-generation";
import { validate, validationShapesForResource } from "../lib/validation";
import { VALIDATION_SHAPES } from "../lib/validation-shapes";
import { readFile } from "../util/config";
import { insertContentInDataset } from "../util/rdf-ext-helpers";

// The store the service queries, as a dataset
const store = vi.hoisted(() => ({ data: undefined }));

vi.mock("@lblod/mu-auth-sudo", () => ({ querySudo: selectOnStore }));

// Answers a SELECT query in the format of querySudo
async function selectOnStore(query: string) {
  const bindings = await (
    await new QueryEngine().queryBindings(query, {
      sources: [
        { match: (...args) => Readable.from(store.data.match(...args)) },
      ],
    })
  ).toArray();
  return {
    results: {
      bindings: bindings.map((binding) =>
        Object.fromEntries(
          [...binding].map(([variable, term]) => [
            variable.value,
            { value: term.value },
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

  // The store only holds the data of the resource at hand
  function shapesFor(name: string) {
    store.data = resource(name);
    return validationShapesForResource(ex(name));
  }

  function validateNamed(name: string) {
    store.data = resource(name);
    return validate(resource(name), ex(name));
  }

  beforeAll(async () => {
    await loadFixture("validation-shapes.ttl", VALIDATION_SHAPES);
    await loadFixture("data.ttl", data);
  });

  test("selects a shape on its sh:targetClass", async () => {
    const { uris } = await shapesFor("document");
    expect(uris).toEqual([ex("DocumentShape")]);
  });

  test("selects a shape on its SPARQL-based target", async () => {
    const { uris } = await shapesFor("session");
    expect(uris).toEqual([ex("SessionShape")]);
  });

  test("selects nothing for a resource no target selects", async () => {
    const { uris } = await shapesFor("other");
    expect(uris).toEqual([]);
  });

  test("includes a property shape node shapes share", async () => {
    for (const name of ["document", "report"]) {
      const { shapes } = await shapesFor(name);
      expect(shapes.match(rdf.namedNode(ex("hasTitle"))).size).toBeGreaterThan(
        0,
      );
    }
  });

  test("validates against the shared property shape", async () => {
    const passing = await validateNamed("document");
    expect(passing.report.conforms).toBe(true);

    const failing = await validateNamed("report");
    expect(failing.shapeUris).toEqual([ex("ReportShape")]);
    expect(failing.report.conforms).toBe(false);
  });

  test("validates against a shape selected on its SPARQL-based target", async () => {
    const passing = await validateNamed("session");
    expect(passing.shapeUris).toEqual([ex("SessionShape")]);
    expect(passing.report.conforms).toBe(true);

    const failing = await validateNamed("sessionWithoutDocument");
    expect(failing.shapeUris).toEqual([ex("SessionShape")]);
    expect(failing.report.conforms).toBe(false);
  });

  test("gives no report when no shape applies", async () => {
    const { shapeUris, report } = await validateNamed("other");
    expect(shapeUris).toEqual([]);
    expect(report).toBeUndefined();
  });
});
