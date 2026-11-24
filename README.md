# SHACL data validation service

> [!Warning]
> This service is currently under construction.  Its API and data model are subject to change.

The SHACL data validation service provides functionality to validate data resources against [SHACL](https://www.w3.org/TR/shacl/) node shapes.  Rules, which are SHACL node shapes themselves, decide which resources are validated against which shapes.  This service uses the [shacl-engine](https://github.com/rdf-ext/shacl-engine) to perform the actual validations.

## Getting started
TODO

## Configuration
This service is configured with a set of rules and a set of SHACL node shapes used in the actual data validation.

The code snippets in the following sections assume the following prefixes to be defined.

```ttl
@prefix ext: <http://mu.semte.ch/vocabularies/ext/> .
@prefix org: <http://www.w3.org/ns/org#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix regorg: <http://www.w3.org/ns/regorg#> .
```

### Rules
The rules should be specified in turtle files in the `config/rules` folder.  The service will read and parse all turtle files in that folder on startup.  A rule is a SHACL node shape that links to the validation shapes to validate resources against with `ext:validationShape`.  A rule applies to a resource when its targets select the resource and the resource conforms to the rule, e.g. to its property shapes.  For example, the following rule validates every `org:Organization` against `ext:organizationShape`:

```ttl
ext:organizationRule a sh:NodeShape ;
  sh:targetClass org:Organization ;
  ext:validationShape ext:organizationShape .
```

The targets can be `sh:targetClass`, `sh:targetNode`, `sh:targetSubjectsOf`, `sh:targetObjectsOf` or a [SPARQL-based target](https://www.w3.org/TR/shacl-af/#SPARQLTarget).  The constraints of a rule further refine to which resources it applies.  For example, the following rule applies only to `org:Organization` resources that have the correct value for `regorg:orgStatus`.  Other organizations are not validated against `ext:organizationWithAltNameShape`, so it doesn't report a violation for them.

```ttl
ext:activeOrganizationRule a sh:NodeShape ;
  sh:targetClass org:Organization ;
  sh:property [
    sh:path regorg:orgStatus ;
    sh:hasValue <http://lblod.data.gift/concepts/63cc561de9188d64ba5840a42ae8f0d6> ;
  ] ;
  ext:validationShape ext:organizationWithAltNameShape .
```

A rule can link to several validation shapes using `ext:validationShape`. Vice versa, a validation shape can be used by multiple rules.
This service doesn't start when a rule links to a validation shape that isn't configured.

### Validation shapes
The SHACL node shapes used to actually validate data resources should be configured in turtle files in the `config/validation-shapes` folder.  The service will read and parse all turtle files in that folder on startup.

The rules decide which resources a validation shape validates, so a validation shape doesn't need a target.  A target of a validation shape doesn't select resources to validate, but it does restrict the data retrieved to validate a resource to the resources it selects, so the service warns about it on startup.

Node shapes *can* share a property shape by referring to its URI. A property shape is validated for each node shape that refers to it with `sh:property`. For example, organizations are expected to have at least one prefLabel:

```ttl
ext:organizationShape a sh:NodeShape ;
  sh:property ext:hasLabel .

ext:hasLabel a sh:PropertyShape ;
  sh:path skos:prefLabel ;
  sh:minCount 1 .
```

For more information on defining SHACL node shapes see the [SHACL](https://www.w3.org/TR/shacl/) recommendation or the example files in the configuration folder.

### Environment variables.

|Name               |Description                                                                                                         |Default value|
|-------------------|--------------------------------------------------------------------------------------------------------------------|-------------|
|ENABLE_TEST_API    |Whether to enable the endpoints under `/test`, these should only be used for testing and debugging during development|false        |
|FOCUS_NODE_LIMIT   |The maximum number of resources the targets of a rule select at a time                                              |100          |
|KEEP_ALL_REPORTS   |Whether to keep all generated reports                                                                               |false        |
|LOGLEVEL           |Level of logging to the console: "silent" or "info"                                                                 |silent       |
|QUEUE_POLL_INTERVAL|The number of milliseconds to wait before rechecking the queue.                                                     |100          |

## Methodology
A resource is handled in two phases: the rules select whether, and against which validation shapes, it is validated, and it is then validated against those shapes.  Both phases retrieve the data with the same generated queries and validate it with the same validator, separately for each resource.

### Resource selection
For each rule, `generateFocusNodeQuery` (see [lib/sparql-generation.ts](lib/sparql-generation.ts)) generates a SELECT query for the resources the targets of the rule select in the store, restricted to the resource being handled.  This query always has a `LIMIT`, `FOCUS_NODE_LIMIT` by default, and is ordered so an `OFFSET` selects the next resources: without a limit, a rule would retrieve and validate every resource its targets select.  For each selected resource separately, the data of the rule is retrieved and validated, as below, and the rule applies to the resource if it conforms.  The targets are selected in the store first, because the validator doesn't resolve the targets of a shape for a given resource.

### Resource retrieval
The data of a resource is retrieved with a CONSTRUCT query generated from a rule or a validation shape by `generateConstructQuery`: the triples along its property paths and the data of the shapes it refers to, such as `sh:node` and `sh:or`, for a resource its targets select.  The triples the targets select the resource on, such as its `rdf:type` for `sh:targetClass`, are not retrieved: the resource is validated as given, without resolving the targets again.  Only this data is retrieved, so a property the shape doesn't mention is not part of the data it is validated on.  The query always retrieves the data of a single resource.

The queries run through sudo, bypassing the authorization of mu-authorization, and don't specify a `GRAPH`, so they read the data from all graphs.

SPARQL-based constraints (`sh:sparql`) and SPARQL-based targets without a `sh:select` are not supported.

### Resource validation
A resource is validated against each validation shape the rules that apply to it link to, separately, on the data retrieved for that shape.  A `shacl-engine/Validator` receives the shape with the shapes it refers to, as well as the data, and only validates the resource.  It does not resolve the target of the shape: the data can hold other resources, for example a value node of the same class, without the data needed to validate them.  shacl-engine skips the validation of an empty data graph.  When nothing is retrieved for a resource, it is validated on a placeholder triple that no shape refers to instead.  The validation report is returned as is, currently without any further processing.

## Tests
The tests check which resources the targets of a shape select, which rules apply to a resource, which data the generated queries retrieve and the validation per shape, without a triplestore.  Run them with `npm test`.

## API
### GET /health
Returns `{ "status": "ok" }` if the service is running.

#### Test API
The following endpoints are only available when `ENABLE_TEST_API` is set to true.

### GET /test/validate/:uri
Endpoint meant for testing during service development.  The service will determine the rules that apply to the resource with the given URI, and validate it against the validation shapes they link to.
