import { QueryEngine } from "@comunica/query-sparql-rdfjs-lite";
import type { DatasetCore } from "@rdfjs/types";
import { Readable } from "node:stream";

// The store the service queries, as a dataset. Tests mock querySudo with
// runOnStore:
//   vi.mock("@lblod/mu-auth-sudo", async () => ({
//     querySudo: (await import("./store")).runOnStore,
//   }));
export const store: { data?: DatasetCore } = {};

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
export async function runOnStore(query: string) {
  const sources = [
    { match: (...args) => Readable.from(store.data?.match(...args) ?? []) },
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
