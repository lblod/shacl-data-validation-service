import { querySudo as query } from "@lblod/mu-auth-sudo";
import { sparqlEscapeUri } from "mu";
import rdf from "rdf-ext";
import { RULES } from "./rules";
import {
  generateConstructQuery,
  generateRuleQueries,
  generateTargetQuery,
  type SparqlGenerationOptions,
} from "./sparql-generation";
import { sparqlTargetFocusNodes, VALIDATION_SHAPES } from "./validation-shapes";

// modified from lib-decision-validation
function toRdfExtTerm(triple) {
  switch (triple.type) {
    case "uri":
      return rdf.namedNode(triple.value);
    case "bnode":
      return rdf.blankNode(triple.value);
    case "literal":
    case "typed-literal":
      return rdf.literal(
        triple.value,
        triple["xml:lang"] ||
          (triple.datatype ? rdf.namedNode(triple.datatype) : undefined),
      );
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

// Maximum number of times the data of the focus nodes selected in the data
// of a resource is retrieved, see addSelectedFocusNodesData
const MAX_FOCUS_NODE_ROUNDS = 5;


// The data the shapes need, retrieved with a generated CONSTRUCT query, with
// the triples the SPARQL rules of the shapes construct (sh:rule), e.g. to
// repair links to documents with a fragment
async function constructData(shapes, options: SparqlGenerationOptions) {
  const constructQueries = [
    generateConstructQuery(shapes, options),
    ...generateRuleQueries(shapes, options),
  ].filter(Boolean);
  const results = await Promise.all(
    constructQueries.map((constructQuery) => {
      console.log(constructQuery);
      return query(constructQuery);
    }),
  );
  return toDataset(
    results.flatMap((result) => result?.results?.bindings ?? []),
  );
}

export async function getResource(uri) {
  const typesData = await query(`SELECT DISTINCT ?type {
    ${sparqlEscapeUri(uri)} a ?type .
  }`);

  if (typesData.results.bindings.length > 0) {
    const types = typesData.results.bindings.map(
      (binding) => binding.type.value,
    );

    if (types.includes("http://www.w3.org/ns/org#Organization")) {
      return getOrganizationData(uri);
    }
    if (types.includes("http://www.w3.org/ns/person#Person")) {
      return getPersonData(uri);
    }
    // NOTE (28/10/2026): The data of other resources is retrieved with SPARQL queries generated from SHACL
    return getShapesData(uri);
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

// The shapes whose targets (sh:targetNode, sh:targetClass, SPARQL-based
// targets, …) select the resource in the store
async function shapesTargeting(shapes, uri: string) {
  const targetQuery = generateTargetQuery(shapes, { focusNodes: [uri] });
  if (!targetQuery) return [];
  const result = await query(targetQuery.query);
  return (result?.results?.bindings ?? []).map(
    (binding) => targetQuery.shapes[Number(binding.shape.value)],
  );
}

/*
 * The data to validate a resource on, retrieved with queries generated from
 * the rules and validation shapes (see lib/sparql-generation.ts):
 * - the data the rules and validation shapes targeting the resource need
 * - the data the validation shapes need for the focus nodes their SPARQL-based
 *   targets select in that data, e.g. the documents of a session
 */
async function getShapesData(uri: string) {
  const shapes = rdf.dataset([...RULES, ...VALIDATION_SHAPES]);
  const targetingShapes = await shapesTargeting(shapes, uri);
  const dataset = targetingShapes.length
    ? await constructData(shapes, {
        shapes: targetingShapes,    
        focusNodes: [uri],
      })
    : rdf.dataset();

  await addSelectedFocusNodesData(uri, dataset);
  return dataset;
}

/*
 * The SPARQL-based target of a validation shape can select focus nodes other
 * than the resource in its data, e.g. a shape whose target selects the
 * documents of a session. Adds the data the shape needs for those focus nodes,
 * until the targets don't select new focus nodes.
 */
async function addSelectedFocusNodesData(uri: string, dataset) {
  const retrieved = new Set<string>();
  for (let round = 0; round < MAX_FOCUS_NODE_ROUNDS; round++) {
    const retrievals = [];
    for (const { shape, focusNodes } of await sparqlTargetFocusNodes(dataset)) {
      const newFocusNodes = focusNodes.filter(
        (node) =>
          node.value !== uri && !retrieved.has(`${shape.value} ${node.value}`),
      );
      newFocusNodes.forEach((node) =>
        retrieved.add(`${shape.value} ${node.value}`),
      );
      if (newFocusNodes.length) {
        retrievals.push(
          constructData(VALIDATION_SHAPES, {
            shapes: [shape],
            focusNodes: newFocusNodes,
          }),
        );
      }
    }
    if (!retrievals.length) return;
    for (const data of await Promise.all(retrievals)) {
      dataset.addAll(data);
    }
  }
}
