import type { DatasetCore } from "@rdfjs/types";
import rdf from "rdf-ext";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { initRules, rulesForResource } from "../lib/rules";
import { generateRuleQueries } from "../lib/sparql-generation";
import { validateResource } from "../lib/validation";
import { initValidationShapes } from "../lib/validation-shapes";
import { readFile } from "../util/config";
import { insertContentInDataset } from "../util/rdf-ext-helpers";
import { EX, ex } from "./helpers";
import { runOnStore, store } from "./store";

vi.mock("@lblod/mu-auth-sudo", async () => ({
  querySudo: (await import("./store")).runOnStore,
}));

const FIXTURES = "test/fixtures/sparql-rules/";

const loadFixture = async (name: string, dataset: DatasetCore) =>
  insertContentInDataset(await readFile(FIXTURES + name), dataset);

describe("SPARQL rules", () => {
  let shapes: DatasetCore;

  beforeAll(async () => {
    // The rules link to the validation shapes, which are checked to be loaded
    shapes = await initValidationShapes(FIXTURES + "validation-shapes/");
    await initRules(FIXTURES + "rules/");
    store.data = await loadFixture("data.ttl", rdf.dataset());
  });

  test("bind $this to the focus node", async () => {
    const queries = generateRuleQueries(shapes, {
      shapes: [ex("DocumentShape")],
      focusNodes: [ex("document")],
    });
    const triples = [];
    for (const query of queries) {
      const { results } = await runOnStore(query);
      triples.push(
        ...results.bindings.map(({ s, p, o }) =>
          [s, p, o].map((term) => term.value.replace(EX, "")).join(" "),
        ),
      );
    }
    // Not the source of otherDocument, which has a link as well
    expect(triples).toEqual(["document source page"]);
  });

  // The conformance of a resource per validation shape its rules link to
  async function conformance(name: string) {
    const { results, errors } = await validateResource(ex(name));
    expect(errors).toEqual([]);
    return results.map(({ shape, report }) => [shape.value, report.conforms]);
  }

  test("add the triples they construct to the data before validation", async () => {
    expect(await conformance("document")).toEqual([
      [ex("DocumentShape"), true],
    ]);
  });

  test("leave the data as is for a shape without rules", async () => {
    expect(await conformance("draft")).toEqual([[ex("DraftShape"), false]]);
  });

  test("add the triples a rule's SPARQL rules construct to check a resource against it", async () => {
    const rules = async (name: string) =>
      [...(await rulesForResource(ex(name)))].map((rule) => rule.value).sort();
    // ex:document has no source in the store, only a link
    expect(await rules("document")).toEqual([
      ex("DocumentRule"),
      ex("SourcedDocumentRule"),
    ]);
    expect(await rules("unlinkedDocument")).toEqual([ex("DocumentRule")]);
  });
});
