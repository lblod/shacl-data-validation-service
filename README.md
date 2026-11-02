# SHACL data validation service

> [!Warning]
> This service is currently under construction.  Its API and data model are subject to change.

The SHACL data validation service provides functionality to validate data resources against [SHACL](https://www.w3.org/TR/shacl/) node shapes.  The targets of the node shapes specify to which resources they apply.  This service uses the [shacl-engine](https://github.com/rdf-ext/shacl-engine) to perform the actual validations.

## Getting started
TODO

## Configuration
This service is configured with a set of SHACL node shapes used in the actual data validation.

The code snippets in the following sections assume the following prefixes to be defined.

```ttl
@prefix ext: <http://mu.semte.ch/vocabularies/ext/> .
@prefix org: <http://www.w3.org/ns/org#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
```

### Validation shapes
The SHACL node shapes used to actually validate data resources should be specified in turtle files in the `config/validation-shapes` folder.  The service will read and parse all turtle files in that folder on startup.

The targets of a node shape determine the resources it applies to: `sh:targetClass`, `sh:targetNode`, `sh:targetSubjectsOf`, `sh:targetObjectsOf` or a SPARQL-based target.  For example, the following snippet specifies that all resources of type `org:Organization` should be validated against the `ext:organizationShape` node shape.  Node shapes can share a property shape by referring to it.

```ttl
ext:organizationShape a sh:NodeShape ;
  sh:targetClass org:Organization ;
  sh:property ext:hasLabel .

ext:hasLabel a sh:PropertyShape ;
  sh:path skos:prefLabel ;
  sh:minCount 1 .
```

For more information on defining SHACL node shapes see the [SHACL](https://www.w3.org/TR/shacl/) recommendation or the example files in the configuration folder.

#### Validation shapes with a SPARQL-based target
A [SPARQL-based target](https://www.w3.org/TR/shacl-af/#SPARQLTarget) can further refine to which instances of a resource type a validation shape applies.  The target's query selects the resources in the data of the resource at hand.  For example, the following shape only applies to sessions of a gemeenteraad.

```ttl
pp:GemeenteraadNotulen a sh:NodeShape ;
  sh:target [
    a sh:SPARQLTarget ;
    sh:select """
      PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
      PREFIX mandaat: <http://data.vlaanderen.be/ns/mandaat#>
      PREFIX org: <http://www.w3.org/ns/org#>
      SELECT DISTINCT ?this WHERE {
        ?this a besluit:Zitting ;
          besluit:isGehoudenDoor/mandaat:isTijdspecialisatieVan?/(besluit:classificatie|org:classification) <http://data.vlaanderen.be/id/concept/BestuursorgaanClassificatieCode/5ab0e9b8a3b2ca7c5e000005> .
      }"""
  ] ;
  sh:property pp:GemeenteraadNotulen-aanwezig .
```

#### Why targets instead of rules
Earlier versions of this service selected validation shapes with separate rules: node shapes in `config/rules.ttl` that linked to a validation shape with `ext:validationShape`, and applied when a resource conformed to the rule.  Using the targets of the validation shapes is better for the following reasons.

- **Standard SHACL.**  A target is part of the [SHACL](https://www.w3.org/TR/shacl/#targets) recommendation, `ext:validationShape` only means something to this service.  A shapes file selects the same resources in any SHACL processor that supports its targets (SPARQL-based targets are part of [SHACL Advanced Features](https://www.w3.org/TR/shacl-af/#SPARQLTarget)).
- **One place to look.**  A shape states itself what it applies to.  The validator resolves targets anyway, so a rule had to repeat what the shape already declared, and the two could disagree.
- **Selecting is not validating.**  A rule used a constraint such as `sh:hasValue` to express a condition for selection, which needed a separate validation run for each rule.  A SPARQL-based target expresses that condition directly, including conditions constraints can't express.
- **Usable before retrieving data.**  Targets can be translated to a single SPARQL query (see [resource validation](#resource-validation)).  Rules were evaluated by the validator on data that had to be retrieved first.

#### Reusing property shapes across apps
The one thing a rule made easy was applying the same validation under different conditions.  With targets, that reuse moves to the property shapes: a property shape with a URI and without a target is never selected on its own, and is validated for each node shape that refers to it with `sh:property`.  The checks are therefore defined once, while each node shape decides to which resources they apply.

This also holds across apps.  Each app mounts its own `config/validation-shapes` folder, so a file with the shared property shapes can be added to the folder of every app that needs them.  The node shapes of each app then combine these with the targets that fit its data.

```ttl
# shared-properties.ttl, the same file in each app
ext:hasLabel a sh:PropertyShape ;
  sh:path skos:prefLabel ;
  sh:minCount 1 .

# organization.ttl in app A: applies to all organizations
ext:organizationShape a sh:NodeShape ;
  sh:targetClass org:Organization ;
  sh:property ext:hasLabel .

# organization.ttl in app B: applies only to active organizations
ext:activeOrganizationShape a sh:NodeShape ;
  sh:target [
    a sh:SPARQLTarget ;
    sh:select """
      PREFIX org: <http://www.w3.org/ns/org#>
      PREFIX regorg: <http://www.w3.org/ns/regorg#>
      SELECT DISTINCT ?this WHERE {
        ?this a org:Organization ;
          regorg:orgStatus <http://lblod.data.gift/concepts/63cc561de9188d64ba5840a42ae8f0d6> .
      }"""
  ] ;
  sh:property ext:hasLabel .
```

### Environment variables.

|Name            |Description                           |Default value|
|----------------|--------------------------------------|-------------|
|KEEP_ALL_REPORTS|Whether to keep all generated reports.|false        |

## Methodology
### Resource retrieval
Currently, retrieving the appropriate triples for a given resource (type) consists of hardcoded queries.  In the future this will be made more dynamic, for example by automatically querying the appropriate data based on the information in the validation shapes.

At the time of writing only queries for `org:Organization` and `person:Person` resources are provided.  Furthermore, these queries are incomplete with respect to the full range of properties for such resources.

### Resource validation
This services determines against which SHACL node shapes a resource should be validated from their targets.  `generateTargetQuery` in [lib/sparql-generation.ts](lib/sparql-generation.ts) generates a SELECT query for the shapes whose targets select a focus node, which runs on the data of the resource at hand.  The `sh:select` of SPARQL-based targets is parsed with [Traqula](https://github.com/comunica/traqula).

The resource is validated against the selected shapes, with the shapes they refer to, using a `shacl-engine/Validator` that receives as input these shapes as well as the resource at hand, and resolves SPARQL-based targets.  The validation report is return as is, currently without any further processing.

## Tests
The tests check which shapes are selected for a resource, without a triplestore.  Run them with `npm test`.

## API
### GET /health
Returns `{ "status": "ok" }` if the service is running.

### GET /test/validate/:uri
Endpoint meant for testing during service development.  The service will try to retrieve the data for the resource with the given URI and try to validate it according to the service's configuration.
