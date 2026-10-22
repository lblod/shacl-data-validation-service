import { app, errorHandler } from "mu";
import rdf from "rdf-ext";
import { validateResource } from "./lib/engine";
import { getDataset } from "./lib/resource-retrieval";
import { loadRules, rulesForResource } from "./lib/rules";
import {
  getValidationShape,
  loadValidationShapes,
} from "./lib/validation-shapes";
import { objectsForPredicate } from "./util/dataset";

const RESOURCES = {
  AGB: "http://data.lblod.info/id/bestuurseenheden/6A1E9D09B277C35B6D8DF995", // in oprichting
  AVZ: "http://data.lblod.info/id/bestuurseenheden/6A58D1A41EB93D8F605877B7", // actief
  STEF: "http://data.lblod.info/id/personen/c1dbe5df-4264-428e-a5be-207d26b9917f",
  DIRK: "http://data.lblod.info/id/personen/c1dd889a-7faf-4430-aa1c-b8993fde07d5",
};

const RESOURCE_TYPE = {
  ORG: "organization",
  PERSON: "person",
};

(async function startup() {
  await loadRules();
  await loadValidationShapes();
})();

app.get("/", async function (req, res) {
  res.send("Hello mu-javascript-template");
});

app.get("/test", async function (req, res) {
  // const dataset = await getDataset(RESOURCE_TYPE.ORG, RESOURCES.AGB);
  const resourceToValidate = await getDataset(RESOURCE_TYPE.ORG, RESOURCES.AGB);

  // Get a set<term> containing named nodes for a rule applicable for the given
  // resource type
  const rules = await rulesForResource(resourceToValidate);
  // FIXME: language server complains size property does not exist in DatasetExt...
  if (rules.size > 0) {
    // NOTE (22/10/2026): We lose the connection between validation shape and
    // rule here, that might be an issue when interpreting the report.  It is
    // probably nice if can convert the engine's report to something more
    // readable that says which rule was violated and why.
    const validationShapeUris = objectsForPredicate(
      "http://mu.semte.ch/vocabularies/ext/validationShape",
      rules,
    );

    if (validationShapeUris.size > 0) {
      // NOTE (22/10/2026): We may need to retrieve extra resource triples
      // depending on the validation shapes.  It is likely, the validation
      // shapes require more input than the shapes in the rules. This becomes a
      // concern when we flesh out the data retrieval to work based on the
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
});

app.use(errorHandler);
