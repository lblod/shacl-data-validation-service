// The template image provides mu, it isn't an npm package tests can resolve.
// These helpers are copied from helpers/mu/sparql.js in mu-javascript-template.

export function sparqlEscapeString(value: string) {
  return '"""' + value.replace(/[\\"]/g, (match) => "\\" + match) + '"""';
}

export function sparqlEscapeUri(value: string) {
  return "<" + value.replace(/[\\"<>]/g, (match) => "\\" + match) + ">";
}
