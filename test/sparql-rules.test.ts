import rdf from "rdf-ext";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { generateRuleQueries } from "../lib/sparql-generation";
import { validateResource } from "../lib/validation";
import { VALIDATION_SHAPES } from "../lib/validation-shapes";
import { readFile } from "../util/config";
import { insertContentInDataset } from "../util/rdf-ext-helpers";
import { runOnStore, store } from "./store";

vi.mock("@lblod/mu-auth-sudo", async () => ({
  querySudo: (await import("./store")).runOnStore,
}));

const FIXTURES = "test/fixtures/sparql-rules/";
const EX = "http://example.org/";

const ex = (name: string) => EX + name;

const loadFixture = async (name: string, dataset) =>
  insertContentInDataset(await readFile(FIXTURES + name), dataset);

describe("SPARQL rules", () => {
  beforeAll(async () => {
    await loadFixture("shapes.ttl", VALIDATION_SHAPES);
    store.data = await loadFixture("data.ttl", rdf.dataset());
  });

  test("bind $this to the focus node", async () => {
    const queries = generateRuleQueries(VALIDATION_SHAPES, {
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

  // The conformance of a resource per shape targeting it
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
});
