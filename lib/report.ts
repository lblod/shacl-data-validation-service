import * as fs from "node:fs/promises";
import envvar from "env-var";

// NOTE (03/11/2026): Very rudimentary way to persist validation reports.  We
// just write the report's dataset as N-Triples.  Better ways to handle the
// report will be added in the future.

const REPORTS_DIR = "/share/";

const KEEP_ALL_REPORTS = envvar
  .get("KEEP_ALL_REPORTS")
  .default("false")
  .asBool();

const MAX_REPORTS = envvar.get("MAX_REPORTS").default("100").asIntPositive();

function timestamp() {
  return new Date().toJSON().replace(/-|T|:|\.|Z/gi, "");
}

// Removes the oldest kept reports: their timestamps sort by age
async function removeOldReports() {
  const reports = (await fs.readdir(REPORTS_DIR))
    .filter((file) => file.endsWith("--report.nt"))
    .sort();
  for (const report of reports.slice(0, -MAX_REPORTS)) {
    await fs.rm(REPORTS_DIR + report);
  }
}

export async function writeReportFile(report) {
  const filenamePrefix = KEEP_ALL_REPORTS ? timestamp() + "--" : "";
  const filePath = REPORTS_DIR + filenamePrefix + "report.nt";

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  // The report object refers to its RDF factory, which can't be serialized as
  // JSON. Its dataset is the SHACL validation report.
  await fs.writeFile(filePath, report.dataset.toString());
  if (KEEP_ALL_REPORTS) await removeOldReports();
}
