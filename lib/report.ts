import fs from "fs";
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

export function writeReportFile(report) {
  const filenamePrefix = KEEP_ALL_REPORTS ? timestamp() + "--" : "";
  const filePath = REPORTS_DIR + filenamePrefix + "report.json";

  const reportString = JSON.stringify(report, null, 2);

  fs.writeFileSync(filePath, reportString);
}
