import fs from "fs";
import envvar from "env-var";

// TODO: Check if exists, create if necessary
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
function removeOldReports() {
  const reports = fs
    .readdirSync(REPORTS_DIR)
    .filter((file) => file.endsWith("--report.nt"))
    .sort();
  for (const report of reports.slice(0, -MAX_REPORTS)) {
    fs.rmSync(REPORTS_DIR + report);
  }
}

export function writeReportFile(report) {
  const filenamePrefix = KEEP_ALL_REPORTS ? timestamp() + "--" : "";
  const filePath = REPORTS_DIR + filenamePrefix + "report.nt";

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  // The report object refers to its RDF factory, which can't be serialized as
  // JSON. Its dataset is the SHACL validation report.
  fs.writeFileSync(filePath, report.dataset.toString());
  if (KEEP_ALL_REPORTS) removeOldReports();
}
