import { QueryEngine } from "@comunica/query-sparql-rdfjs-lite";
import { Readable } from "node:stream";
import rdf from "rdf-ext";
import { beforeAll, describe, expect, test } from "vitest";
import { generateTargetQuery } from "../lib/sparql-generation";
import { validate, validationShapesForResource } from "../lib/validation";
import { VALIDATION_SHAPES } from "../lib/validation-shapes";
import { insertContentInDataset } from "../util/dataset";

const FIXTURES = "../test/fixtures/shape-targets/";
const EX = "http://example.org/";

const ex = (name: string) => EX + name;

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
    await insertContentInDataset(FIXTURES + "target-shapes.ttl", shapes);
    await insertContentInDataset(FIXTURES + "data.ttl", data);
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

  beforeAll(async () => {
    await insertContentInDataset(
      FIXTURES + "validation-shapes.ttl",
      VALIDATION_SHAPES,
    );
    await insertContentInDataset(FIXTURES + "data.ttl", data);
  });

  test("selects a shape on its sh:targetClass", async () => {
    const { uris } = await validationShapesForResource(resource("document"));
    expect(uris).toEqual([ex("DocumentShape")]);
  });

  test("selects a shape on its SPARQL-based target", async () => {
    const { uris } = await validationShapesForResource(resource("session"));
    expect(uris).toEqual([ex("SessionShape")]);
  });

  test("selects nothing for a resource no target selects", async () => {
    const { uris } = await validationShapesForResource(resource("other"));
    expect(uris).toEqual([]);
  });

  test("includes a property shape node shapes share", async () => {
    for (const name of ["document", "report"]) {
      const { shapes } = await validationShapesForResource(resource(name));
      expect(shapes.match(rdf.namedNode(ex("hasTitle"))).size).toBeGreaterThan(
        0,
      );
    }
  });

  test("validates against the shared property shape", async () => {
    const passing = await validate(resource("document"));
    expect(passing.report.conforms).toBe(true);

    const failing = await validate(resource("report"));
    expect(failing.shapeUris).toEqual([ex("ReportShape")]);
    expect(failing.report.conforms).toBe(false);
  });

  test("validates against a shape selected on its SPARQL-based target", async () => {
    const passing = await validate(resource("session"));
    expect(passing.shapeUris).toEqual([ex("SessionShape")]);
    expect(passing.report.conforms).toBe(true);

    const failing = await validate(resource("sessionWithoutDocument"));
    expect(failing.shapeUris).toEqual([ex("SessionShape")]);
    expect(failing.report.conforms).toBe(false);
  });

  test("gives no report when no shape applies", async () => {
    const { shapeUris, report } = await validate(resource("other"));
    expect(shapeUris).toEqual([]);
    expect(report).toBeUndefined();
  });
});
