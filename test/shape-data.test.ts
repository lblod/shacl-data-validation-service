import { QueryEngine } from "@comunica/query-sparql-rdfjs-lite";
import { Readable } from "node:stream";
import rdf from "rdf-ext";
import { beforeAll, describe, expect, test } from "vitest";
import { validateFocusNode } from "../lib/engine";
import {
  generateConstructQuery,
  generateTargetQuery,
} from "../lib/sparql-generation";
import { readFile } from "../util/config";
import { insertContentInDataset } from "../util/dataset";

const FIXTURES = "test/fixtures/shape-data/";
const EX = "http://example.org/";
const TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

const ex = (name: string) => EX + name;

const loadFixture = async (name: string, dataset) =>
  insertContentInDataset(await readFile(FIXTURES + name), dataset);

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

  // The triples retrieved for a shape, with their terms shortened
  async function retrievedTriples(shape: string, focusNode?: string) {
    const query = generateConstructQuery(shapes, {
      shapes: [ex(shape)],
      ...(focusNode && { focusNodes: [ex(focusNode)] }),
    });
    const retrieved = await retrieve(query);
    return [...retrieved]
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
  ])("retrieves $name", async ({ shape, expected }) => {
    expect(await retrievedTriples(shape)).toEqual(expected);
  });

  test("doesn't follow a deactivated shape", async () => {
    expect(await retrievedTriples("DeactivatedNestedShape")).toEqual([
      "start next second",
    ]);
  });

  test.each([
    {
      name: "sh:targetClass",
      shape: "ClassTargetShape",
      focusNode: "typed",
      expected: ["typed a Typed"],
    },
    {
      name: "sh:targetSubjectsOf",
      shape: "SubjectsOfTargetShape",
      focusNode: "subject",
      expected: ["subject marker a marker"],
    },
    {
      name: "a SPARQL-based target",
      shape: "SparqlTargetShape",
      focusNode: "session",
      expected: ["session heldBy council"],
    },
  ])(
    "retrieves the triples $name selects on",
    async ({ shape, focusNode, expected }) => {
      expect(await retrievedTriples(shape, focusNode)).toEqual(expected);
    },
  );

  test("only retrieves data of the focus nodes", async () => {
    expect(await retrievedTriples("ClassTargetShape", "other")).toEqual([]);
  });

  test("retrieves every step of a class chain, and no other steps", async () => {
    expect(await retrievedTriples("TopClassShape", "report")).toEqual([
      "Document subClassOf Publication",
      "Publication subClassOf Top",
      "Report subClassOf Document",
      "report a Report",
    ]);
  });

  test("selects a shape on a superclass in the retrieved data", async () => {
    const focusNodes = [ex("report")];
    const options = { shapes: [ex("TopClassShape")], focusNodes };
    const retrieved = await retrieve(generateConstructQuery(shapes, options));

    const targetQuery = generateTargetQuery(shapes, options);
    const bindings = await (
      await engine.queryBindings(targetQuery.query, {
        sources: [source(retrieved)],
      })
    ).toArray();
    expect(bindings).toHaveLength(1);
  });

  test("generates no query without data to retrieve", () => {
    expect(
      generateConstructQuery(rdf.dataset(), { focusNodes: [ex("start")] }),
    ).toBeUndefined();
  });

  test("gives the same validation result as the full data", async () => {
    const validationShapes = rdf.dataset();
    await loadFixture("validation-shapes.ttl", validationShapes);
    const focusNodes = [ex("validPerson"), ex("invalidPerson")];

    const results = async (dataset) => {
      const reports = await Promise.all(
        focusNodes.map((focusNode) =>
          validateFocusNode(
            dataset,
            validationShapes,
            rdf.namedNode(ex("PersonShape")),
            rdf.namedNode(focusNode),
          ),
        ),
      );
      return {
        conforms: reports.every((report) => report.conforms),
        results: reports
          .flatMap((report) => report.results)
          .map((result) =>
            [
              result.focusNode.value,
              result.path?.map((step) => step.predicates[0].value).join("/"),
              result.constraintComponent.value,
            ].join(" "),
          )
          .sort(),
      };
    };

    const retrieved = await retrieve(
      generateConstructQuery(validationShapes, {
        shapes: [ex("PersonShape")],
        focusNodes,
      }),
    );
    const expected = await results(data);

    expect(expected.conforms).toBe(false);
    expect(expected.results.length).toBeGreaterThan(0);
    expect(await results(retrieved)).toEqual(expected);
    expect(retrieved.match(null, rdf.namedNode(ex("notRetrieved"))).size).toBe(
      0,
    );
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
});
