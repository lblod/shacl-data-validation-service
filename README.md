# SHACL data validation service

> [!Warning]
> This service is currently under construction.  Its API and data model are subject to change.

The SHACL data validation service provides functionality to validate data resources against [SHACL](https://www.w3.org/TR/shacl/) node shapes.  It can be configured with rules, also defined as SHACL node shapes, that specify to which resources they apply and which SHACL node shapes should be used to validate such resources.  This service uses the [shacl-engine](https://github.com/rdf-ext/shacl-engine) to perform the actual validations.

## Getting started
TODO

## Configuration
This services expects two kinds of configuration: 1) a set of rules describing which validations should be applied to certain resources; and 2) a set of SHACL node shapes used in the actual data validation.  The following subsection describes each of these.

The code snippets in the following sections assume the following prefixes to be defined.

```ttl
@prefix ext: <http://mu.semte.ch/vocabularies/ext/> .
@prefix org: <http://www.w3.org/ns/org#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix regorg: <http://www.w3.org/ns/regorg#> .
```

### Rules
The rules should be specified in a `RULES.ttl` file located in the `config` folder.  Each rule is a SHACL node shape that describes at least the resource type it applies to and the validation shapes that should be used to validate such resources.  For example, the following snippet specifies that all resources of type `org:Organization` should be validated against the `ext:organizationShape` node shape.  Note, the latter should be configured as described in [validation shapes section](#validation-shapes).

```ttl
ext:organizationRule a sh:NodeShape ;
  sh:targetClass org:Organization ;
  ext:validationShape ext:organizationShape .
```

A rule can specify property shapes to further refine to which instance of a resource type it applies.  For example, the following rules applies only to `org:Organization` resources that have the correct value for `regorg:orgStatus`.

```ttl
ext:activeOrganizationRule a sh:NodeShape ;
  sh:targetClass org:Organization ;
  sh:property [
    sh:path regorg:orgStatus ;
    sh:hasValue <http://lblod.data.gift/concepts/63cc561de9188d64ba5840a42ae8f0d6> ;
    ] ;
  ext:validationShape ext:organizationWithAltNameShape .
```

### Validation shapes
The SHACL node shapes used to actually validate data resources should be specified in turtle files in the `config/validation-shapes` folder.  The service will read and parse all turtle files in that folder on startup.

For more information on defining SHACL node shapes see the [SHACL](https://www.w3.org/TR/shacl/) recommendation or the example files in the configuration folder.

#### Validation shapes with a SPARQL-based target
A validation shape with a [SPARQL-based target](https://www.w3.org/TR/shacl-af/#SPARQLTarget) doesn't need a rule: its target selects the resources it applies to.  The target's query runs on the data of the resource at hand.  For example, the following shape only applies to sessions of a gemeenteraad.

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

The `publicatieplicht-*.ttl` files are the shapes of the publicatieplicht of [lib-publicatieplicht-validation](https://github.com/lblod/lib-publicatieplicht-validation): whether the bestuursorgaan holding a session (`besluit:Zitting`) published its agenda, besluitenlijst and notulen, and in time.  They are copies of the files in its `shapes` folder, keep them in sync.

### Environment variables.
At the current time, no environment variables are provided by the service.

## Methodology
### Resource retrieval
The triples of an `org:Organization` or `person:Person` resource are retrieved with hardcoded queries.  These queries are incomplete with respect to the full range of properties for such resources.

The triples of other resources, e.g. sessions (`besluit:Zitting`), are retrieved with CONSTRUCT queries generated from the rules and validation shapes by `generateConstructQuery` in [lib/sparql-generation.ts](lib/sparql-generation.ts), inspired by [SHACL Play's SHACL2SPARQL](https://shacl-play.sparna.fr/play/sparql).  Starting from the targets of the shapes (`sh:targetClass`, `sh:targetNode`, `sh:targetSubjectsOf`, `sh:targetObjectsOf` and SPARQL-based targets), restricted to the resource at hand (the `focusNodes` option), the query follows the property paths of the property shapes and recurses into the shapes their values have to conform to (`sh:node`, `sh:qualifiedValueShape`, `sh:and`, `sh:or`, `sh:xone`, `sh:not`).  It also retrieves the triples the targets select their focus nodes on, so the validator selects the same focus nodes in the retrieved data.  Values aren't filtered on `sh:hasValue` or `sh:in`, the validator needs the values violating them.  SPARQL-based constraints (`sh:sparql`) aren't supported.  The `sh:select` of SPARQL-based targets is parsed with [Traqula](https://github.com/comunica/traqula).

```ts
const query = generateConstructQuery(VALIDATION_SHAPES, {
  shapes: ["http://data.lblod.info/shapes/publicatieplicht#GemeenteraadAgenda"],
  focusNodes: [sessionUri],
});
```

Only the rules and validation shapes targeting the resource are used.  `generateTargetQuery` generates a SELECT query checking the targets of the shapes (`sh:targetNode`, `sh:targetClass`, SPARQL-based targets, …) for the resource in the store, before the data of the matching shapes is retrieved.

The SPARQL-based target of a validation shape can select focus nodes other than the resource in its data, e.g. the documents linked by a session instead of the session itself.  The data these shapes need for those focus nodes is retrieved with generated queries as well, until the targets don't select new focus nodes.

A shape can repair the data graph with [SPARQL rules](https://www.w3.org/TR/shacl-af/#SPARQLRule): `generateRuleQueries` binds `$this` of the `sh:construct` query of each `sh:rule` to the resource, and the triples these queries construct on the store are added to the data graph before validation.  For example, the harvester pipeline links the entities it harvests with the URI of the page it harvested them from (`prov:wasDerivedFrom`), and that URI doesn't always match the URI the publisher links the document with.  E.g. a session links its agenda as `…/Agenda.html#Agenda3030`, while its entities are derived from `…/Agenda.html`.  The following rule counts entities derived from the linked URI without fragment as derived from the linked agenda:

```ttl
pp:AgendaVoorZitting sh:rule [
  a sh:SPARQLRule ;
  sh:construct """
    PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
    PREFIX prov: <http://www.w3.org/ns/prov#>
    CONSTRUCT {
      ?entity prov:wasDerivedFrom ?agenda .
    } WHERE {
      $this besluit:heeftAgenda ?agenda .
      FILTER(CONTAINS(STR(?agenda), "#"))
      BIND(IRI(STRBEFORE(STR(?agenda), "#")) AS ?source)
      ?entity prov:wasDerivedFrom ?source .
    }"""
] .
```

The actual rule of `pp:AgendaVoorZitting`, in [publicatieplicht-agenda-voor-zitting.ttl](config/validation-shapes/publicatieplicht-agenda-voor-zitting.ttl), also ignores a `/` before the `?` in the URI.

### Resource validation
This services determines against which SHACL node shapes a resource should be validated in two steps.  First, the applicable rules are determined for the resource at hand.  An initial selection of rules is done by selecting all those rules whose `sh:targetClass` specifies a resource type that corresponds to a type of the resource at hand.  This set of rules is then filtered to those rules to which the resource conforms.  For this, a `shacl-engine/Validator` is used to `validate` the resource against each individual rule.  Only rules for which the resulting validation report states the resource conforms are considered to be applicable to the resource at hand.

Second, the validation shapes linked by the applicable rules are collected, together with the validation shapes with a SPARQL-based target that selects a focus node in the resource.  The resource is validated against all of these shapes using a `shacl-engine/Validator` that receives as input these shapes as well as the resource at hand, and resolves SPARQL-based targets.  The validation report is return as is, currently without any further processing.

## API
### GET /health
Returns `{ "status": "ok" }` if the service is running.

### GET /test/validate/:uri
Endpoint meant for testing during service development.  The service will try to retrieve the data for the resource with the given URI and try to validate it according to the service's configuration.

### GET /test/data/:uri
Endpoint meant for testing during service development.  Returns the data the service retrieves for the resource with the given URI, i.e. the data `/test/validate/:uri` validates, as Turtle.  Used to add [test cases](#tests).

## Tests
The tests validate the data of resources against the service's configuration, without a triplestore.  Run them with `npm test`.

Each test case is a folder in `test/cases/` with two files:
- `data.ttl`: the data of the resource, as returned by `/test/data/:uri`;
- `case.json`: the resource, the URIs of the validation shapes the service should select for it, and the expected validation result.

```json
{
  "description": "Zitting van de gemeenteraad zonder gegevens afgeleid van de gekoppelde agenda's: de agenda is niet gepubliceerd.",
  "resource": "https://lblod.zottegem.be/LBLODWeb/id/zittingen/0f4604fca3c84e8bb983b29d8abb1796-3011",
  "shapes": ["http://data.lblod.info/shapes/publicatieplicht#AgendaVoorZitting"],
  "expected": {
    "conforms": false,
    "results": [
      {
        "focusNode": "https://lblod.zottegem.be/LBLODWeb/id/zittingen/0f4604fca3c84e8bb983b29d8abb1796-3011",
        "sourceShape": "http://data.lblod.info/shapes/publicatieplicht#AgendaVoorZitting-gepubliceerd",
        "severity": "http://www.w3.org/ns/shacl#Violation"
      }
    ]
  }
}
```

The test checks that the service selects exactly the given validation shapes for the data (through the rules and the SPARQL-based targets), and that the validation report conforms as expected.  If `expected.results` is given, the validation results of the report (focus node, source shape and severity) must match it as well.

To add a test case for a resource, retrieve its data from a running service:

```sh
curl "http://localhost:8897/test/data/$(jq -rn --arg uri "$URI" '$uri|@uri')" > test/cases/<name>/data.ttl
```

The SPARQL rules (`sh:rule`) of the shapes are applied when the data is retrieved, so `data.ttl` already contains the triples they construct.
