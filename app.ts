import bodyParser from "body-parser";
import { app, errorHandler } from "mu";
import NamedNodeExt from "rdf-ext/lib/NamedNode.js";
import { writeReportFile } from "./lib/report";
import { getResource } from "./lib/resource-retrieval";
import { validate } from "./lib/validation";
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

async function handleResource(namedNode: NamedNodeExt) {
  const resourceToValidate = await getResource(namedNode);

  if (resourceToValidate) {
    // NOTE (22/10/2026): We may need to retrieve extra resource triples
    // depending on the validation shapes.  This becomes a concern when we
    // flesh out the data retrieval to work based on the shapes.
    const { report } = await validate(resourceToValidate, namedNode.value);

    if (!report) {
      if (env.LOGLEVEL === "info") {
        console.log(
          `\n>> INFO: No applicable validation shapes for resource ${namedNode}`,
        );
      }
    } else if (report.conforms) {
      if (env.LOGLEVEL === "info") {
        console.log(
          `\n>> INFO: Resource ${namedNode} was successfully validated`,
        );
      }
    } else {
      await writeReportFile(report);
      if (env.LOGLEVEL === "info") {
        console.log(
          `\n>> INFO: Resource ${namedNode} was not valid, see report for result`,
        );
      }
    }
  } else {
    if (env.LOGLEVEL === "info") {
      console.log(`\n>> INFO: No resource found for ${namedNode}`);
    }
  }
}

/*
 * Internal API, used for testing and debugging only.
 */
if (env.ENABLE_TEST_API) {
  app.get("/test/validate/:uri", async function (req, res, next) {
    try {
      const uri = req.params.uri;
      await handleResource(new NamedNodeExt(uri));

      // The URI comes from the request, so it can't be sent as HTML
      res
        .type("text/plain")
        .send(`Resource ${uri} validated, see logs and/or report for results`)
        .end();
    } catch (err) {
      // Express doesn't catch rejections, which would stop the service
      console.error(err);
      err.status = 500;
      next(err);
    }
  });
}

app.use(errorHandler);
