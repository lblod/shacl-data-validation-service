import { createHash } from "node:crypto";
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
    .filter((file) => file.includes("--report"))
    .sort();
  for (const report of reports.slice(0, -MAX_REPORTS)) {
    await fs.rm(REPORTS_DIR + report);
  }
}

// A report of a validation against a single shape is named after that shape.
// The hash keeps shapes with the same local name apart.
function reportFilename(shape?) {
  if (!shape) return "report.nt";
  const localName = shape.value
    .replace(/^.*[#/:]/, "")
    .replace(/[^A-Za-z0-9_-]/g, "_");
  const hash = createHash("sha256").update(shape.value).digest("hex");
  return `report-${localName}-${hash.slice(0, 8)}.nt`;
}

export async function writeReportFile(report, shape?) {
  const filenamePrefix = KEEP_ALL_REPORTS ? timestamp() + "--" : "";
  const filePath = REPORTS_DIR + filenamePrefix + reportFilename(shape);

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  // The report object refers to its RDF factory, which can't be serialized as
  // JSON. Its dataset is the SHACL validation report.
  await fs.writeFile(filePath, report.dataset.toString());
  if (KEEP_ALL_REPORTS) await removeOldReports();
}
