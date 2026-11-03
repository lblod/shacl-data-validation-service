import fs from "fs";
import { createHash } from "node:crypto";
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
    .filter((file) => file.includes("--report"))
    .sort();
  for (const report of reports.slice(0, -MAX_REPORTS)) {
    fs.rmSync(REPORTS_DIR + report);
  }
}

// The hash keeps shapes with the same local name apart
function reportFilename(shape) {
  const localName = shape.value
    .replace(/^.*[#/:]/, "")
    .replace(/[^A-Za-z0-9_-]/g, "_");
  const hash = createHash("sha256").update(shape.value).digest("hex");
  return `report-${localName}-${hash.slice(0, 8)}.nt`;
}

export function writeReportFile(report, shape) {
  const filenamePrefix = KEEP_ALL_REPORTS ? timestamp() + "--" : "";
  const filePath = REPORTS_DIR + filenamePrefix + reportFilename(shape);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  // The report object refers to its RDF factory, which can't be serialized as
  // JSON. Its dataset is the SHACL validation report.
  fs.writeFileSync(filePath, report.dataset.toString());
  if (KEEP_ALL_REPORTS) removeOldReports();
}
