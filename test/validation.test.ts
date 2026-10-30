import { QueryEngine } from "@comunica/query-sparql-rdfjs-lite";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import rdf from "rdf-ext";
import { beforeAll, describe, expect, test } from "vitest";
import { listDirectories } from "../util/config";
import { insertContentInDataset } from "../util/dataset";
import {
  datasetSource,
  overview,
  overviewJsonApi,
  type Overview,
  type OverviewCheck,
  type OverviewRow,
} from "../lib/overview";
import {
  REPORT_CONTEXT,
  REPORT_CONTEXT_FILE,
  REPORT_CONTEXT_URL,
  reportJsonLd,
} from "../lib/report";
import { loadRules, RULES } from "../lib/rules";
import { generateRuleQueries } from "../lib/sparql-generation";
import { validate, validationShapesForResource } from "../lib/validation";
import {
  loadValidationShapes,
  sparqlTargetFocusNodes,
  VALIDATION_SHAPES,
} from "../lib/validation-shapes";

const CASES_FOLDER = "test/cases/";
const SH = "http://www.w3.org/ns/shacl#";
const VALIDATION_SHAPE = "http://mu.semte.ch/vocabularies/ext/validationShape";
const TARGETS = [
  "target",
  "targetClass",
  "targetNode",
  "targetSubjectsOf",
  "targetObjectsOf",
];

/*
 * A test case is a folder in test/cases/ with
 * - case.jsonld: a manifest of the SHACL test suite (mf:Manifest, see
 *   https://github.com/w3c/data-shapes/tree/gh-pages/data-shapes-test-suite),
 *   as JSON-LD, with the context of the report (REPORT_CONTEXT_URL), which
 *   has the terms of the test suite by their prefixed name. Its entries (mf:entries) are validation tests
 *   (sht:Validate), each with
 *   - a label (rdfs:label);
 *   - its action (mf:action): the file with the data of a resource
 *     data (sht:dataGraph) and the files that define the validation shapes
 *     the service should validate the resource against (sht:shapesGraph, see
 *     selectableShapes), relative to case.jsonld;
 *   - the expected validation report (mf:result, see reportJsonLd in
 *     lib/report.ts), compared completely if it has results, else only
 *     whether the resource conforms;
 *   - its status (mf:status), e.g. sht:approved.
 * - the data of the resources, e.g. data.ttl, as returned by
 *   /test/data/:uri, or as in the store
 * - optionally overview.json: the overview of the report as JSON:API, as
 *   /test/validate/:uri returns it with Accept: application/json (see
 *   overviewJsonApi in lib/overview.ts)
 */
type Manifest = {
  "@context": unknown;
  "@type": "mf:Manifest";
  "mf:entries": TestEntry[];
};

type TestEntry = {
  "@id": string;
  "@type": "sht:Validate";
  "rdfs:label"?: string;
  "mf:action": {
    "sht:dataGraph": string;
    "sht:shapesGraph": string | string[];
  };
  "mf:result": { conforms: boolean; result?: JsonLdResult[] };
  "mf:status"?: string;
};

/*
 * The shapes of a shapes graph the service selects for a resource on their
 * own: the shapes with a target, e.g. a SPARQL-based target, and the shapes a
 * rule links (ext:validationShape). Not the shapes they refer to, e.g. their
 * property shapes.
 */
function selectableShapes(shapesGraph) {
  const shapes = new Set<string>();
  for (const target of TARGETS) {
    for (const { subject } of shapesGraph.match(
      null,
      rdf.namedNode(SH + target),
    )) {
      shapes.add(subject.value);
    }
  }
  for (const { object } of RULES.match(null, rdf.namedNode(VALIDATION_SHAPE))) {
    if (shapesGraph.match(object).size) shapes.add(object.value);
  }
  return [...shapes].sort();
}

// A result of the JSON-LD report, see reportJsonLd
type JsonLdResult = {
  "@id": string;
  focusNode: string;
  value?: string | object;
  resultSeverity: string;
  resultMessage?: Record<string, string | string[]>;
  sourceShape: string | { "@id": string; name?: string };
};

// Loads the context of the report from its file instead of the service, so
// the tests don't need a running service
const documentLoader = {
  async load(url: string) {
    if (url !== REPORT_CONTEXT_URL) {
      throw new Error(`Unexpected remote context ${url}`);
    }
    return JSON.parse(await readFile(REPORT_CONTEXT_FILE, "utf-8"));
  },
};

