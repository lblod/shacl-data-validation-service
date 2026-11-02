import { app, errorHandler } from "mu";
import { writeReportFile } from "./lib/report";
import { getResource } from "./lib/resource-retrieval";
import { validate } from "./lib/validation";
import { loadValidationShapes } from "./lib/validation-shapes";

(async function startup() {
  await loadValidationShapes();
})();

app.get("/health", async function (_req, res) {
  res.send({ status: "ok" });
});

app.get("/test/validate/:uri", async function (req, res) {
  const uri = req.params.uri;
  const resourceToValidate = await getResource(uri);
  if (resourceToValidate) {
    // NOTE (22/10/2026): We may need to retrieve extra resource triples
    // depending on the validation shapes.  This becomes a concern when we flesh
    // out the data retrieval to work based on the shapes.
    const { report } = await validate(resourceToValidate);
    if (report) {
      writeReportFile(report);

      res.send("Resource validated, see report for result.");
    } else {
      res.status(400).send("No applicable validation shapes for resource");
    }
  } else {
    res.send(`No resource found for ${uri}`);
  }
});

app.use(errorHandler);
