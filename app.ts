import rdfDataModel from "@rdfjs/data-model";
import rdfDataset from "@rdfjs/dataset";
import { app, errorHandler } from "mu";
import rdf from "rdf-ext";
import Validator from "shacl-engine/Validator.js";
import { validations } from "shacl-engine/sparql.js";
import { resource } from "rdf-utils-dataset";
import {
  getRuleResource,
  loadRules,
  listRulesForType,
} from "./lib/rules";
import { getDataset } from "./lib/resource-retrieval";
import {
  getValidationShape,
  loadValidationShapes,
} from "./lib/validation-shapes";

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

app.get("/rules", async function (req, res) {
  const conformRules = await collectConformRules(
    RESOURCE_TYPE.ORG,
    RESOURCES.AVZ,
  );
  if (conformRules) {
    res.send(conformRules);
  } else {
    res.status(400).send("No applicable rules found.");
  }
});

app.get("/test", async function (req, res) {
  // const dataset = await getDataset(RESOURCE_TYPE.ORG, RESOURCES.AGB);
  const dataset = await getDataset(RESOURCE_TYPE.ORG, RESOURCES.AGB);

  // Get a set<term> containing named nodes for a rule applicable for the given
  // resource type
  const rules = listRulesForType("http://www.w3.org/ns/org#Organization");

  if (rules?.size > 0) {
    // Check for each rule whether data conforms its conditions
    const validationShapeUris = [];
    for (const ruleUri of rules) {
      const ruleResource = getRuleResource(ruleUri);
      // Create validator for rule
      const validator = new Validator(ruleResource, {
        factory: rdfDataModel,
      });
      // Validate data against rule
      const report = await validator.validate({ dataset: dataset });

      if (report.conforms) {
        // This rule is relevant for the data at hand, retrieve its validation shapes
        const shapeTriples = ruleResource.match(
          undefined,
          rdf.namedNode("http://mu.semte.ch/vocabularies/ext/validationShape"),
        );
        const shapeUris = Array.from(shapeTriples).map(
          (quad) => quad.object.value,
        );
        validationShapeUris.push(...shapeUris);
      }
    }

    // Validate the data against the validation shapes determined above
    if (validationShapeUris?.length > 0) {
      console.info(`\n>> INFO applicable rules: ${validationShapeUris}`);

      const shapes = rdfDataset.dataset();
      for (const shape of validationShapeUris) {
        const shapeResource = resource(VALIDATION_SHAPES, rdf.namedNode(shape));
        shapeResource.forEach((quad) => shapes.add(quad));
      }

      const validator = new Validator(shapes, { factory: rdfDataModel });
      const report = await validator.validate({ dataset });

      res.send(report);
    } else {
      res.status(400).send("No applicable shapes found.");
    }
  } else {
    res.status(400).send("No applicable rules found.");
  }
});

async function collectConformRules(resourceType, resourceUri) {
  // Get some sample data (in practice this would be processing a delta
  // message)
  const dataset = await getDataset(resourceType, resourceUri);

  // Get the possibly relevant rules
  const ruleFiles = listRuleFiles(resourceType);

  if (ruleFiles?.length > 0) {
    const conformRules = rdfDataset.dataset();
    // Check to which rules the data conforms
    for (const ruleFile of ruleFiles) {
      // Read rule from file
      const ruleData = await insertFileContent(ruleFile);
      // Create validator for rule
      const validator = new Validator(ruleData, {
        factory: rdfDataModel,
      });
      // Validate data against rule
      const report = await validator.validate({ dataset: dataset });

      if (report.conforms) {
        for await (const quad of ruleData) {
          conformRules.add(quad);
        }
      }
    }

    return conformRules;
  }
}

function listRuleFiles(resourceType) {
  switch (resourceType) {
    case "organization":
      return [
        "rule-organization-avz.ttl",
        "rule-organization-agb.ttl",
        "rule-organization-active.ttl",
      ];
    case "person":
      return ["person.ttl"];
    default:
      return;
  }
}

// NOTE (14/10/2026): In reality the rules should be read from a single
// configuration file and we filter the one with the right `sh:targetClass`
// here.
async function getRules(resourceType) {
  switch (resourceType) {
    case "organization":
      return await insertFileContent("organization.ttl");
    case "person":
      return await insertFileContent("person.ttl");
    default:
      return;
  }
}

app.get("/validate", async function (req, res) {
  // 1. define a simple example shape
  const shapesFilename = new URL("org.ttl", import.meta.url);
  const shapes = rdfDataset.dataset();
  for await (const quad of fromFile(shapesFilename.pathname)) {
    shapes.add(quad);
  }
  // 2. retrieve some example data
  const organizationDataset = await getOrganizationData();
  // 3. convert both to the format appropriate for the SHACL engine
  // Already done inline
  // 4. Run validator
  const validator = new Validator(shapes, {
    factory: rdfDataModel,
    coverage: true,
    validations,
  });
  const report = await validator.validate({ dataset: organizationDataset });
  // 5. Do something with output
  const enrichedReport = { conform: report.conforms, "full-report": report };
  res.send(JSON.stringify(enrichedReport));
});

app.use(errorHandler);
