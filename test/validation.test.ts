import { QueryEngine } from "@comunica/query-sparql-rdfjs-lite";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import rdf from "rdf-ext";
import { beforeAll, describe, expect, test } from "vitest";
import { listDirectories } from "../util/config";
import { insertContentInDataset } from "../util/dataset";
import { loadRules } from "../lib/rules";
import { generateRuleQueries } from "../lib/sparql-generation";
import { validate, validationShapesForResource } from "../lib/validation";
import {
  loadValidationShapes,
  VALIDATION_SHAPES,
} from "../lib/validation-shapes";

const CASES_FOLDER = "test/cases/";
const SH = "http://www.w3.org/ns/shacl#";

/*
 * A test case is a folder in test/cases/ with
 * - data.ttl: the data of the resource, as returned by /test/data/:uri, or as
 *   in the store
 * - case.json: the resource, the URIs of the validation shapes the service
 *   should validate the resource against, and the expected validation result
 */
type TestCase = {
  description?: string;
  resource: string;
  shapes: string[];
  expected: {
    conforms: boolean;
    // The validation results, compared if given
    results?: { focusNode: string; sourceShape: string; severity: string }[];
  };
};

// The validation results of a SHACL validation report, sorted to compare them
function reportResults(report) {
  const dataset = report.dataset;
  const object = (subject, predicate) =>
    [...dataset.match(subject, rdf.namedNode(SH + predicate))][0]?.object
      .value;
  return [...dataset.match(null, rdf.namedNode(SH + "result"))]
    .map(({ object: result }) => ({
      focusNode: object(result, "focusNode"),
      sourceShape: object(result, "sourceShape"),
      severity: object(result, "resultSeverity"),
    }))
    .sort(compareResults);
}

function compareResults(a, b) {
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

/*
 * Adds the triples the SPARQL rules (sh:rule) of the shapes construct on the
 * data, like the service adds the triples they construct on the store (see
 * constructData in lib/resource-retrieval.ts). Data returned by
 * /test/data/:uri already contains them, the rules construct them again.
 */
async function applyRules(data, shapeUris: string[], resource: string) {
  const queries = generateRuleQueries(VALIDATION_SHAPES, {
    shapes: shapeUris,
    focusNodes: [resource],
  });
  const source = { match: (...args) => Readable.from(data.match(...args)) };
  const engine = new QueryEngine();
  // Like on the store, each rule runs on the data without the triples the
  // other rules construct
  const constructed = await Promise.all(
    queries.map(async (query) =>
      (await engine.queryQuads(query, { sources: [source] })).toArray(),
    ),
  );
  data.addAll(constructed.flat());
}

const cases = await listDirectories(CASES_FOLDER);

beforeAll(async () => {
  await loadRules();
  await loadValidationShapes();
});

describe.each(cases)("%s", (folder) => {
  let testCase: TestCase;
  let report;
  let shapeUris: string[];

  beforeAll(async () => {
    testCase = JSON.parse(await readFile(folder + "/case.json", "utf-8"));
    const data = await insertContentInDataset(
      "../" + folder + "/data.ttl",
      rdf.dataset(),
    );
    const { uris } = await validationShapesForResource(data);
    await applyRules(data, uris, testCase.resource);
    ({ shapeUris, report } = await validate(data));
  });

  test("validates the resource against the expected shapes", () => {
    expect([...shapeUris].sort()).toEqual([...testCase.shapes].sort());
  });

  test("has the expected validation result", () => {
    expect(report?.conforms).toBe(testCase.expected.conforms);
    if (testCase.expected.results) {
      expect(reportResults(report)).toEqual(
        [...testCase.expected.results].sort(compareResults),
      );
    }
  });
});
