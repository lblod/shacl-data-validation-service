import * as fs from "node:fs/promises";
import bodyParser from "body-parser";
import { app, errorHandler } from "mu";
import NamedNodeExt from "rdf-ext/lib/NamedNode.js";
import { REPORTS_DIR, writeReportFile } from "./lib/report";
import { resourceExists } from "./lib/resource-retrieval";
import { validateResource } from "./lib/validation";
import { loadRules } from "./lib/rules";
import { loadValidationShapes } from "./lib/validation-shapes";
import { listUniqueSubjects } from "./util/delta-message";
import * as env from "./env";
import { SubjectQueue } from "./queue";

(async function startup() {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  await loadValidationShapes();
  // The rules link to the validation shapes, which are checked to be loaded
  await loadRules();
})();

const subjectQueue = new SubjectQueue(handleResource);

app.get("/health", async function (_req, res) {
  res.send({ status: "ok" });
});

app.post(
  "/delta",
  bodyParser.json({ limit: "50mb" }),
  async function (req, res) {
    const changesets = req.body;
    const subjects = listUniqueSubjects(changesets);

    for (const subject of subjects) {
      subjectQueue.enqueue(subject);
    }

    return res.status(200).send().end();
  },
);

function logInfo(message: string) {
  if (env.LOGLEVEL === "info") console.log(`\n>> INFO: ${message}`);
}

/*
 * Validates a resource against the validation shapes of the rules that apply
 * to it. Writes a report for each validation shape it doesn't conform to, or
 * for each validation shape with REPORT_DEBUG_RESULTS. The queue calls it
 * asynchronously, so the outcome is only logged: depending on LOGLEVEL, and
 * the errors always.
 */
async function handleResource(namedNode: NamedNodeExt): Promise<void> {
  if (!(await resourceExists(namedNode.value))) {
    logInfo(`No resource found for ${namedNode}`);
    return;
  }

  const { results, errors } = await validateResource(namedNode.value);
  if (!results.length && !errors.length) {
    logInfo(`No rule applies to resource ${namedNode}`);
  }

  for (const { shape, report } of results) {
    // With REPORT_DEBUG_RESULTS, a resource that conforms gets its report of
    // passed validations too
    if (!report.conforms || env.REPORT_DEBUG_RESULTS) {
      await writeReportFile(report, shape);
    }
    if (report.conforms) {
      logInfo(`Resource ${namedNode} conforms to ${shape.value}`);
    } else {
      logInfo(
        `Resource ${namedNode} doesn't conform to ${shape.value}, see report for result`,
      );
    }
  }
  for (const { shape, error } of errors) {
    console.error(
      `\n>> ERROR: Validation of ${namedNode} against ${shape.value} failed:`,
      error,
    );
  }
  if (results.length || errors.length) {
    logInfo(
      `Validated ${namedNode} against ${results.length} shape(s)` +
        (errors.length ? `, failed for ${errors.length} shape(s)` : ""),
    );
  }
}

/*
 * Internal API, used for testing and debugging only.
 */
if (env.ENABLE_TEST_API) {
  app.get("/test/validate/:uri", async function (req, res) {
    const uri = req.params.uri;
    await handleResource(new NamedNodeExt(uri));

    res
      .send(`Resource ${uri} validated, see logs and/or report for results`)
      .end();
  });
}

app.use(errorHandler);
