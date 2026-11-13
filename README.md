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
The data of a resource is retrieved with queries generated from the validation shapes, see [lib/sparql-generation.ts](lib/sparql-generation.ts).  `generateTargetQuery` determines on the store which shapes have a target that selects the resource.  For each of those shapes, `generateConstructQuery` then generates a CONSTRUCT query for the data that shape needs: the triples its target selects on, the triples along its property paths, and the data of the shapes it refers to, such as `sh:node` and `sh:or`.  Only this data is retrieved, so a property the shape doesn't mention is not part of the data it is validated on.

The queries run through sudo, bypassing the authorization of mu-authorization, and don't specify a `GRAPH`, so they read the data from all graphs.

SPARQL-based constraints (`sh:sparql`) and SPARQL-based targets without a `sh:select` are not supported.  Negated property sets in the `sh:select` of a target are used to select the focus nodes, but their triples are not retrieved.

#### SPARQL rules
A validation shape can add triples to the data of a resource with [SPARQL rules](https://www.w3.org/TR/shacl-af/#SPARQLRule), for example to repair a link with a fragment that the shape would otherwise reject.  `generateRuleQueries` binds `$this` in the `sh:construct` query of each `sh:rule` of the shape to the resource.  These queries run on the store, through sudo like the other queries, and the triples they construct are added to the data before the resource is validated against that shape.  Only the rules of the shape being validated run.

```ttl
ext:documentShape a sh:NodeShape ;
  sh:targetClass ext:Document ;
  sh:property ext:hasSource ;
  sh:rule [
    a sh:SPARQLRule ;
    sh:construct """
      PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
      CONSTRUCT { $this ext:source ?source . }
      WHERE {
        $this ext:link ?link .
        BIND(IRI(REPLACE(STR(?link), "#.*$", "")) AS ?source)
      }"""
  ] .
```

Each rule runs on the store's data, so a rule doesn't see the triples other rules construct and `sh:order` has no effect.  The data query follows the property paths over the store's data as well: the data of a node that is only linked through a constructed triple is not retrieved.  Rules with a `sh:condition` are not supported, validating against such a shape gives an error, and triple rules (`sh:TripleRule`) are ignored.

### Resource validation
A resource is validated against each SHACL node shape that targets it, separately, on the data retrieved for that shape.  A `shacl-engine/Validator` receives the shape with the shapes it refers to, as well as the data, and only validates the resource.  It does not resolve the target of the shape again: the data can hold other resources the target selects, for example a value node of the same class, without the data needed to validate them.  The validation report is returned as is, currently without any further processing.

## Tests
The tests check which shapes target a resource, which data the generated queries retrieve and the validation per shape, without a triplestore.  Run them with `npm test`.

## API
### GET /health
Returns `{ "status": "ok" }` if the service is running.

#### Test API
The following endpoints are only available when `ENABLE_TEST_API` is set to true.

### GET /test/validate/:uri
Endpoint meant for testing during service development.  The service will try to retrieve the data for the resource with the given URI and try to validate it according to the service's configuration.
