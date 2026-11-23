import { updateSudo as update } from "@lblod/mu-auth-sudo";
import { sparqlEscapeUri } from "mu";

// TODO: Batch inserts
export async function insertDataset(dataset, graph) {
  const triples = dataset.toString();
  const insertQuery = `INSERT DATA {
     GRAPH ${sparqlEscapeUri(graph)} {
       ${triples}
     }
   }`;
  await update(insertQuery);
}
