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

### Environment variables.

|Name            |Description                           |Default value|
|----------------|--------------------------------------|-------------|
|KEEP_ALL_REPORTS|Whether to keep all generated reports.|false        |
|REPORT_CONTEXT_URL|The URL of the JSON-LD context of the validation reports, [served by the service](#get-contextsvalidation-reportjsonld) at `/contexts/validation-report.jsonld`.  Set it to the URL at which clients reach that endpoint.|`http://localhost:8897/contexts/validation-report.jsonld`|

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

A shape can extend the data graph with [SPARQL rules](https://www.w3.org/TR/shacl-af/#SPARQLRule): `generateRuleQueries` binds `$this` of the `sh:construct` query of each `sh:rule` to the resource, and the triples these queries construct on the store are added to the data graph before validation.

### Resource validation
This services determines against which SHACL node shapes a resource should be validated in two steps.  First, the applicable rules are determined for the resource at hand.  An initial selection of rules is done by selecting all those rules whose `sh:targetClass` specifies a resource type that corresponds to a type of the resource at hand.  This set of rules is then filtered to those rules to which the resource conforms.  For this, a `shacl-engine/Validator` is used to `validate` the resource against each individual rule.  Only rules for which the resulting validation report states the resource conforms are considered to be applicable to the resource at hand.

Second, the validation shapes linked by the applicable rules are collected, together with the validation shapes with a SPARQL-based target that selects a focus node in the resource.  The resource is validated against all of these shapes using a `shacl-engine/Validator` that receives as input these shapes as well as the resource at hand, and resolves SPARQL-based targets.  The validation report is return as is, currently without any further processing.

## API
### GET /health
Returns `{ "status": "ok" }` if the service is running.

### GET /test/validate/:uri
Endpoint meant for testing during service development.  The service will try to retrieve the data for the resource with the given URI and try to validate it according to the service's configuration.  The validation report also contains a result for each passed validation, with severity `shn:Debug` (`https://schemas.link/shacl-next#Debug`), which doesn't affect `sh:conforms`.  As SHACL gives such a result the message of its shape (`sh:message`), which describes the failure, the service replaces it with the message the shape has for a passed validation (`ext:conformsMessage`), if any.  The service also fills the variables of the result messages: `{?value}` with the value of the result, and `{?name}` with the values the value has for each property the shape lists with `ext:messagePath`, by the local name of the property, e.g. `{?nameOfTheProperty}`.

The report is returned as N-Triples by default.  With `Accept: application/ld+json`, it is returned as JSON-LD (see `reportJsonLd` in [lib/report.ts](lib/report.ts)).  Its `@context` is the URL of the [context of the reports](#get-contextsvalidation-reportjsonld) (`REPORT_CONTEXT_URL`), which gives the SHACL terms by their local name, e.g. `focusNode` for `sh:focusNode`:
- each validation result has a URI (`@id`), a hash of its focus node, source shape, constraint component and value, so it's the same in every validation of the same data;
- its source shape (`sourceShape`) has the name of the shape (`sh:name`);
- its messages (`resultMessage`) are given by language.

```json
{
  "@context": "http://localhost:8897/contexts/validation-report.jsonld",
  "@type": "sh:ValidationReport",
  "conforms": false,
  "result": [
    {
      "@id": "http://data.lblod.info/id/validation-results/22415884bbaa120c81588f9abc3005a0",
      "@type": "sh:ValidationResult",
      "focusNode": "https://lblod.zottegem.be/LBLODWeb/id/zittingen/0f4604fca3c84e8bb983b29d8abb1796-3011",
      "value": "https://lblod.zottegem.be/LBLODWeb/Home/Overzicht/e3d9480acc0cf400e11ab7afe2bcea144038dd2ef71d77247d5159c7ce8efb1a/GetPublication?filename=Notulen_Gemeenteraad_21-09-2026.html",
      "resultPath": "http://mu.semte.ch/vocabularies/ext/gecontroleerdeNotulen",
      "resultSeverity": "sh:Warning",
      "resultMessage": {
        "nl": "De Notulen in HTML met RDFa-annotaties die de Zitting bevatten, https://lblod.zottegem.be/LBLODWeb/Home/Overzicht/e3d9480acc0cf400e11ab7afe2bcea144038dd2ef71d77247d5159c7ce8efb1a/GetPublication?filename=Notulen_Gemeenteraad_21-09-2026.html, zijn niet gekoppeld (besluit:heeftNotulen): de Zitting koppelt https://lblod.zottegem.be/LBLODWeb/Home/Overzicht/e3d9480acc0cf400e11ab7afe2bcea144038dd2ef71d77247d5159c7ce8efb1a/GetPublication/?filename=Notulen_Gemeenteraad_21-09-2026_Notulen_Vlaanderen.pdf.",
        "en": "The Notulen HTML with RDFa annotations that contains the Zitting, https://lblod.zottegem.be/LBLODWeb/Home/Overzicht/e3d9480acc0cf400e11ab7afe2bcea144038dd2ef71d77247d5159c7ce8efb1a/GetPublication?filename=Notulen_Gemeenteraad_21-09-2026.html, are not linked (besluit:heeftNotulen): the Zitting links https://lblod.zottegem.be/LBLODWeb/Home/Overzicht/e3d9480acc0cf400e11ab7afe2bcea144038dd2ef71d77247d5159c7ce8efb1a/GetPublication/?filename=Notulen_Gemeenteraad_21-09-2026_Notulen_Vlaanderen.pdf instead."
      },
      "sourceShape": {
        "@id": "http://data.lblod.info/shapes/publicatieplicht#DocumentGepubliceerd-notulenNietAndersGekoppeld",
        "name": "sessionLinksWithExpectedDocumentURI"
      },
      "sourceConstraintComponent": "sh:NodeConstraintComponent"
    },
    …
  ]
}
```

With `Accept: application/vnd.api+json` or `Accept: application/json`, it is returned as a table, as [JSON:API](https://jsonapi.org/format/) (`application/vnd.api+json`, see `overviewJsonApi` in [lib/overview.ts](lib/overview.ts)), from the results the query [config/overview.rq](config/overview.rq) selects in the report:
- `data`: a row per focus node and value of the results (`overview-rows`), e.g. a document of a session, with a check per name of their source shapes (`checks`, see `sh:name`), e.g. `published`, and its validation results (`validationResults`).  A check has whether the value conforms to it, the most severe severity of its results if it doesn't, and the English messages of its failed results, or of all its results if it conforms.  Several results of a row with the same name make one check, e.g. of the shapes for whether a document is published on time and whether that can be checked.  The results without value, e.g. whether the session links a document of each type, make a row of the session;
- `included`: the validation results (`validation-results`), with their URI, the `@id` in the JSON-LD report, and the name of their source shape;
- `meta`: the resource, whether it conforms, and the names of the checks.

### GET /contexts/validation-report.jsonld
The JSON-LD context of the validation reports, [config/contexts/validation-report.jsonld](config/contexts/validation-report.jsonld), as `application/ld+json`.  The [test cases](#tests) use it too, for the terms of the SHACL test suite.  It's served with `Access-Control-Allow-Origin: *` so JSON-LD processors in browsers can fetch it.  The reports refer to it by `REPORT_CONTEXT_URL`.

### GET /test/data/:uri
Endpoint meant for testing during service development.  Returns the data the service retrieves for the resource with the given URI, i.e. the data `/test/validate/:uri` validates, as Turtle.  Used to add [test cases](#tests).

## Tests
The tests validate the data of resources against the service's configuration, without a triplestore.  Run them with `npm test`.

Each test case is a folder in `test/cases/` with
- `case.jsonld`: a manifest (`mf:Manifest`) like those of the [SHACL test suite](https://github.com/w3c/data-shapes/tree/gh-pages/data-shapes-test-suite), as JSON-LD.  Its entries (`mf:entries`) are validation tests (`sht:Validate`), each with
  - a label (`rdfs:label`): the short description of its validation shape (`sh:description`; the shape describes its checks more extensively in `rdfs:comment`);
  - its action (`mf:action`): the file with the data of a resource (`sht:dataGraph`), e.g. `data.ttl`, and the files that define the validation shapes the service should select for it (`sht:shapesGraph`), relative to `case.jsonld`;
  - the expected validation report (`mf:result`), like `/test/validate/:uri` returns it;
  - its status (`mf:status`): `sht:proposed`, `sht:approved` or `sht:rejected`, as in the test suite.  The tests run it whatever its status.

  Its `@context` is the URL of the context of the report (`REPORT_CONTEXT_URL`), which also has the prefixes `mf:` (`http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#`), `sht:` (`http://www.w3.org/ns/shacl-test#`) and `rdfs:`, so the keys are the prefixed names of the test suite, as in its Turtle files;
- the data of the resources (`sht:dataGraph`), e.g. `data.ttl`, as returned by `/test/data/:uri`, or written by hand as it would be in the store.
- optionally `overview.json`: the overview of the validation report as JSON:API, as `/test/validate/:uri` returns it with `Accept: application/json`.  The test compares the overview with it.

To add a test case for a resource, retrieve its data from a running service:

```sh
curl "http://localhost:8897/test/data/$(jq -rn --arg uri "$URI" '$uri|@uri')" > test/cases/<name>/data.ttl
```

The data returned by `/test/data/:uri` already contains the triples the SPARQL rules construct on the store. 
