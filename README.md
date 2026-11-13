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
@prefix regorg: <http://www.w3.org/ns/regorg#> .
```

### Validation shapes
The SHACL node shapes used to actually validate data resources should be specified in turtle files in the `config/validation-shapes` folder.  The service will read and parse all turtle files in that folder on startup.

The targets of a node shape determine the resources it applies to: `sh:targetClass`, `sh:targetNode`, `sh:targetSubjectsOf`, `sh:targetObjectsOf` or a SPARQL-based target.  For example, the following shape targets all resources of type `org:Organization`:

```ttl
ext:allOrganizationsShape a sh:NodeShape ;
  sh:targetClass org:Organization .
```

Node shapes *can* share a property shape by referring to its URI. A property shape is validated for each node shape that refers to it with `sh:property`.  The property checks can therefore be defined once, while each node shape decides to which resources they apply. For example, organizations are expected to have at least one prefLabel:

```ttl
ext:allOrganizationsShape sh:property ext:hasLabel .

ext:hasLabel a sh:PropertyShape ;
  sh:path skos:prefLabel ;
  sh:minCount 1 .
```

For more information on defining SHACL node shapes see the [SHACL](https://www.w3.org/TR/shacl/) recommendation or the example files in the configuration folder.

#### Validation shapes with a SPARQL-based target
A [SPARQL-based target](https://www.w3.org/TR/shacl-af/#SPARQLTarget) can further refine to which instances of a resource type a validation shape applies.  The target's query selects the resources in the store.  For example, the following shape applies only to `org:Organization` resources that have the correct value for `regorg:orgStatus`.  Unlike `ext:allOrganizationsShape`, which applies to every organization, it does not report a violation for other organizations, because it does not apply to them.

```ttl
ext:activeOrganizationsShape a sh:NodeShape ;
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

|Name               |Description                                                                                                         |Default value|
|-------------------|--------------------------------------------------------------------------------------------------------------------|-------------|
|ENABLE_TEST_API    |Whether to enable the endpoints under `/test`, these should only be used for testing and debugging during development|false        |
|KEEP_ALL_REPORTS   |Whether to keep all generated reports                                                                               |false        |
|LOGLEVEL           |Level of logging to the console: "silent" or "info"                                                                 |silent       |
|QUEUE_POLL_INTERVAL|The number of milliseconds to wait before rechecking the queue.                                                     |100          |

## Methodology
### Resource retrieval
Currently, retrieving the appropriate triples for a given resource (type) consists of hardcoded queries.  In the future this will be made more dynamic, for example by automatically querying the appropriate data based on the information in the validation shapes.

At the time of writing only queries for `org:Organization` and `person:Person` resources are provided.  Furthermore, these queries are incomplete with respect to the full range of properties for such resources.

### Resource validation
This services determines against which SHACL node shapes a resource should be validated from their targets.  `generateTargetQuery` in [lib/sparql-generation.ts](lib/sparql-generation.ts) generates a SELECT query for the shapes whose targets select a focus node, which runs on the store.  The `sh:select` of SPARQL-based targets is parsed with [Traqula](https://github.com/comunica/traqula).

The resource is validated against the selected shapes, with the shapes they refer to, using a `shacl-engine/Validator` that receives as input these shapes as well as the resource at hand, and resolves SPARQL-based targets.  The validation report is returned as is, currently without any further processing.

## Tests
The tests check which shapes are selected for a resource, without a triplestore.  Run them with `npm test`.

## API
### GET /health
Returns `{ "status": "ok" }` if the service is running.

#### Test API
The following endpoints are only available when `ENABLE_TEST_API` is set to true.

### GET /test/validate/:uri
Endpoint meant for testing during service development.  The service will try to retrieve the data for the resource with the given URI and try to validate it according to the service's configuration.
