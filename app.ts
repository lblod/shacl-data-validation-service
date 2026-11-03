import envvar from "env-var";
import { app, errorHandler } from "mu";
import { writeReportFile } from "./lib/report";
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
      const results = await validateResource(uri);
      if (!results) {
        // The URI comes from the request, so it can't be sent as HTML
        res.type("text/plain").send(`No resource found for ${uri}`);
      } else if (!results.length) {
        res.status(400).send("No applicable validation shapes for resource");
      } else {
        for (const { shape, report } of results) {
          writeReportFile(report, shape);
        }

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