// The triples of a JSON-LD document, with its relative IRIs resolved against
// the base IRI, if given
async function parseJsonLd(document: object, baseIRI?: string) {
  // FIXME: the rdf-ext types don't include io
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (rdf as any).io.dataset.fromText(
    "application/ld+json",
    JSON.stringify(document),
    { documentLoader, ...(baseIRI && { baseIRI }) },
  );
}

// A file of a test case, relative to its case.jsonld, relative to util/ as
// insertContentInDataset expects
function caseFile(folder: string, file: string) {
  return "../" + join(folder, file);
}

/*
 * The overview of the report (see lib/overview.ts) as a table, with the URIs
 * shortened to their last segment: a row per value, a column per check,
 * whether the value conforms (ok), doesn't (fail) or has no result (-), and the
 * messages of the checks it doesn't conform to below it
 */
function overviewTable({ checks, rows }: Overview) {
  const short = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);
  const cell = (row: OverviewRow, name: string): OverviewCheck | undefined =>
    row.checks[name];
  const mark = (check: OverviewCheck | undefined) =>
    !check ? "-" : check.conforms ? "ok" : "fail";
  const lines = [
    ["value", ...checks],
    ...rows.map((row) => [
      short(row.value ?? row.focusNode),
      ...checks.map((name) => mark(cell(row, name))),
    ]),
  ];
  const widths = lines[0].map((_, column) =>
    Math.max(...lines.map((line) => line[column].length)),
  );
  const format = (line: string[]) =>
    line
      .map((text, column) => text.padEnd(widths[column]))
      .join("  ")
      .trimEnd();
  return [
    format(lines[0]),
    ...rows.flatMap((row, index) => [
      format(lines[index + 1]),
      ...checks
        .filter((name) => cell(row, name)?.conforms === false)
        .map((name) => `    - ${name}: ${cell(row, name).resultMessage}`),
    ]),
  ].join("\n");
}

/*
 * Adds the triples the SPARQL rules (sh:rule) of the shapes construct on the
 * data, with $this bound to the focus nodes their SPARQL-based targets select
 * in the data, like the service adds the triples they construct on the store
 * for the resource (see constructData in lib/resource-retrieval.ts). Data
 * returned by /test/data/:uri already contains them, the rules construct them
 * again. Returns the focus nodes.
 */
async function applyRules(data, shapeUris: string[]) {
  const targeted = (await sparqlTargetFocusNodes(data)).filter(({ shape }) =>
    shapeUris.includes(shape.value),
  );
  const queries = targeted.flatMap(({ shape, focusNodes }) =>
    generateRuleQueries(VALIDATION_SHAPES, {
      shapes: [shape.value],
      focusNodes: focusNodes.map(({ value }) => value),
    }),
  );
  const source = datasetSource(data);
  const engine = new QueryEngine();
  // Like on the store, each rule runs on the data without the triples the
  // other rules construct
  const constructed = await Promise.all(
    queries.map(async (query) =>
      (await engine.queryQuads(query, { sources: [source] })).toArray(),
    ),
  );
  data.addAll(constructed.flat());
  return [
    ...new Set(
      targeted.flatMap(({ focusNodes }) =>
        focusNodes.map(({ value }) => value),
      ),
    ),
  ];
}

// The tests of the manifests of the test cases
const tests = [];
for (const folder of await listDirectories(CASES_FOLDER)) {
  const manifest: Manifest = JSON.parse(
    await readFile(folder + "/case.jsonld", "utf-8"),
  );
  for (const entry of manifest["mf:entries"]) {
    tests.push({ name: `${folder}: ${entry["@id"]}`, folder, manifest, entry });
  }
}

beforeAll(async () => {
  await loadRules();
  await loadValidationShapes();
});

