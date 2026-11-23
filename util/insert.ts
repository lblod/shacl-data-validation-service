import { updateSudo as update } from "@lblod/mu-auth-sudo";
import envvar from "env-var";
import { sparqlEscapeUri } from "mu";

const SLEEP_TIME = envvar.get("SLEEP_TIME").default("1000").asIntPositive();

const BATCH_SIZE = envvar.get("BATCH_SIZE").default("100").asIntPositive();

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
