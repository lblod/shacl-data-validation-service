import { app, errorHandler } from "mu";
import rdf from "rdf-ext";
import Validator from "shacl-engine/Validator.js";
import { validations } from "shacl-engine/sparql.js";
import {
  getRuleResource,
  loadRules,
  listRulesForType,
  listValidationShapes,
} from "./lib/rules";
import { getDataset } from "./lib/resource-retrieval";
import {
  getValidationShape,
  loadValidationShapes,
} from "./lib/validation-shapes";
import { isConformResource, validateResource } from "./lib/engine";

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
  const rules = listRulesForType("http://www.w3.org/ns/org#Organization");

  if (rules?.size > 0) {
    // Check for each rule whether data conforms its conditions
    const validationShapeUris = [];
    for (const ruleUri of rules) {
      const ruleResource = await getRuleResource(ruleUri);
      // NOTE (22/10/2026): We check whether the incoming data resource conforms
      // to the (node shape in the) rule.  If so, it means that we should
      // validate the data resources against this rule in the next step.
      const isConformRule = await isConformResource(
        resourceToValidate,
        ruleResource,
      );

      if (isConformRule) {
        // This rule is relevant for the data at hand, retrieve its validation shapes
        const shapeUris = listValidationShapes(ruleResource);
        // TODO: Should use the shapeUris directly to construct dataset
        // containing the appropriate shape resources.
        validationShapeUris.push(...shapeUris);
      }
    }

    // Validate the data against the validation shapes determined above
    if (validationShapeUris?.length > 0) {
      console.info(
        `\n>> INFO applicable validation shapes: ${validationShapeUris}`,
      );

      const shapes = rdf.dataset();
      for (const shape of validationShapeUris) {
        const shapeResource = await getValidationShape(shape);
        shapes.addAll(shapeResource);
      }

      const report = await validateResource(resourceToValidate, shapes);

      res.send(report);
    } else {
      res.status(400).send("No applicable shapes found.");
    }
  } else {
    res.status(400).send("No applicable rules found.");
  }
});

  }
});

app.use(errorHandler);
