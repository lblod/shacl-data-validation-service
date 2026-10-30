import formatsPretty from "@rdfjs/formats/pretty.js";
import { app, errorHandler } from "mu";
import rdf from "rdf-ext";
import { REPORT_CONTEXT, reportJsonLd, writeReportFile } from "./lib/report";
import {
  JSON_API,
  jsonApiError,
  overview,
  overviewJsonApi,
} from "./lib/overview";
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
    ext: "http://mu.semte.ch/vocabularies/ext/",
  }).map(([prefix, namespace]) => [prefix, rdf.namedNode(namespace)]),
);

app.get("/health", async function (_req, res) {
  res.send({ status: "ok" });
});

// The JSON-LD context of the validation reports, see reportJsonLd. JSON-LD
// processors in browsers fetch it from other origins.
app.get("/contexts/validation-report.jsonld", function (_req, res) {
  res
    .type("application/ld+json")
    .set("Access-Control-Allow-Origin", "*")
    .send({ "@context": REPORT_CONTEXT });
});

app.get("/test/validate/:uri", async function (req, res) {
  const uri = req.params.uri;
  const resourceToValidate = await getResource(uri);
  if (resourceToValidate) {
    // NOTE (27/10/2026): Except for organizations and persons, the data of
    // the resource is retrieved with queries generated from the rules and
    // validation shapes, so it contains the triples these shapes need.
    // The report also shows the passed validations, with severity shn:Debug
    const { report } = await validate(resourceToValidate, { debug: true });
    if (report) {
      writeReportFile(report);
      // The report object refers to its RDF factory, which can't be
      // serialized as JSON. Its dataset is the SHACL validation report, as
      // N-Triples or as JSON-LD, see reportJsonLd. As JSON, the report as a
      // table, as JSON:API, see overviewJsonApi.
      const table = await overview(report);
      const jsonApi = () =>
        res.type(JSON_API).send(
          overviewJsonApi(table, {
            resource: uri,
            conforms: report.conforms,
            self: req.originalUrl,
          }),
        );
      res.format({
        "application/n-triples": () => res.send(report.dataset.toString()),
        "application/ld+json": () => res.send(reportJsonLd(report)),
        [JSON_API]: jsonApi,
        "application/json": jsonApi,
      });
    } else {
      sendError(res, 400, "No applicable validation shapes for resource");
    }
  } else {
    sendError(res, 404, `No resource found for ${uri}`);
  }
});

// An error as text, or as JSON:API for clients that accept JSON
function sendError(res, status: number, title: string) {
  res.status(status).format({
    "text/plain": () => res.send(title),
    [JSON_API]: () => res.type(JSON_API).send(jsonApiError(status, title)),
    "application/json": () =>
      res.type(JSON_API).send(jsonApiError(status, title)),
  });
}

// The data /test/validate/:uri validates the resource on, as Turtle. Used to
// add test cases, see the Tests section of the README.
app.get("/test/data/:uri", async function (req, res) {
  const uri = req.params.uri;
  const resource = await getResource(uri);
  if (resource) {
    // FIXME: the rdf-ext types don't include io
    const turtle = await (rdf as any).io.dataset.toText(
      "text/turtle",
      resource,
      {
        prefixes: PREFIXES,
      },
    );
    res.type("text/turtle").send(turtle);
  } else {
    res.status(404).send(`No resource found for ${uri}`);
  }
});

app.use(errorHandler);
