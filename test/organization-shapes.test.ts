import rdf from "rdf-ext";
import { beforeAll, expect, test } from "vitest";
import { validationShapesForResource } from "../lib/validation";
import { VALIDATION_SHAPES } from "../lib/validation-shapes";
import { insertContentInDataset } from "../util/dataset";

const EXT = "http://mu.semte.ch/vocabularies/ext/";
const ORG = "http://www.w3.org/ns/org#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const ORG_STATUS = "http://www.w3.org/ns/regorg#orgStatus";
const CLASSIFICATION = ORG + "classification";
const CLASSIFICATION_CODE =
  "http://data.vlaanderen.be/id/concept/BestuurseenheidClassificatieCode/";
const ACTIVE =
  "http://lblod.data.gift/concepts/63cc561de9188d64ba5840a42ae8f0d6";
const AGB = CLASSIFICATION_CODE + "36a82ba0-7ff1-4697-a9dd-2e94df73b721";
const AVZ = CLASSIFICATION_CODE + "34b5af85-dc9f-468f-9e03-ef89b174c267";

const organization = rdf.namedNode("http://example.org/organization");

function organizationData(...triples: [string, string][]) {
  return rdf.dataset(
    [[RDF_TYPE, ORG + "Organization"], ...triples].map(([predicate, object]) =>
      rdf.quad(organization, rdf.namedNode(predicate), rdf.namedNode(object)),
    ),
  );
}

beforeAll(async () => {
  await insertContentInDataset(
    "../config/validation-shapes/organization.ttl",
    VALIDATION_SHAPES,
  );
});

test.each([
  { name: "any organization", triples: [], shapes: [] },
  {
    name: "an active organization",
    triples: [[ORG_STATUS, ACTIVE]],
    shapes: ["organizationWithAltNameShape"],
  },
  {
    name: "an AGB",
    triples: [[CLASSIFICATION, AGB]],
    shapes: ["organizationWithAltNameShape"],
  },
  {
    name: "an AVZ",
    triples: [[CLASSIFICATION, AVZ]],
    shapes: ["organisationNotAdministrativeUnit"],
  },
] as { name: string; triples: [string, string][]; shapes: string[] }[])(
  "selects the organization shapes of $name",
  async ({ triples, shapes }) => {
    const { uris } = await validationShapesForResource(
      organizationData(...triples),
    );
    expect(uris.sort()).toEqual(
      ["organizationShape", ...shapes].map((shape) => EXT + shape).sort(),
    );
  },
);
