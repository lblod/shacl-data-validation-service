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

The targets of a node shape determine the resources it applies to: `sh:targetClass`, `sh:targetNode`, `sh:targetSubjectsOf`, `sh:targetObjectsOf` or a SPARQL-based target.  For example, the following shape applies to all `org:Organization` resources, and reports a violation for each one without the correct value for `regorg:orgStatus`.

```ttl
ext:activeOrganizationShape-v1 a sh:NodeShape ;
  sh:targetClass org:Organization ;
  sh:property [
    sh:path regorg:orgStatus ;
    sh:hasValue <http://lblod.data.gift/concepts/63cc561de9188d64ba5840a42ae8f0d6> ;
    ] .
```

Node shapes can share a property shape by referring to it. Reuse of SHACL moves to the property shapes: a property shape with a URI and without a target is never selected on its own, and is validated for each node shape that refers to it with `sh:property`.  The checks can therefore be defined once, while each node shape decides to which resources they apply.

```ttl
ext:organizationShape sh:property ext:hasLabel .

ext:hasLabel a sh:PropertyShape ;
  sh:path skos:prefLabel ;
  sh:minCount 1 .
```

For more information on defining SHACL node shapes see the [SHACL](https://www.w3.org/TR/shacl/) recommendation or the example files in the configuration folder.

#### Validation shapes with a SPARQL-based target
A [SPARQL-based target](https://www.w3.org/TR/shacl-af/#SPARQLTarget) can further refine to which instances of a resource type a validation shape applies.  The target's query selects the resources in the data of the resource at hand.  For example, the following shape applies only to `org:Organization` resources that have the correct value for `regorg:orgStatus`.  Unlike `ext:activeOrganizationShape-v1`, it does not report a violation for other organizations, because it does not apply to them.

```ttl
ext:activeOrganizationShape-v2 a sh:NodeShape ;
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

|Name              |Description                                                                                                        |Default value|
|------------------|-------------------------------------------------------------------------------------------------------------------|-------------|
|ENABLE_TEST_ROUTES|Whether to enable the `/test` routes.  They read resources through sudo, so only enable them during development.  |false        |
|KEEP_ALL_REPORTS  |Whether to keep generated reports instead of overwriting one report.                                               |false        |
|MAX_REPORTS       |The number of reports to keep with `KEEP_ALL_REPORTS`.  The oldest reports are removed.                            |100          |

## Methodology
### Resource retrieval
The data of a resource is retrieved with queries generated from the validation shapes, see [lib/sparql-generation.ts](lib/sparql-generation.ts).  `generateTargetQuery` determines on the store which shapes have a target that selects the resource.  `generateConstructQuery` then generates a CONSTRUCT query for the data those shapes need: the triples their targets select on, the triples along their property paths, and the data of the shapes these refer to, such as `sh:node` and `sh:or`.  Only this data is retrieved, so a property no active shape mentions is not part of the data that is validated.

The queries run through sudo, bypassing the authorization of mu-authorization, and don't specify a `GRAPH`, so they read the data from all graphs.

SPARQL-based constraints (`sh:sparql`) and SPARQL-based targets without a `sh:select` are not supported.  Negated property sets in the `sh:select` of a target are used to select the focus nodes, but their triples are not retrieved.

### Resource validation
This services determines against which SHACL node shapes a resource should be validated from their targets.  `generateTargetQuery` in [lib/sparql-generation.ts](lib/sparql-generation.ts) generates a SELECT query for the shapes whose targets select a focus node, which runs on the data of the resource at hand.  The `sh:select` of SPARQL-based targets is parsed with [Traqula](https://github.com/comunica/traqula).

The resource is validated against the selected shapes, with the shapes they refer to, using a `shacl-engine/Validator` that receives as input these shapes as well as the resource at hand, and resolves SPARQL-based targets.  The validation report is returned as is, currently without any further processing.

## Tests
The tests check which shapes are selected for a resource and which data the generated queries retrieve, without a triplestore.  Run them with `npm test`.

## API
### GET /health
Returns `{ "status": "ok" }` if the service is running.

### GET /test/validate/:uri
Endpoint meant for testing during service development, only available with `ENABLE_TEST_ROUTES` set to `true`.  The service will try to retrieve the data for the resource with the given URI and try to validate it according to the service's configuration.
