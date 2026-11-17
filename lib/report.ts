import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import envvar from "env-var";

// NOTE (03/11/2026): Very rudimentary way to persist validation reports.  We
// just write the report's dataset as N-Triples.  Better ways to handle the
// report will be added in the future.

const REPORTS_DIR = "/share/";

const ONLY_KEEP_LATEST_REPORT = envvar
  .get("ONLY_KEEP_LATEST_REPORT")
  .default("false")
  .asBool();

const MAX_REPORTS = envvar.get("MAX_REPORTS").default("100").asIntPositive();

function timestamp() {
  return new Date().toJSON().replace(/-|T|:|\.|Z/gi, "");
}

/*
 * Removes the older versions of the report with the given name, or else the
 * oldest reports beyond MAX_REPORTS. Their timestamps sort reports by age, so
 * the report just written comes last.
 */
async function removeOldReports(name: string) {
  const reports = (await fs.readdir(REPORTS_DIR))
    .filter((file) => file.includes("--report"))
    .sort();
  const oldReports = ONLY_KEEP_LATEST_REPORT
    ? reports.filter((file) => file.endsWith("--" + name)).slice(0, -1)
    : reports.slice(0, -MAX_REPORTS);
  for (const report of oldReports) {
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
  const name = reportFilename(shape);
  const filePath = REPORTS_DIR + timestamp() + "--" + name;

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  // The report object refers to its RDF factory, which can't be serialized as
  // JSON. Its dataset is the SHACL validation report.
  await fs.writeFile(filePath, report.dataset.toString());
  await removeOldReports(name);
}
