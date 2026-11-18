// The namespaces of the vocabularies the service uses, to build IRIs from,
// e.g. PREFIXES.sh + "targetClass"
export const PREFIXES = {
  ext: "http://mu.semte.ch/vocabularies/ext/",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  sh: "http://www.w3.org/ns/shacl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
};

// Links a rule to the validation shapes the resources it applies to are
// validated against
export const VALIDATION_SHAPE_PREDICATE = PREFIXES.ext + "validationShape";
