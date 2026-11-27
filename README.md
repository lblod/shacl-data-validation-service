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

The rules decide which resources a validation shape validates, so a validation shape doesn't need a target.  A target of a validation shape has no effect: it doesn't select resources to validate, and it doesn't restrict the data retrieved to validate a resource.

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
|LOGLEVEL           |Level of logging to the console: "silent" or "info"                                                                 |silent       |
|MAX_REPORTS        |The number of reports to keep.  The oldest reports are removed.                                                     |100          |
|QUEUE_POLL_INTERVAL|The number of milliseconds to wait before rechecking the queue.                                                     |100          |
|REPORT_DEBUG_RESULTS|Whether reports also hold a result for each passed validation, with severity `shn:Debug`.  Resources that conform get a report too.|false        |
|REPORT_FORMAT      |The format of the report files: "n-triples" or "json-ld"                                                            |n-triples    |

## Methodology
A resource is handled in two phases: first, the rules are selected that target the resource (using a combination of a generated SELECT query and validation), and second, the resource gets validated with the validation shapes that are linked with the selected rules. Both phases retrieve the data of the resource with the same generated CONSTRUCT queries and validate it with the same validator.

The data of a resource is retrieved with a CONSTRUCT query that `generateConstructQuery` generates from a rule or a validation shape: the triples along its property paths and the data of the shapes it refers to, such as `sh:node` and `sh:or`.  The query always retrieves the data of a single resource: its focus node variable is bound to the resource with `VALUES`.

The queries run through sudo, bypassing the authorization of mu-authorization, and don't specify a `GRAPH`, so they read the data from all graphs.

SPARQL-based constraints (`sh:sparql`) and SPARQL-based targets without a `sh:select` are not supported.

`sh:deactivated` is not supported: to stop using a rule, remove it or comment it out. A deactivated rule conforms, so it would apply to every resource its targets select.

### Rule selection
A rule applies to a resource when its targets select the resource and the resource conforms to the rule.  `generateFocusNodeQuery` (see [lib/sparql-generation.ts](lib/sparql-generation.ts)) generates a SELECT query from the [target declarations](https://www.w3.org/TR/shacl/#targets) of a rule.  Each target becomes a graph pattern binding `?focusNode`, and the patterns of the targets are the branches of a `UNION`. A rule without targets selects every resource with a type.

For the resource being handled, the query is restricted to that resource with a `LIMIT` of 1, for each rule.

If the query selects the resource, the data needed for the property shapes of the rule is retrieved, as described above, and validated. If the resource conforms, the rule applies to the resource.

### Resource validation
A resource is validated against each validation shape separately. The data of the resource is retrieved using a CONSTRUCT query as described above. The SHACL engine does not resolve the target of the shape, and only validates the resource. The data can hold other resources, for example a value node of the same class, without the data needed to validate them.  When no data is retrieved for a resource, it is validated on a placeholder triple that no shape refers to instead.

When a resource doesn't conform to a validation shape, the report of that shape is written as N-Triples to `/share/<timestamp>--report-<local name>.nt`, named after the shape.  Only the newest `MAX_REPORTS` reports are kept.

With `REPORT_FORMAT` set to `json-ld`, the reports are written as JSON-LD instead, with the extension `.jsonld`.  Each report embeds the context in [config/contexts/validation-report.jsonld](config/contexts/validation-report.jsonld), which names the SHACL terms by their local name, e.g. `result`, `focusNode` and `resultMessage`, with the messages by language.  The report is canonicalised first, so the same report gives the same file.

With `REPORT_DEBUG_RESULTS` set, the report also has a result for each passed validation, with severity `shn:Debug` (`https://schemas.link/shacl-next#Debug`), which doesn't affect `sh:conforms`.  A report is then written for each validation shape a resource is validated against, also when it conforms.

## Tests
The tests check which resources the targets of a shape select, which rules apply to a resource, which data the generated queries retrieve and the validation per shape, without a triplestore.  Run them with `npm test`.

## API
### GET /health
Returns `{ "status": "ok" }` if the service is running.

#### Test API
The following endpoints are only available when `ENABLE_TEST_API` is set to true.

### GET /test/validate/:uri
Endpoint meant for testing during service development.  The service will determine the rules that apply to the resource with the given URI, and validate it against the validation shapes they link to.