describe.each(tests)("$name", ({ folder, manifest, entry }) => {
  const action = entry["mf:action"];
  let report;
  let shapeUris: string[];
  let focusNodes: string[];
  const shapesGraph = rdf.dataset();

  beforeAll(async () => {
    for (const file of [action["sht:shapesGraph"]].flat()) {
      await insertContentInDataset(caseFile(folder, file), shapesGraph);
    }
    const data = await insertContentInDataset(
      caseFile(folder, action["sht:dataGraph"]),
      rdf.dataset(),
    );
    const { uris } = await validationShapesForResource(data);
    focusNodes = await applyRules(data, uris);
    // Like /test/validate, the report also has the passed validations
    ({ shapeUris, report } = await validate(data, { debug: true }));
  });

  test("validates the resource against the shapes of its shapes graph", () => {
    const expected = selectableShapes(shapesGraph);
    expect(expected.length).toBeGreaterThan(0);
    expect([...shapeUris].sort()).toEqual(expected);
  });

  test("has the expected validation report", async () => {
    const { "@context": context, ...actual } = reportJsonLd(report);
    console.log(
      `${folder}: ${focusNodes.join(", ")}\n${overviewTable(await overview(report))}`,
    );
    const expected = entry["mf:result"];
    expect(manifest["@context"]).toEqual(context);
    expect(actual.conforms).toBe(expected.conforms);
    if (expected.result) {
      expect(actual).toEqual(expected);
    }
  });

  test("gives the overview as JSON:API", async () => {
    const document = overviewJsonApi(await overview(report), {
      resource: focusNodes[0],
      conforms: report.conforms,
      self: "/test/validate/" + encodeURIComponent(focusNodes[0]),
    });
    const expected = await readFile(folder + "/overview.json", "utf-8").catch(
      () => undefined,
    );
    if (expected !== undefined) {
      expect(document).toEqual(JSON.parse(expected));
    }
    const resources = [...document.data, ...document.included];
    const key = ({ type, id }) => `${type}/${id}`;
    // Each resource has a type and an id, unique together
    for (const resource of resources) {
      expect(resource.type).toMatch(/^[a-z][a-z-]*[a-z]$/);
      expect(resource.id).toMatch(/^[0-9a-f]+$/);
    }
    expect(new Set(resources.map(key)).size).toBe(resources.length);
    // Each relationship refers to an included resource, each included
    // resource is referred to (full linkage)
    const included = new Set(document.included.map(key));
    const referred = new Set(
      document.data.flatMap(({ relationships }) =>
        Object.values(relationships).flatMap(({ data }) => data.map(key)),
      ),
    );
    expect(referred).toEqual(included);
    // A field is an attribute or a relationship, not both
    for (const { attributes, relationships } of document.data) {
      const fields = [
        ...Object.keys(attributes),
        ...Object.keys(relationships),
      ];
      expect(new Set(fields).size).toBe(fields.length);
    }
  });

  test("gives the report as JSON-LD", async () => {
    const parsed = await parseJsonLd(reportJsonLd(report));
    expect(parsed.toCanonical()).toEqual(report.dataset.toCanonical());
  });

  test("is a JSON-LD test of the SHACL test suite", async () => {
    const file = (name: string) => pathToFileURL(resolve(folder, name)).href;
    const parsed = await parseJsonLd(manifest, file("case.jsonld"));
    const node = (term) => rdf.namedNode(expand(term));
    const objects = (subject, predicate) =>
      [...parsed.match(subject, node(predicate))].map(({ object }) => object);
    // The manifest lists the test, a validation test
    const [test] = objects(null, "rdf:first").filter((term) =>
      parsed.has(rdf.quad(term, node("rdf:type"), node("sht:Validate"))),
    );
    expect(test?.value).toBe(file(entry["@id"]));
    expect(
      parsed.match(rdf.namedNode(file("case.jsonld")), node("mf:entries")).size,
    ).toBe(1);
    // Its action has the data the test validates
    const [actionNode] = objects(test, "mf:action");
    expect(
      objects(actionNode, "sht:dataGraph").map(({ value }) => value),
    ).toEqual([file(action["sht:dataGraph"])]);
    // Its result is the expected validation report
    const [result] = objects(test, "mf:result");
    expect(
      parsed.has(
        rdf.quad(result, node("rdf:type"), node("sh:ValidationReport")),
      ),
    ).toBe(true);
  });
});

// An IRI by its prefixed name, with the prefixes of the context of the report
// and rdf
function expand(name: string) {
  const prefixes = {
    ...REPORT_CONTEXT,
    rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  };
  const [prefix, local] = name.split(":");
  return prefixes[prefix] + local;
}
