import envvar from "env-var";
import { app, errorHandler } from "mu";
import { writeReportFile } from "./lib/report";
import { resourceExists } from "./lib/resource-retrieval";
import { validateResource } from "./lib/validation";
import { loadValidationShapes } from "./lib/validation-shapes";

// The test routes read any resource through sudo, so they are opt-in
const ENABLE_TEST_ROUTES = envvar
  .get("ENABLE_TEST_ROUTES")
  .default("false")
  .asBool();

(async function startup() {
  await loadValidationShapes();
})();

app.get("/health", async function (_req, res) {
  res.send({ status: "ok" });
});

if (ENABLE_TEST_ROUTES) {
  app.get("/test/validate/:uri", async function (req, res, next) {
    try {
      const uri = req.params.uri;
      if (!(await resourceExists(uri))) {
        // The URI comes from the request, so it can't be sent as HTML
        res.type("text/plain").send(`No resource found for ${uri}`);
        return;
      }

      const { results, errors } = await validateResource(uri);
      if (!results.length && !errors.length) {
        res.status(400).send("No applicable validation shapes for resource");
        return;
      }

      for (const { shape, report } of results) {
        writeReportFile(report, shape);
        console.log(
          `Validation against ${shape.value} succeeded, conforms: ${report.conforms}`,
        );
      }
      for (const { shape, error } of errors) {
        console.error(`Validation against ${shape.value} failed:`, error);
      }

      if (errors.length) {
        const failed = errors.map(({ shape }) => shape.value);
        const written = results.map(({ shape }) => shape.value);
        res
          .status(500)
          .type("text/plain")
          .send(
            `Validation failed for shapes: ${failed.join(", ")}, see the logs.\n` +
              `Reports were written for shapes: ${written.join(", ") || "none"}`,
          );
      } else {
        res.send("Resource validated, see the reports for the result.");
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
