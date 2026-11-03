import * as fs from "node:fs/promises";
import envvar from "env-var";

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
