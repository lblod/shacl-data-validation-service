import { QueryEngine } from "@comunica/query-sparql-rdfjs-lite";
import type { DatasetCore } from "@rdfjs/types";
import { Readable } from "node:stream";
import rdf from "rdf-ext";
import { beforeAll, describe, expect, test } from "vitest";
import { validateFocusNode } from "../lib/engine";
import { generateConstructQuery } from "../lib/sparql-generation";
import { readFile } from "../util/config";
import { insertContentInDataset } from "../util/rdf-ext-helpers";
import { EX, ex } from "./helpers";

const FIXTURES = "test/fixtures/shape-data/";
const TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

const loadFixture = async (name: string, dataset) =>
  insertContentInDataset(await readFile(FIXTURES + name), dataset);

// The triples of a dataset as sorted "subject predicate object" strings, with
// example.org IRIs, rdf:type and rdfs:subClassOf shortened
const shortTriples = (dataset: DatasetCore) =>
  [...dataset]
    .map((quad) =>
      [quad.subject, quad.predicate, quad.object]
        .map((term) =>
          term.value
            .replace(EX, "")
            .replace(TYPE, "a")
            .replace(SUB_CLASS_OF, "subClassOf"),
        )
        .join(" "),
    )
    .sort();

const engine = new QueryEngine();
const source = (dataset) => ({
  match: (...args) => Readable.from(dataset.match(...args)),
});

