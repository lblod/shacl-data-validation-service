import bodyParser from "body-parser";
import { app, errorHandler } from "mu";
import NamedNodeExt from "rdf-ext/lib/NamedNode.js";
import { writeReportFile } from "./lib/report";
import { resourceExists } from "./lib/resource-retrieval";
import { validateResource } from "./lib/validation";
import { loadValidationShapes } from "./lib/validation-shapes";
import { listUniqueSubjects } from "./util/delta-message";
import * as env from "./env";
import { SubjectQueue } from "./queue";

(async function startup() {
  await loadValidationShapes();
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
 * Validates a resource against each validation shape that targets it, and
 * writes the report of each shape it doesn't conform to. Returns the results
 * and errors per shape, or undefined if the resource doesn't exist.
 */
async function handleResource(namedNode: NamedNodeExt) {
  if (!(await resourceExists(namedNode.value))) {
    logInfo(`No resource found for ${namedNode}`);
    return undefined;
  }

  const validation = await validateResource(namedNode.value);
  const { results, errors } = validation;
  if (!results.length && !errors.length) {
    logInfo(`No applicable validation shapes for resource ${namedNode}`);
  }

  for (const { shape, report } of results) {
    if (report.conforms) {
      logInfo(`Resource ${namedNode} conforms to ${shape.value}`);
    } else {
      writeReportFile(report, shape);
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

  return validation;
}

/*
 * Internal API, used for testing and debugging only.
 */
if (env.ENABLE_TEST_API) {
  app.get("/test/validate/:uri", async function (req, res, next) {
    try {
      const uri = req.params.uri;
      const validation = await handleResource(new NamedNodeExt(uri));
      // The URI comes from the request, so it can't be sent as HTML
      res.type("text/plain");

      if (!validation) {
        res.send(`No resource found for ${uri}`);
        return;
      }

      const { results, errors } = validation;
      if (!results.length && !errors.length) {
        res.status(400).send("No applicable validation shapes for resource");
      } else if (errors.length) {
        const failed = errors.map(({ shape }) => shape.value);
        const validated = results.map(({ shape }) => shape.value);
        res
          .status(500)
          .send(
            `Validation failed for shapes: ${failed.join(", ")}, see the logs.\n` +
              `Validated against shapes: ${validated.join(", ") || "none"}`,
          );
      } else {
        res.send(
          `Resource ${uri} validated, see logs and/or reports for results`,
        );
      }
    } catch (err) {
      // Express doesn't catch rejections, which would stop the service
      console.error(err);
      err.status = 500;
      next(err);
    }
  });
}

app.use(errorHandler);
