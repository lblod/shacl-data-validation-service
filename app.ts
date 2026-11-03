import envvar from "env-var";
import { app, errorHandler } from "mu";
import { writeReportFile } from "./lib/report";
import { getResource } from "./lib/resource-retrieval";
import { validate } from "./lib/validation";
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
      const resourceToValidate = await getResource(uri);
      if (resourceToValidate) {
        // NOTE (22/10/2026): We may need to retrieve extra resource triples
        // depending on the validation shapes.  This becomes a concern when we
        // flesh out the data retrieval to work based on the shapes.
        const { report } = await validate(resourceToValidate, uri);
        if (report) {
          writeReportFile(report);

          res.send("Resource validated, see report for result.");
        } else {
          res.status(400).send("No applicable validation shapes for resource");
        }
      } else {
        // The URI comes from the request, so it can't be sent as HTML
        res.type("text/plain").send(`No resource found for ${uri}`);
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
