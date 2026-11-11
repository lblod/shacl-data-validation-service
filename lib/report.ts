import * as fs from "node:fs/promises";
import envvar from "env-var";

// NOTE (03/11/2026): Very rudimentary way to persist validation reports.  We
// just parse the report as JSON and write it as is.  This is technically not
// correct, but is sufficient at this stage of the service's development.
// Better ways to handle the report will be added in the future.

// TODO: Check if exists, create if necessary
const REPORTS_DIR = "/share/";

const KEEP_ALL_REPORTS = envvar
  .get("KEEP_ALL_REPORTS")
  .default("false")
  .asBool();

function timestamp() {
  return new Date().toJSON().replace(/-|T|:|\.|Z/gi, "");
}

export async function writeReportFile(report) {
  const filenamePrefix = KEEP_ALL_REPORTS ? timestamp() + "--" : "";
  const filePath = REPORTS_DIR + filenamePrefix + "report.json";

  const reportString = JSON.stringify(report, null, 2);

  await fs.writeFile(filePath, reportString);
}