describe("generateConstructQuery", () => {
  const shapes = rdf.dataset();
  const data = rdf.dataset();

  async function retrieve(query: string, from = data) {
    const quads = await (
      await engine.queryQuads(query, { sources: [source(from)] })
    ).toArray();
    return rdf.dataset(quads);
  }

  // The triples retrieved for a shape and a focus node, with their terms
  // shortened
  async function retrievedTriples(shape: string, focusNode = "start") {
    const query = generateConstructQuery(shapes, {
      shapes: [ex(shape)],
      focusNodes: [ex(focusNode)],
    });
    return shortTriples(await retrieve(query));
  }

  beforeAll(async () => {
    await loadFixture("shapes.ttl", shapes);
    await loadFixture("data.ttl", data);
  });

  const NEXT_CHAIN = [
    "second next third",
    "start next second",
    "third next fourth",
  ];

  test.each([
    {
      name: "a predicate path",
      shape: "PredicateShape",
      expected: ["start label a label"],
    },
    {
      name: "an inverse path",
      shape: "InverseShape",
      expected: ["previous next start"],
    },
    {
      name: "a sequence path",
      shape: "SequenceShape",
      expected: ["second part partOfSecond", "start next second"],
    },
    {
      name: "an alternative path",
      shape: "AlternativeShape",
      expected: ["start label a label", "start title a title"],
    },
    {
      name: "a zero-or-more path",
      shape: "ZeroOrMoreShape",
      expected: NEXT_CHAIN,
    },
    {
      name: "a one-or-more path",
      shape: "OneOrMoreShape",
      expected: NEXT_CHAIN,
    },
    {
      name: "a zero-or-one path",
      shape: "ZeroOrOneShape",
      expected: ["start next second"],
    },
    {
      name: "a shape referred to with sh:node",
      shape: "NodeShape",
      expected: ["second part partOfSecond", "start next second"],
    },
    {
      name: "the shapes of sh:or",
      shape: "OrShape",
      expected: ["start label a label", "start title a title"],
    },
    {
      name: "the shapes of sh:and",
      shape: "AndShape",
      expected: ["start label a label", "start title a title"],
    },
    {
      name: "the shape of sh:not",
      shape: "NotShape",
      expected: ["start label a label"],
    },
    {
      name: "the types and superclasses for sh:class",
      shape: "ClassShape",
      expected: [
        "Employee subClassOf Person",
        "owner1 a Employee",
        "start owner owner1",
      ],
    },
    {
      name: "all triples of a closed shape",
      shape: "ClosedShape",
      focusNode: "second",
      expected: [
        "second next third",
        "second notRetrieved not retrieved",
        "second part partOfSecond",
      ],
    },
    {
      name: "the values of a property pair constraint",
      shape: "PairShape",
      expected: ["start label a label", "start title a title"],
    },
  ])("retrieves $name", async ({ shape, focusNode, expected }) => {
    expect(await retrievedTriples(shape, focusNode)).toEqual(expected);
  });

  test("doesn't use the targets of a shape", async () => {
    const shape = "LabelledClassTargetShape";
    // Not the rdf:type the target selects ex:typed on
    expect(await retrievedTriples(shape, "typed")).toEqual([
      "typed label a typed label",
    ]);
    // ex:start isn't selected by the target
    expect(await retrievedTriples(shape, "start")).toEqual([
      "start label a label",
    ]);
  });

  test("requires focus nodes", () => {
    expect(() =>
      generateConstructQuery(shapes, {
        shapes: [ex("PredicateShape")],
        focusNodes: [],
      }),
    ).toThrow(/focus nodes/);
  });

  test("generates no query without data to retrieve", () => {
    expect(
      generateConstructQuery(rdf.dataset(), {
        shapes: [ex("PredicateShape")],
        focusNodes: [ex("start")],
      }),
    ).toBeUndefined();
  });

  test("gives the same validation result as the full data", async () => {
    const validationShapes = rdf.dataset();
    await loadFixture("validation-shapes.ttl", validationShapes);
    const shape = rdf.namedNode(ex("PersonShape"));
    const focusNodes = [ex("validPerson"), ex("invalidPerson")];

    // The violations of the focus nodes against the shape on a dataset, as
    // sorted "focus node path constraint" strings
    const violations = async (dataset: DatasetCore) => {
      const reports = await Promise.all(
        focusNodes.map((focusNode) =>
          validateFocusNode(
            dataset,
            validationShapes,
            shape,
            rdf.namedNode(focusNode),
          ),
        ),
      );
      return reports
        .flatMap((report) => report.results)
        .map((result) =>
          [
            result.focusNode.value,
            result.path?.map((step) => step.predicates[0].value).join("/"),
            result.constraintComponent.value,
          ].join(" "),
        )
        .sort();
    };

    const retrieved = await retrieve(
      generateConstructQuery(validationShapes, {
        shapes: [shape],
        focusNodes,
      }),
    );
    const fullDataViolations = await violations(data);

    // ex:invalidPerson violates the shape, so there's something to compare
    expect(fullDataViolations.length).toBeGreaterThan(0);
    expect(await violations(retrieved)).toEqual(fullDataViolations);
  });

  test("doesn't validate other resources the target selects in the data", async () => {
    const validationShapes = rdf.dataset();
    await loadFixture("validation-shapes.ttl", validationShapes);
    const shape = rdf.namedNode(ex("OrganizationShape"));
    const focusNode = rdf.namedNode(ex("childOrganization"));

    const retrieved = await retrieve(
      generateConstructQuery(validationShapes, {
        shapes: [shape],
        focusNodes: [focusNode],
      }),
    );
    // The target selects the parent as well, but its name isn't retrieved
    expect(
      retrieved.match(rdf.namedNode(ex("parentOrganization")), null).size,
    ).toBeGreaterThan(0);
    expect(
      retrieved.match(
        rdf.namedNode(ex("parentOrganization")),
        rdf.namedNode(ex("name")),
      ).size,
    ).toBe(0);

    const report = await validateFocusNode(
      retrieved,
      validationShapes,
      shape,
      focusNode,
    );
    expect(report.conforms).toBe(true);
  });

  test("validates a focus node without any retrieved data", async () => {
    const validationShapes = rdf.dataset();
    await loadFixture("validation-shapes.ttl", validationShapes);
    // ex:CompanyShape requires a name
    const report = await validateFocusNode(
      rdf.dataset(),
      validationShapes,
      rdf.namedNode(ex("CompanyShape")),
      rdf.namedNode(ex("unknown")),
    );
    expect(report.conforms).toBe(false);
  });
});
