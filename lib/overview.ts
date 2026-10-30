import { QueryEngine } from "@comunica/query-sparql-rdfjs-lite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

// The results of a validation report, see config/overview.rq
const OVERVIEW_QUERY = "config/overview.rq";
const SH = "http://www.w3.org/ns/shacl#";
const DEBUG = "https://schemas.link/shacl-next#Debug";
// The severities of failed validations, the most severe first
const SEVERITIES = [SH + "Violation", SH + "Warning", SH + "Info"];

// The media type of JSON:API, see https://jsonapi.org/format/
export const JSON_API = "application/vnd.api+json";

// A validation result of the report, with its URI, see identifyResults in
// lib/validation.ts
export type OverviewResult = {
  uri: string;
  focusNode: string;
  value?: string;
  sourceShape: string;
  name: string;
  severity: string;
  resultMessage?: string;
};

// A check of a row: whether its value conforms to it, the most severe
// severity of its results if it doesn't, the English messages of its failed
// results, or of all its results if it conforms, each message once, and the
// URIs of its results
export type OverviewCheck = {
  conforms: boolean;
  severity?: string;
  resultMessage?: string;
  validationResults: string[];
};

// A row of the overview: a value of the results with its focus node, e.g. a
// document of a session, or the focus node for results without value, and a
// check per name of the source shapes of its results (see sh:name), e.g.
// published
export type OverviewRow = {
  focusNode: string;
  value?: string;
  checks: Record<string, OverviewCheck>;
};

// The overview: the names of the checks, sorted, the rows and the results
export type Overview = {
  checks: string[];
  rows: OverviewRow[];
  results: OverviewResult[];
};

// A source for Comunica querying the dataset
export function datasetSource(dataset) {
  return { match: (...args) => Readable.from(dataset.match(...args)) };
}

/*
 * The validation report as a table: a row per focus node and value of its
 * results, with a check per name of their source shapes. Several results of
 * a row with the same name, e.g. of the shapes for whether a document is
 * published on time and whether that can be checked, make one check. The
 * results without value, e.g. whether the session links a document of each
 * type, make a row of the focus node.
 */
export async function overview(report): Promise<Overview> {
  const query = await readFile(OVERVIEW_QUERY, "utf-8");
  const bindings = await (
    await new QueryEngine().queryBindings(query, {
      sources: [datasetSource(report.dataset)],
    })
  ).toArray();
  const results: OverviewResult[] = bindings.map((binding) => {
    const value = binding.get("value")?.value;
    const resultMessage = binding.get("message")?.value;
    return {
      uri: binding.get("result").value,
      focusNode: binding.get("focusNode").value,
      ...(value !== undefined && { value }),
      sourceShape: binding.get("shape").value,
      name: binding.get("name").value,
      severity: binding.get("severity").value,
      ...(resultMessage !== undefined && { resultMessage }),
    };
  });
  const rows = new Map<string, OverviewRow>();
  const resultsByCheck = new Map<string, Map<string, OverviewResult[]>>();
  for (const result of results) {
    const key = rowId(result);
    if (!rows.has(key)) {
      const { focusNode, value } = result;
      rows.set(key, {
        focusNode,
        ...(value !== undefined && { value }),
        checks: {},
      });
      resultsByCheck.set(key, new Map());
    }
    const byName = resultsByCheck.get(key);
    if (!byName.has(result.name)) byName.set(result.name, []);
    byName.get(result.name).push(result);
  }
  for (const [key, row] of rows) {
    for (const [name, checkResults] of resultsByCheck.get(key)) {
      row.checks[name] = check(checkResults);
    }
  }
  const checks = [...new Set(results.map(({ name }) => name))].sort();
  return { checks, rows: [...rows.values()], results };
}

function check(results: OverviewResult[]): OverviewCheck {
  const failed = results.filter(({ severity }) => severity !== DEBUG);
  const severity = SEVERITIES.find((severity) =>
    failed.some((result) => result.severity === severity),
  );
  const messages = [
    ...new Set(
      (failed.length ? failed : results)
        .map(({ resultMessage }) => resultMessage)
        .filter((message) => message !== undefined),
    ),
  ];
  return {
    conforms: !failed.length,
    ...(failed.length ? { severity: severity ?? failed[0].severity } : {}),
    ...(messages.length ? { resultMessage: messages.join(" ") } : {}),
    validationResults: results.map(({ uri }) => uri).sort(),
  };
}

// The id of the row of a result: a hash of its focus node and value, so a row
// has the same id in every validation of the same data
function rowId({ focusNode, value }: { focusNode: string; value?: string }) {
  return createHash("sha256")
    .update(JSON.stringify([focusNode, value ?? null]))
    .digest("hex")
    .slice(0, 32);
}

// The id of a validation result: the last segment of its URI, a hash
function resultId(uri: string) {
  return uri.slice(uri.lastIndexOf("/") + 1);
}

/*
 * The overview as a JSON:API document: the rows as primary data
 * (overview-rows), with their checks as attribute and their validation results
 * as relationship, the validation results as included resources
 * (validation-results), with their URI, and whether the resource conforms and
 * the names of the checks as meta information.
 */
export function overviewJsonApi(
  { checks, rows, results }: Overview,
  {
    resource,
    conforms,
    self,
  }: { resource: string; conforms: boolean; self: string },
) {
  const resultIdentifier = (uri: string) => ({
    type: "validation-results",
    id: resultId(uri),
  });
  return {
    jsonapi: { version: "1.1" },
    links: { self },
    meta: { resource, conforms, checks },
    data: rows.map((row) => ({
      type: "overview-rows",
      id: rowId(row),
      attributes: {
        focusNode: row.focusNode,
        ...(row.value !== undefined && { value: row.value }),
        checks: Object.fromEntries(
          Object.entries(row.checks).map(
            ([name, { validationResults: _results, ...check }]) => [
              name,
              check,
            ],
          ),
        ),
      },
      relationships: {
        validationResults: {
          data: Object.values(row.checks)
            .flatMap(({ validationResults }) => validationResults)
            .sort()
            .map(resultIdentifier),
        },
      },
    })),
    included: results.map(({ uri, ...attributes }) => ({
      ...resultIdentifier(uri),
      attributes: { uri, ...attributes },
    })),
  };
}

// A JSON:API document with an error
export function jsonApiError(status: number, title: string, detail?: string) {
  return {
    jsonapi: { version: "1.1" },
    errors: [
      {
        status: String(status),
        title,
        ...(detail !== undefined && { detail }),
      },
    ],
  };
}
