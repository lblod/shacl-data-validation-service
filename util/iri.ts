// The local name of an IRI, after its last '#', '/' or ':', with each
// disallowed character replaced by '_'. By default, letters, digits, '_' and
// '-' are allowed.
export function localName(iri: string, disallowed = /[^A-Za-z0-9_-]/g) {
  return iri.replace(/^.*[#/:]/, "").replace(disallowed, "_");
}
