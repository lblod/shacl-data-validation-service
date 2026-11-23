import * as fs from "node:fs/promises";
import envvar from "env-var";
import { localName } from "../util/iri";

// NOTE (03/11/2026): Very rudimentary way to persist validation reports.  We
// just write the report's dataset as N-Triples.  Better ways to handle the
// report will be added in the future.

export const REPORTS_DIR = "/share/";

const ONLY_KEEP_LATEST_REPORT = envvar
  .get("ONLY_KEEP_LATEST_REPORT")
  .default("false")
  .asBool();

const MAX_REPORTS = envvar.get("MAX_REPORTS").default("100").asIntPositive();

function timestamp() {
  return new Date().toJSON().replace(/-|T|:|\.|Z/gi, "");
}

/*
 * Removes the older versions of the report with the given filename, or else the
 * oldest reports beyond MAX_REPORTS. Their timestamps sort reports by age, so
 * the report just written comes last.
 */
async function removeOldReports(filename: string) {
  // Versions of a report differ only in their timestamp, which has no dashes.
  const name = filename.slice(filename.indexOf("--"));
  const reports = (await fs.readdir(REPORTS_DIR))
    .filter((file) => file.includes("--report"))
    .sort();
  const oldReports = ONLY_KEEP_LATEST_REPORT
    ? reports.filter((file) => file.endsWith(name)).slice(0, -1)
    : reports.slice(0, -MAX_REPORTS);
  for (const report of oldReports) {
    await fs.rm(REPORTS_DIR + report);
  }
}

// A report's filename starts with a timestamp, which sorts reports by age. A
// report of a validation against a single shape is named after that shape.
function reportFilename(shape?) {
  if (!shape) return `${timestamp()}--report.nt`;
  const name = localName(shape.value);
  return `${timestamp()}--report-${name}.nt`;
}

export async function writeReportFile(report, shape?) {
  const filename = reportFilename(shape);
  const filePath = REPORTS_DIR + filename;

  // The report object refers to its RDF factory, which can't be serialized as
  // JSON. Its dataset is the SHACL validation report.
  await fs.writeFile(filePath, report.dataset.toString());
  await removeOldReports(filename);
}
