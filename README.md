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

### Environment variables.

|Name            |Description                           |Default value|
|----------------|--------------------------------------|-------------|
|KEEP_ALL_REPORTS|Whether to keep all generated reports.|false        |

## Methodology
### Resource retrieval
Currently, retrieving the appropriate triples for a given resource (type) consists of hardcoded queries.  In the future this will be made more dynamic, for example by automatically querying the appropriate data based on the information in the rules and validation shapes.

At the time of writing only queries for `org:Organization` and `person:Person` resources are provided.  Furthermore, these queries are incomplete with respect to the full range of properties for such resources.

### Resource validation
This services determines against which SHACL node shapes a resource should be validated in two steps.  First, the applicable rules are determined for the resource at hand.  An initial selection of rules is done by selecting all those rules whose `sh:targetClass` specifies a resource type that corresponds to a type of the resource at hand.  This set of rules is then filtered to those rules to which the resource conforms.  For this, a `shacl-engine/Validator` is used to `validate` the resource against each individual rule.  Only rules for which the resulting validation report states the resource conforms are considered to be applicable to the resource at hand.

Second, the validation shapes linked by the applicable rules are collected.  The resource is validated against all of these shapes using a `shacl-engine/Validator` that receives as input these shapes as well as the resource at hand.  The validation report is return as is, currently without any further processing.

## API
### GET /health
Returns `{ "status": "ok" }` if the service is running.

### GET /test/validate/:uri
Endpoint meant for testing during service development.  The service will try to retrieve the data for the resource with the given URI and try to validate it according to the service's configuration.
