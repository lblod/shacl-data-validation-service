import { updateSudo as update } from "@lblod/mu-auth-sudo";
import envvar from "env-var";
import { sparqlEscapeUri } from "mu";
import rdf from "rdf-ext";

const SLEEP_TIME = envvar.get("SLEEP_TIME").default("1000").asIntPositive();

const BATCH_SIZE = envvar.get("BATCH_SIZE").default("100").asIntPositive();

export async function insertDataset(dataset, graph) {
  const batches = datasetToBatches(dataset);

  for (const batch of batches) {
    const insertQuery = `INSERT DATA {
        GRAPH ${sparqlEscapeUri(graph)} {
          ${batch.toString()}
        }
      }`;

    try {
      await update(insertQuery);
    } catch (e) {
      throw new Error(
        `${e.message}\n\nQuery that caused error:\n${insertQuery}`,
        {
          cause: e,
        },
      );
    }

    await sleep(SLEEP_TIME);
  }
}

function datasetToBatches(dataset) {
  const quads = Array.from(dataset);

  const batches = [];
  for (let i = 0; i < quads.length; i += BATCH_SIZE) {
    const batch = rdf.dataset(quads.slice(i, i + BATCH_SIZE));
    batches.push(batch);
  }

  return batches;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
