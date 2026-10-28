import formatsPretty from "@rdfjs/formats/pretty.js";
import { app, errorHandler } from "mu";
import rdf from "rdf-ext";
import { writeReportFile } from "./lib/report";
import { getResource } from "./lib/resource-retrieval";
import { loadRules } from "./lib/rules";
import { validate } from "./lib/validation";
import { loadValidationShapes } from "./lib/validation-shapes";

(async function startup() {
  await loadRules();
  await loadValidationShapes();
})();

// By default, rdf-ext serializes text/turtle as N-Triples
rdf.formats.import(formatsPretty);

// Prefixes of the Turtle returned by /test/data/:uri
const PREFIXES = new Map(
  Object.entries({
    besluit: "http://data.vlaanderen.be/ns/besluit#",
    mandaat: "http://data.vlaanderen.be/ns/mandaat#",
    org: "http://www.w3.org/ns/org#",
    prov: "http://www.w3.org/ns/prov#",
    dct: "http://purl.org/dc/terms/",
    eli: "http://data.europa.eu/eli/ontology#",
    skos: "http://www.w3.org/2004/02/skos/core#",
  }).map(([prefix, namespace]) => [prefix, rdf.namedNode(namespace)]),
);

app.get("/health", async function (_req, res) {
  res.send({ status: "ok" });
});

app.get("/test/validate/:uri", async function (req, res) {
  const uri = req.params.uri;
  const resourceToValidate = await getResource(uri);
  if (resourceToValidate) {
    // NOTE (27/10/2026): Except for organizations and persons, the data of
    // the resource is retrieved with queries generated from the rules and
    // validation shapes, so it contains the triples these shapes need.
    const { report } = await validate(resourceToValidate);
    if (report) {
      writeReportFile(report);
      // The report object refers to its RDF factory, which can't be
      // serialized as JSON. Its dataset is the SHACL validation report.
      res.type("application/n-triples").send(report.dataset.toString());
    } else {
      res.status(400).send("No applicable validation shapes for resource");
    }
  } else {
    res.send(`No resource found for ${uri}`);
  }
});

// The data /test/validate/:uri validates the resource on, as Turtle. Used to
// add test cases, see the Tests section of the README.
app.get("/test/data/:uri", async function (req, res) {
  const uri = req.params.uri;
  const resource = await getResource(uri);
  if (resource) {
    // FIXME: the rdf-ext types don't include io
    const turtle = await (rdf as any).io.dataset.toText("text/turtle", resource, {
      prefixes: PREFIXES,
    });
    res.type("text/turtle").send(turtle);
  } else {
    res.status(404).send(`No resource found for ${uri}`);
  }
});

app.use(errorHandler);
