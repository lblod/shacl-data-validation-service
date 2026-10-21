import { querySudo as query } from "@lblod/mu-auth-sudo";
import { sparqlEscapeUri } from "mu";
import rdf from "rdf-ext";

// modified from lib-decision-validation
function toRdfExtTerm(triple) {
  switch (triple.type) {
    case "uri":
      return rdf.namedNode(triple.value);
    case "literal":
      return rdf.literal(triple.value);
    default:
      return triple;
  }
}

// modified from lib-decision-validation
function toDataset(bindings) {
  return rdf.dataset(
    bindings.map((b) =>
      rdf.quad(
        toRdfExtTerm(b["s"]),
        toRdfExtTerm(b["p"]),
        toRdfExtTerm(b["o"]),
      ),
    ),
  );
}

export async function getDataset(resourceType, uri) {
  switch (resourceType) {
    case "organization":
      return await getOrganizationData(uri);
    case "person":
      return await getPersonData(uri);
    default:
      return;
  }
}

// NOTE (21/10/2026): Hardcoded queries to retrieve appropriate data for now.
// This will be replaced by a more dynamic method in the future.
async function getOrganizationData(orgUri) {
  const orgQuery = `PREFIX org: <http://www.w3.org/ns/org#>
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX regorg: <http://www.w3.org/ns/regorg#>
    CONSTRUCT {
      ?org a org:Organization ;
           ?predicate ?object .
    } WHERE {
      GRAPH <http://mu.semte.ch/graphs/administrative-unit> {
        VALUES ?org {
          ${sparqlEscapeUri(orgUri)}
        }
        ?org a org:Organization .

        VALUES ?predicate {
          skos:prefLabel
          skos:altLabel
          org:classification
          regorg:orgStatus
        }
        OPTIONAL { ?org ?predicate ?object . }
      }
    }`;

  const orgData = await query(orgQuery);
  const bindings = orgData?.results?.bindings;
  const dataset = toDataset(bindings);
  return dataset;
}

async function getPersonData(personUri) {
  const personQuery = `PREFIX org: <http://www.w3.org/ns/org#>
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    PREFIX person: <http://www.w3.org/ns/person#>
    CONSTRUCT {
      ?person a person:Person ;
              ?predicate ?object .
    } WHERE {
      GRAPH <http://mu.semte.ch/graphs/administrative-unit> {
        VALUES ?person {
          ${sparqlEscapeUri(personUri)}
        }
        ?person a person:Person .

        VALUES ?predicate {
          foaf:givenName
          foaf:familyName
        }
        OPTIONAL { ?person ?predicate ?object . }
      }
    }`;

  const personData = await query(personQuery);
  const bindings = personData?.results?.bindings;
  const dataset = toDataset(bindings);
  return dataset;
}
