import bodyParser from "body-parser";
import { app, errorHandler } from "mu";
import NamedNodeExt from "rdf-ext/lib/NamedNode.js";
import { validateResource } from "./lib/engine";
import { writeReportFile } from "./lib/report";
import { getResource } from "./lib/resource-retrieval";
import { loadRules, rulesForResource } from "./lib/rules";
import { loadValidationShapes, shapeResources } from "./lib/validation-shapes";
import { objectsForPredicate } from "./util/dataset";
import { listUniqueSubjects } from "./util/delta-message";

(async function startup() {
  await loadRules();
  await loadValidationShapes();
})();

app.get("/health", async function (_req, res) {
  res.send({ status: "ok" });
});

app.post(
  "/delta",
  bodyParser.json({ limit: "50mb" }),
  async function (req, res) {
    const changesets = req.body;
    const subjects = listUniqueSubjects(changesets);
    // TODO: Should probably use some overall queue of subjects yet to validate.
    // In busy apps delta messages can arrive rather frequently, possibly
    // containing overlapping subjects.  Ideally we avoid validating the same
    // resource multiple times in this scenario.

    for (const subject of subjects) {
      // NOTE (03/11/2026): Do not await here, we perform the validation in the
      // background and write results to report.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleResource(subject).catch((e: any) => {
        console.error(
          `Something went wrong while processing resource ${subject}: ${e}`,
        );
      });
    }

    return res.status(200).send().end();
  },
);

async function handleResource(namedNode: NamedNodeExt) {
  const resourceToValidate = await getResource(namedNode);

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

        const shapes = shapeResources(validationShapeUris);

        const report = await validateResource(resourceToValidate, shapes);

        // TODO: Make logging optional via ENV VAR
        if (report.conforms) {
          console.log(
            `\n>> INFO: Resource ${namedNode} was successfully validated`,
          );
        } else {
          writeReportFile(report);
          console.log(
            `\n>> INFO: Resource ${namedNode} was not valid, see report for result`,
          );
        }
      } else {
        console.log(
          `\n>> INFO: No applicable validation shapes for resource ${namedNode}`,
        );
      }
    } else {
      console.log(`\n>> INFO: No applicable rules for resource ${namedNode}`);
    }
  } else {
    console.log(`\n>> INFO: No resource found for ${namedNode}`);
  }
}

/*
 * Internal API, used for testing only.  This may be removed in the future.
 */
app.get("/test/validate/:uri", async function (req, res) {
  const uri = req.params.uri;
  await handleResource(new NamedNodeExt(uri));

  res
    .send(`Resource ${uri} validated, see logs and/or report for results`)
    .end();
});

app.use(errorHandler);
