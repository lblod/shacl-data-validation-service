import { app, errorHandler } from "mu";
import rdf from "rdf-ext";
import { validateResource } from "./lib/engine";
import { getResource } from "./lib/resource-retrieval";
import { loadRules, rulesForResource } from "./lib/rules";
import {
  getValidationShape,
  loadValidationShapes,
} from "./lib/validation-shapes";
import { objectsForPredicate } from "./util/dataset";

(async function startup() {
  await loadRules();
  await loadValidationShapes();
})();

app.get("/health", async function (_req, res) {
  res.send({ status: "ok" });
});

app.get("/test/validate/:uri", async function (req, res) {
  const uri = req.params.uri;
  const resourceToValidate = await getResource(uri);
  if (resourceToValidate) {
    // Get a set<term> containing named nodes for a rule applicable for the
    // given resource type
    const rules = await rulesForResource(resourceToValidate);
    // FIXME: language server complains size property does not exist in
    // DatasetExt...
    if (rules.size > 0) {
      // NOTE (22/10/2026): We lose the connection between validation shape and
      // rule here, that might be an issue when interpreting the report.  It is
      // probably nice if we can convert the engine's report to something more
      // readable that says which rule was violated and why.
      const validationShapeUris = objectsForPredicate(
        "http://mu.semte.ch/vocabularies/ext/validationShape",
        rules,
      );

      if (validationShapeUris.size > 0) {
        // NOTE (22/10/2026): We may need to retrieve extra resource triples
        // depending on the validation shapes.  It is likely, the validation
        // shapes require more input than the shapes in the rules. This becomes
        // a concern when we flesh out the data retrieval to work based on the
        // shapes.

        const shapes = rdf.dataset();
        for (const shape of validationShapeUris) {
          const shapeResource = await getValidationShape(shape.value);
          shapes.addAll(shapeResource);
        }

        const report = await validateResource(resourceToValidate, shapes);

        res.send(report);
      } else {
        res.status(400).send("No applicable validation shapes for resource");
      }
    } else {
      res.status(400).send("No applicable rules for resource");
    }
  } else {
    res.send(`No resource found for ${uri}`);
  }
});

app.use(errorHandler);
