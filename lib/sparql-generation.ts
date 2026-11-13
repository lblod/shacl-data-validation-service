import type { Term } from "@rdfjs/types";
import { Generator } from "@traqula/generator-sparql-1-1";
import { Parser } from "@traqula/parser-sparql-1-1";
import {
  AstFactory,
  lex,
  type QueryConstruct,
  type QuerySelect,
} from "@traqula/rules-sparql-1-1";
import { sparqlEscapeString, sparqlEscapeUri } from "mu";
import rdf from "rdf-ext";
import { PREFIXES } from "../constants";
import { getObjects } from "../util/rdf-ext-helpers";

/*
 * Generates SPARQL queries from SHACL shapes:
 * - a SELECT query for the shapes whose targets select a resource, so the shapes
 *   that are relevant for a resource are determined from their target
 *   configuration
 * - a CONSTRUCT query retrieving the data needed to validate resources against
 *   those shapes, inspired by SHACL Play's SHACL2SPARQL
 *   (https://shacl-play.sparna.fr/play/sparql)
 * - the CONSTRUCT queries of the SPARQL rules of those shapes (sh:rule), with
 *   $this bound to the resource, to add the triples they construct to its data
 *
 * Starting from the focus nodes of a shape (its targets), the CONSTRUCT query
 * follows the sh:path of its property shapes and recurses into the shapes their
 * value nodes have to conform to (sh:node, sh:qualifiedValueShape, sh:and, sh:or,
 * sh:xone, sh:not). It retrieves:
 * - the triples the targets of the shapes are selected on, so the validator
 *   selects the same focus nodes in the retrieved data
 * - the triples along the property paths, including sequence, alternative,
 *   inverse, zero-or-more, one-or-more and zero-or-one paths
 * - the rdf:type and rdfs:subClassOf* of value nodes with a sh:class constraint
 * - all triples of focus nodes of a sh:closed shape
 * - the values of the properties of sh:equals, sh:disjoint, sh:lessThan and
 *   sh:lessThanOrEqual
 *
 * Unlike SHACL Play, sh:hasValue and sh:in don't filter the retrieved values:
 * the values violating those constraints are exactly the ones the validator
 * has to see.
 *
 * Every target, and every way to reach data, is a branch of a UNION. A branch
 * only consists of plain graph patterns and subqueries, restricted to the focus
 * nodes, which keeps the variables of a branch bound when they are used in a
 * BIND or FILTER and lets the endpoint evaluate each branch from the focus nodes.
 * Every branch has its own variables: a CONSTRUCT template is instantiated for
 * every solution binding its variables, sharing variables would construct
 * triples of one branch out of the solutions of another (e.g. ?s <p> ?o out of a
 * solution of ?s (<p>|<q>) ?o matching <q>).
 *
 * Not supported: SPARQL-based constraints (sh:sparql) and SPARQL-based targets
 * without a sh:select. Negated property sets in the sh:select of a target are
 * used to select the focus nodes, but their triples are not retrieved. SPARQL
 * rules with a sh:condition and triple rules (sh:TripleRule).
 */

const XSD_BOOLEAN = PREFIXES.xsd + "boolean";
const XSD_STRING = PREFIXES.xsd + "string";

const TARGET_PREDICATES = [
  "targetClass",
  "targetNode",
  "targetSubjectsOf",
  "targetObjectsOf",
  "target",
];
const PAIR_PREDICATES = ["equals", "disjoint", "lessThan", "lessThanOrEqual"];
const LOGICAL_LIST_PREDICATES = ["and", "or", "xone"];

// Traqula parsers are expensive to create, a parser is reused for all queries
const parser = new Parser();
const generator = new Generator();
const F = new AstFactory();
// Traqula only generates whole queries, patterns are generated in this query
const PATTERN_QUERY = parser.parse("SELECT * WHERE {}") as QuerySelect;

type Path =
  | { type: "predicate"; iri: string; inverse: boolean }
  | { type: "sequence" | "alternative"; paths: Path[] }
  | { type: "zeroOrMore" | "oneOrMore" | "zeroOrOne"; path: Path };

const CLOSURE_OPERATORS = { zeroOrMore: "*", oneOrMore: "+", zeroOrOne: "?" };

// A variable, by its id, which gets its name when its branch is rendered
type VariableNode = { variable: string };

// A node of a graph pattern: a variable or a constant in SPARQL syntax
type QueryNode = VariableNode | { constant: string };

// Part of a query, rendered with the names of the variables of its branch
type Fragment = (name: (variable: string) => string) => string;

// Graph patterns, the triples they retrieve (CONSTRUCT template) and the node
// they end in, e.g. the value nodes of a property path
type Branch = { patterns: Fragment[]; templates: Fragment[]; end: QueryNode };

// The patterns selecting the focus nodes of a target and the branches
// retrieving the triples it selects them on
type Target = { select: Fragment[]; data: Branch[] };

// A target for a focus node variable
type CreateTarget = (focus: VariableNode, focusNodes?: Term[]) => Target;

export type SparqlGenerationOptions = {
  // The shapes to check or retrieve data for, by default all shapes with a
  // target
  shapes?: (string | Term)[];
  // Restricts the focus nodes of the shapes to these nodes, e.g. the resource
  // being validated. Shapes without a target apply to these nodes.
  focusNodes?: (string | Term)[];
  // Graph to select the focus nodes and retrieve the data in
  graph?: string;
  // Maximum number of nested shapes to follow from a shape
  maxDepth?: number;
};

// An IRI as SPARQL's IRIREF allows it, using Traqula's lexer pattern
const IRIREF = new RegExp(`^${lex.patterns.iriRefPattern.source}$`);
const VALID_LANGUAGE = /^[A-Za-z]+(-[A-Za-z0-9]+)*$/;

function validIri(value: string) {
  if (!IRIREF.test(`<${value}>`)) throw new Error(`Invalid IRI ${value}`);
  return value;
}

function validLanguage(value: string) {
  if (!VALID_LANGUAGE.test(value)) {
    throw new Error(`Invalid language tag ${value}`);
  }
  return value;
}

const iriToString = (value: string) => sparqlEscapeUri(validIri(value));

function literalToString(
  value: string,
  langOrDatatype?: string | { value: string },
) {
  // sparqlEscapeString keeps line breaks, which indenting the query would change
  const lexical = sparqlEscapeString(value)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  if (typeof langOrDatatype === "string") {
    return `${lexical}@${validLanguage(langOrDatatype)}`;
  }
  if (!langOrDatatype || langOrDatatype.value === XSD_STRING) return lexical;
  return `${lexical}^^${iriToString(langOrDatatype.value)}`;
}

// An RDF/JS term, e.g. of the shapes, in SPARQL syntax
function termToString(term: Term) {
  switch (term.termType) {
    case "NamedNode":
      return iriToString(term.value);
    case "BlankNode":
      return `_:${term.value}`;
    case "Literal":
      return literalToString(term.value, term.language || term.datatype);
    default:
      throw new Error(`Unsupported term ${term.value}`);
  }
}

// An RDF/JS term as a term of a Traqula AST
function termToAst(term: Term) {
  if (term.termType !== "Literal") {
    return F.termNamed(F.gen(), validIri(term.value));
  }
  if (term.language) {
    return F.termLiteral(F.gen(), term.value, validLanguage(term.language));
  }
  if (term.datatype.value === XSD_STRING)
    return F.termLiteral(F.gen(), term.value);
  return F.termLiteral(
    F.gen(),
    term.value,
    F.termNamed(F.gen(), validIri(term.datatype.value)),
  );
}

// A term of a Traqula AST, after expanding prefixes and renaming blank nodes
// to variables
function astTermToNode(term): QueryNode {
  switch (term.subType) {
    case "variable":
      return { variable: term.value };
    case "namedNode":
      return { constant: iriToString(term.value) };
    case "literal":
      return { constant: literalToString(term.value, term.langOrIri) };
    default:
      throw new Error(`Unsupported term ${term.subType} ${term.value}`);
  }
}

// A pattern of a Traqula AST, generated as the body of PATTERN_QUERY
function patternToString(pattern): string {
  const query = generator.generate({
    ...PATTERN_QUERY,
    where: F.patternGroup([pattern], F.gen()),
  });
  return query
    .slice(query.indexOf("{") + 1, query.lastIndexOf("}"))
    .replace(/^\n|\n$/g, "")
    .replace(/^ {2}/gm, "");
}

const nodeToString = (node: QueryNode, name: (variable: string) => string) =>
  "variable" in node ? `?${name(node.variable)}` : node.constant;
const toTerm = (value: string | Term) =>
  typeof value === "string" ? rdf.namedNode(value) : value;

const predicatePath = (value: string): Path => ({
  type: "predicate",
  iri: value,
  inverse: false,
});
// rdf:type/rdfs:subClassOf*, the path sh:targetClass and sh:class rely on
const TYPE_PATH: Path = {
  type: "sequence",
  paths: [
    predicatePath(PREFIXES.rdf + "type"),
    { type: "zeroOrMore", path: predicatePath(PREFIXES.rdfs + "subClassOf") },
  ],
};

// Inverse paths are pushed down to their predicates, e.g. ^(p/q) is ^q/^p
function invertPath(path: Path): Path {
  switch (path.type) {
    case "predicate":
      return { ...path, inverse: !path.inverse };
    case "sequence":
      return { type: "sequence", paths: path.paths.map(invertPath).reverse() };
    case "alternative":
      return { type: "alternative", paths: path.paths.map(invertPath) };
    default:
      return { type: path.type, path: invertPath(path.path) };
  }
}

function pathToString(path: Path): string {
  switch (path.type) {
    case "predicate":
      return (path.inverse ? "^" : "") + iriToString(path.iri);
    case "sequence":
      return `(${path.paths.map(pathToString).join("/")})`;
    case "alternative":
      return `(${path.paths.map(pathToString).join("|")})`;
    default:
      return `(${pathToString(path.path)})${CLOSURE_OPERATORS[path.type]}`;
  }
}

function triplePattern(
  subject: QueryNode,
  predicate: QueryNode,
  object: QueryNode,
): Fragment {
  return (name) =>
    `${nodeToString(subject, name)} ${nodeToString(predicate, name)} ${nodeToString(object, name)} .`;
}

function joinBranches(first: Branch, second: Branch): Branch {
  return {
    patterns: [...first.patterns, ...second.patterns],
    templates: [...first.templates, ...second.templates],
    end: second.end,
  };
}

// Every branch followed by every branch next creates from it
function branchProduct(branches: Branch[], next: (branch: Branch) => Branch[]) {
  return branches.flatMap((branch) =>
    next(branch).map((nextBranch) => joinBranches(branch, nextBranch)),
  );
}

const emptyBranch = (end: QueryNode): Branch => ({
  patterns: [],
  templates: [],
  end,
});

// The end of the patterns of a SPARQL-based target: nothing continues from it
const NO_END: QueryNode = { constant: "" };

// VALUES restricting a focus node variable to the given focus nodes, if any
function focusNodeRestriction(
  focus: VariableNode,
  focusNodes?: Term[],
): Fragment[] {
  if (!focusNodes) return [];
  const values = focusNodes.map(termToString).join(" ");
  return [(name) => `VALUES ${nodeToString(focus, name)} { ${values} }`];
}

// Copies a Traqula AST, replacing the nodes replace returns a node for
function transformAst(astNode, replace: (astNode) => unknown) {
  if (Array.isArray(astNode)) {
    return astNode.map((item) => transformAst(item, replace));
  }
  if (!astNode || typeof astNode !== "object") return astNode;
  const replacement = replace(astNode);
  if (replacement !== undefined) return replacement;
  return Object.fromEntries(
    Object.entries(astNode).map(([key, value]) => [
      key,
      transformAst(value, replace),
    ]),
  );
}

// Renames the variables, and blank nodes, which act as variables, in a
// Traqula AST
function renameVariables(ast, rename: (variable: string) => string) {
  let anonymous = 0;
  const replace = (astNode) => {
    if (astNode.type === "term" && astNode.subType === "variable") {
      return F.termVariable(rename(astNode.value), astNode.loc);
    }
    if (astNode.type === "term" && astNode.subType === "blankNode") {
      const label = astNode.label ?? `anonymous_${++anonymous}`;
      return F.termVariable(rename(`_:${label}`), astNode.loc);
    }
    // The rows of VALUES are keyed by variable name, e.g. { x: <a> }
    if (astNode.type === "pattern" && astNode.subType === "values") {
      return F.patternValues(
        transformAst(astNode.variables, replace),
        astNode.values.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [rename(key), value]),
          ),
        ),
        astNode.loc,
      );
    }
    return undefined;
  };
  return transformAst(ast, replace);
}

// Replaces prefixed names by full IRIs: a subquery can't declare prefixes
function expandPrefixes(ast, prefixes: Record<string, string>) {
  return transformAst(ast, (astNode) => {
    if (
      astNode.type === "term" &&
      astNode.subType === "namedNode" &&
      astNode.prefix !== undefined
    ) {
      if (!(astNode.prefix in prefixes)) {
        throw new Error(`Undeclared prefix ${astNode.prefix}:`);
      }
      return F.termNamed(astNode.loc, prefixes[astNode.prefix] + astNode.value);
    }
    return undefined;
  });
}

class SparqlGenerator {
  shapes;
  maxDepth: number;
  variableCount = 0;

  constructor(shapes, maxDepth = 10) {
    this.shapes = shapes;
    this.maxDepth = maxDepth;
  }

  createVariable(hint: string): VariableNode {
    const name =
      hint.replace(/^.*[#/:]/, "").replace(/[^A-Za-z0-9_]/g, "_") || "v";
    return { variable: `${name}_${++this.variableCount}` };
  }

  getObjects(subject, predicate: string) {
    return getObjects(this.shapes, subject, predicate);
  }

  hasTrueValue(subject, predicate: string) {
    return this.getObjects(subject, predicate).some(
      (object) =>
        object.value === "true" && object.datatype?.value === XSD_BOOLEAN,
    );
  }

  getListItems(list) {
    const items = [];
    let listNode = list;
    while (listNode && listNode.value !== PREFIXES.rdf + "nil") {
      const [first] = this.getObjects(listNode, PREFIXES.rdf + "first");
      if (!first) throw new Error(`${listNode.value} is not an RDF list`);
      items.push(first);
      [listNode] = this.getObjects(listNode, PREFIXES.rdf + "rest");
    }
    return items;
  }

  // The path of a sh:path
  parseShaclPath(shaclPath): Path {
    if (
      shaclPath.termType === "NamedNode" &&
      shaclPath.value !== PREFIXES.rdf + "nil"
    ) {
      return predicatePath(shaclPath.value);
    }
    if (this.getObjects(shaclPath, PREFIXES.rdf + "first").length) {
      return {
        type: "sequence",
        paths: this.getListItems(shaclPath).map((item) =>
          this.parseShaclPath(item),
        ),
      };
    }
    const [inverse] = this.getObjects(shaclPath, PREFIXES.sh + "inversePath");
    if (inverse) return invertPath(this.parseShaclPath(inverse));
    const [alternatives] = this.getObjects(
      shaclPath,
      PREFIXES.sh + "alternativePath",
    );
    if (alternatives) {
      return {
        type: "alternative",
        paths: this.getListItems(alternatives).map((item) =>
          this.parseShaclPath(item),
        ),
      };
    }
    for (const type of Object.keys(CLOSURE_OPERATORS)) {
      const [path] = this.getObjects(shaclPath, `${PREFIXES.sh}${type}Path`);
      if (path) {
        return { type, path: this.parseShaclPath(path) } as Path;
      }
    }
    throw new Error(`Unsupported SHACL path ${shaclPath.value}`);
  }

  /*
   * The branches following a path from start. Each branch ends in a fresh
   * variable for the nodes the path reaches, or in end when given.
   */
  getPathBranches(path: Path, start: QueryNode, end?: QueryNode): Branch[] {
    switch (path.type) {
      case "predicate": {
        const target = end ?? this.createVariable(path.iri);
        const predicate = { constant: iriToString(path.iri) };
        const pattern = path.inverse
          ? triplePattern(target, predicate, start)
          : triplePattern(start, predicate, target);
        return [{ patterns: [pattern], templates: [pattern], end: target }];
      }
      case "sequence":
        return path.paths.reduce(
          (branches, step, index) =>
            branchProduct(branches, (branch) =>
              this.getPathBranches(
                step,
                branch.end,
                index === path.paths.length - 1 ? end : undefined,
              ),
            ),
          [emptyBranch(start)],
        );
      case "alternative":
        return this.getAlternativeBranches(path.paths, start, end);
      case "zeroOrOne":
        return [
          this.getZeroLengthBranch(start, end),
          ...this.getPathBranches(path.path, start, end),
        ];
      case "zeroOrMore":
        return [
          this.getZeroLengthBranch(start, end),
          ...this.getOneOrMoreBranches(path.path, start, end),
        ];
      case "oneOrMore":
        return this.getOneOrMoreBranches(path.path, start, end);
    }
  }

  // Predicates share a branch per direction, other alternatives have their own
  getAlternativeBranches(paths: Path[], start: QueryNode, end?: QueryNode) {
    const branches = [];
    for (const inverse of [false, true]) {
      const iris = paths.flatMap((path) =>
        path.type === "predicate" && path.inverse === inverse ? [path.iri] : [],
      );
      if (iris.length) {
        branches.push(
          this.getAlternativePredicatesBranch(iris, inverse, start, end),
        );
      }
    }
    for (const path of paths) {
      if (path.type !== "predicate") {
        branches.push(...this.getPathBranches(path, start, end));
      }
    }
    return branches;
  }

  // Alternative predicates in a single branch, e.g. p|q as ?s ?predicate ?o
  // with VALUES ?predicate { p q }: the template only constructs the triple
  // matched, with the predicate it is matched with
  getAlternativePredicatesBranch(
    iris: string[],
    inverse: boolean,
    start: QueryNode,
    end?: QueryNode,
  ): Branch {
    if (iris.length === 1) {
      return this.getPathBranches(
        { type: "predicate", iri: iris[0], inverse },
        start,
        end,
      )[0];
    }
    const target = end ?? this.createVariable(iris[0]);
    const property = this.createVariable("predicate");
    const values = iris.map(iriToString).join(" ");
    const pattern = inverse
      ? triplePattern(target, property, start)
      : triplePattern(start, property, target);
    return {
      patterns: [
        (name) => `VALUES ${nodeToString(property, name)} { ${values} }`,
        pattern,
      ],
      templates: [pattern],
      end: target,
    };
  }

  // A zero length path ends in the start node itself, without patterns
  getZeroLengthBranch(start: QueryNode, end?: QueryNode): Branch {
    if (!end) return emptyBranch(start);
    return {
      patterns: [
        (name) =>
          `FILTER(sameTerm(${nodeToString(start, name)}, ${nodeToString(end, name)}))`,
      ],
      templates: [],
      end,
    };
  }

  /*
   * A step of path+ from every node path* reaches, which retrieves every triple
   * along the way. With an end, only the steps on a route to the end are
   * followed: every step has to be retrieved, not only the last one.
   */
  getOneOrMoreBranches(
    path: Path,
    start: QueryNode,
    end?: QueryNode,
  ): Branch[] {
    const via = this.createVariable("via");
    const closure: Branch = {
      patterns: [
        (name) =>
          `${nodeToString(start, name)} ${pathToString(path)}* ${nodeToString(via, name)} .`,
      ],
      templates: [],
      end: via,
    };
    if (!end) {
      return branchProduct([closure], () => this.getPathBranches(path, via));
    }
    const next = this.createVariable("next");
    const toEnd: Branch = {
      patterns: [
        (name) =>
          `${nodeToString(next, name)} ${pathToString(path)}* ${nodeToString(end, name)} .`,
      ],
      templates: [],
      end,
    };
    return branchProduct(
      branchProduct([closure], () => this.getPathBranches(path, via, next)),
      () => [toEnd],
    );
  }

  /*
   * The branches retrieving the data to validate the focus nodes against a
   * shape. visited holds the shapes being followed, to stop at cycles.
   */
  getShapeBranches(shape, focus: QueryNode, visited: string[]): Branch[] {
    const key = `${shape.termType}:${shape.value}`;
    if (
      visited.includes(key) ||
      this.hasTrueValue(shape, PREFIXES.sh + "deactivated")
    ) {
      return [];
    }
    if (visited.length >= this.maxDepth) {
      console.warn(
        `Not retrieving the data of ${shape.value}: it is nested deeper than ${this.maxDepth} shapes`,
      );
      return [];
    }
    const followed = [...visited, key];

    const [path] = this.getObjects(shape, PREFIXES.sh + "path");
    if (!path) {
      return [
        ...this.getValueNodeBranches(shape, focus, followed),
        ...this.getPairBranches(shape, focus),
        ...this.getObjects(shape, PREFIXES.sh + "property").flatMap(
          (property) => this.getShapeBranches(property, focus, followed),
        ),
      ];
    }
    return [
      ...this.getPathBranches(this.parseShaclPath(path), focus).flatMap(
        (branch) => [
          branch,
          ...branchProduct([branch], () =>
            this.getValueNodeBranches(shape, branch.end, followed),
          ),
        ],
      ),
      ...this.getPairBranches(shape, focus),
    ];
  }

  // The data the constraints on the value nodes of a shape need
  getValueNodeBranches(shape, value: QueryNode, followed: string[]): Branch[] {
    const branches = [];
    if (this.getObjects(shape, PREFIXES.sh + "class").length) {
      branches.push(...this.getPathBranches(TYPE_PATH, value));
    }
    if (this.hasTrueValue(shape, PREFIXES.sh + "closed")) {
      const property = this.createVariable("property");
      const object = this.createVariable("object");
      const pattern = triplePattern(value, property, object);
      branches.push({ patterns: [pattern], templates: [pattern], end: object });
    }
    const nestedShapes = [
      ...this.getObjects(shape, PREFIXES.sh + "node"),
      ...this.getObjects(shape, PREFIXES.sh + "not"),
      ...this.getObjects(shape, PREFIXES.sh + "qualifiedValueShape"),
      ...LOGICAL_LIST_PREDICATES.flatMap((logical) =>
        this.getObjects(shape, PREFIXES.sh + logical).flatMap((list) =>
          this.getListItems(list),
        ),
      ),
    ];
    for (const nestedShape of nestedShapes) {
      branches.push(...this.getShapeBranches(nestedShape, value, followed));
    }
    return branches;
  }

  // Property pair constraints compare the value nodes with the values of a
  // property of the focus node
  getPairBranches(shape, focus: QueryNode): Branch[] {
    return PAIR_PREDICATES.flatMap((pair) =>
      this.getObjects(shape, PREFIXES.sh + pair).flatMap((property) =>
        this.getPathBranches(predicatePath(property.value), focus),
      ),
    );
  }

  isClass(shape) {
    return (
      this.shapes.match(
        shape,
        rdf.namedNode(PREFIXES.rdf + "type"),
        rdf.namedNode(PREFIXES.rdfs + "Class"),
      ).size > 0
    );
  }

  // The targets of a shape
  getTargets(shape): CreateTarget[] {
    return [
      ...this.getClassTargets(shape),
      ...this.getNodeTargets(shape),
      ...this.getPropertyTargets(shape),
      ...this.getSparqlTargets(shape),
    ];
  }

  // sh:targetClass, and implicit class targets: a shape that is also a class
  getClassTargets(shape): CreateTarget[] {
    const classes = this.getObjects(shape, PREFIXES.sh + "targetClass");
    if (this.isClass(shape)) classes.push(shape);
    return classes.map((targetClass) => (focus) => ({
      select: [
        (name) =>
          `${nodeToString(focus, name)} ${pathToString(TYPE_PATH)} ${termToString(targetClass)} .`,
      ],
      data: this.getPathBranches(TYPE_PATH, focus, {
        constant: termToString(targetClass),
      }),
    }));
  }

  // sh:targetNode
  getNodeTargets(shape): CreateTarget[] {
    const nodes = this.getObjects(shape, PREFIXES.sh + "targetNode");
    if (!nodes.length) return [];
    const values = nodes.map(termToString).join(" ");
    return [
      (focus) => ({
        select: [(name) => `VALUES ${nodeToString(focus, name)} { ${values} }`],
        data: [],
      }),
    ];
  }

  /*
   * sh:targetSubjectsOf and sh:targetObjectsOf. These select their focus nodes
   * in a subquery, which restricts them to the given focus nodes as well, so
   * the endpoint doesn't select the focus nodes of the whole store first.
   */
  getPropertyTargets(shape): CreateTarget[] {
    const subjectsOf = this.getObjects(
      shape,
      PREFIXES.sh + "targetSubjectsOf",
    ).map((property) => predicatePath(property.value));
    const objectsOf = this.getObjects(
      shape,
      PREFIXES.sh + "targetObjectsOf",
    ).map((property) => invertPath(predicatePath(property.value)));
    return [...subjectsOf, ...objectsOf].map((path) => (focus, focusNodes) => ({
      select: [
        (name) => {
          const values = focusNodeRestriction(focus, focusNodes).map(
            (pattern) => pattern(name),
          );
          const variable = nodeToString(focus, name);
          return `{ SELECT DISTINCT ${variable} WHERE { ${[...values, ""].join(" ")}${variable} ${pathToString(path)} [] . } }`;
        },
      ],
      data: this.getPathBranches(path, focus),
    }));
  }

  // SPARQL-based targets with a sh:select
  getSparqlTargets(shape): CreateTarget[] {
    return this.getObjects(shape, PREFIXES.sh + "target").flatMap((target) => {
      const [select] = this.getObjects(target, PREFIXES.sh + "select");
      if (!select) return [];
      const createTarget: CreateTarget = (focus, focusNodes) =>
        this.getSparqlTarget(target, select.value, focus, focusNodes);
      return [createTarget];
    });
  }

  /*
   * A SPARQL-based target selects its focus nodes with a subquery, restricted
   * to the given focus nodes as well. The triples it selects them on are
   * retrieved by flattening its graph patterns into branches.
   */
  getSparqlTarget(
    target,
    select: string,
    focus: VariableNode,
    focusNodes?: Term[],
  ): Target {
    // sh:select holds a SELECT query
    const parsed: QuerySelect = this.parseQuery(target, select);
    const ids = new Map<string, string>();
    const query = renameVariables(parsed, (variable) => {
      if (variable === "this") return focus.variable;
      if (!ids.has(variable)) {
        ids.set(variable, this.createVariable(variable).variable);
      }
      return ids.get(variable);
    });
    const where = query.where.patterns;
    if (focusNodes) {
      const values = F.patternValues(
        [F.termVariable(focus.variable, F.gen())],
        focusNodes.map((term) => ({ [focus.variable]: termToAst(term) })),
        F.gen(),
      );
      query.where = F.patternGroup([values, ...where], query.where.loc);
    }
    return {
      select: [
        (name) =>
          `{\n  ${generator.generate(renameVariables(query, name)).replace(/\n/g, "\n  ")}\n}`,
      ],
      data: this.flattenPatterns(where),
    };
  }

  /*
   * Parses the query of a SPARQL-based target or rule, with the prefixes it
   * declares in sh:prefixes and in the query itself expanded to full IRIs
   */
  parseQuery(node, queryString: string) {
    const prefixes = this.getPrefixes(node);
    const parsed = parser.parse(queryString, { prefixes }) as
      QuerySelect | QueryConstruct;
    for (const declaration of parsed.context) {
      if (declaration.subType === "prefix") {
        prefixes[declaration.key] = declaration.value.value;
      }
    }
    return expandPrefixes({ ...parsed, context: [] }, prefixes);
  }

  // The prefixes declared for a SPARQL-based target or rule
  // (sh:prefixes/sh:declare)
  getPrefixes(node) {
    const prefixes: Record<string, string> = {};
    const prefixLists = this.getObjects(node, PREFIXES.sh + "prefixes");
    for (const declarations of prefixLists) {
      const declared = this.getObjects(declarations, PREFIXES.sh + "declare");
      for (const declaration of declared) {
        const [prefix] = this.getObjects(declaration, PREFIXES.sh + "prefix");
        const [namespace] = this.getObjects(
          declaration,
          PREFIXES.sh + "namespace",
        );
        if (prefix && namespace) prefixes[prefix.value] = namespace.value;
      }
    }
    return prefixes;
  }

  flattenPatterns(patterns): Branch[] {
    return patterns.reduce(
      (branches, pattern) =>
        branchProduct(branches, () => this.flattenPattern(pattern)),
      [emptyBranch(NO_END)],
    );
  }

  // OPTIONAL becomes a branch without and a branch with its patterns, UNION a
  // branch per alternative. Other patterns, e.g. FILTER, BIND, VALUES and
  // subqueries, are kept as is without retrieving their triples.
  flattenPattern(pattern): Branch[] {
    if (pattern.type === "pattern") {
      switch (pattern.subType) {
        case "bgp":
          return this.flattenTriples(pattern.triples);
        case "group":
          return this.flattenPatterns(pattern.patterns);
        case "union":
          return pattern.patterns.flatMap((alternative) =>
            this.flattenPattern(alternative),
          );
        case "optional":
          return [
            emptyBranch(NO_END),
            ...this.flattenPatterns(pattern.patterns),
          ];
      }
    }
    return [this.getRawBranch(pattern)];
  }

  // The triples of blank node property lists and collections, [ … ] and
  // ( … ), are triples of their own, with the blank node as subject or object
  flattenTriples(items): Branch[] {
    const triples = [];
    const identifierOf = (item) => {
      if (item.type !== "tripleCollection") return item;
      item.triples.forEach(addTriple);
      return item.identifier;
    };
    const addTriple = (item) => {
      if (item.type === "tripleCollection") {
        identifierOf(item);
      } else {
        triples.push({
          ...item,
          subject: identifierOf(item.subject),
          object: identifierOf(item.object),
        });
      }
    };
    items.forEach(addTriple);
    return triples.reduce(
      (branches, astTriple) =>
        branchProduct(branches, () => this.flattenTriple(astTriple)),
      [emptyBranch(NO_END)],
    );
  }

  flattenTriple(astTriple): Branch[] {
    const subject = astTermToNode(astTriple.subject);
    const object = astTermToNode(astTriple.object);
    if (astTriple.predicate.type === "term") {
      const pattern = triplePattern(
        subject,
        astTermToNode(astTriple.predicate),
        object,
      );
      return [{ patterns: [pattern], templates: [pattern], end: object }];
    }
    const path = this.astPathToPath(astTriple.predicate);
    if (!path) return [this.getRawBranch(F.patternBgp([astTriple], F.gen()))];
    return this.getPathBranches(path, subject, object);
  }

  // A pattern kept as is, which doesn't retrieve any triples
  getRawBranch(pattern): Branch {
    return {
      patterns: [(name) => patternToString(renameVariables(pattern, name))],
      templates: [],
      end: NO_END,
    };
  }

  // A property path of a Traqula AST, undefined for a negated property set
  astPathToPath(astPath): Path | undefined {
    if (astPath.type === "term") return predicatePath(astPath.value);
    const items = astPath.items.map((item) => this.astPathToPath(item));
    if (items.includes(undefined)) return undefined;
    switch (astPath.subType) {
      case "/":
        return { type: "sequence", paths: items };
      case "|":
        return { type: "alternative", paths: items };
      case "^":
        return invertPath(items[0]);
      case "*":
        return { type: "zeroOrMore", path: items[0] };
      case "+":
        return { type: "oneOrMore", path: items[0] };
      case "?":
        return { type: "zeroOrOne", path: items[0] };
      default:
        return undefined;
    }
  }

  // Shapes with a target, as the validator would select them
  getTargetedShapes() {
    const shapes = rdf.termSet();
    for (const target of TARGET_PREDICATES) {
      const quads = this.shapes.match(
        null,
        rdf.namedNode(PREFIXES.sh + target),
      );
      for (const quad of quads) shapes.add(quad.subject);
    }
    for (const type of ["NodeShape", "PropertyShape"]) {
      const quads = this.shapes.match(
        null,
        rdf.namedNode(PREFIXES.rdf + "type"),
        rdf.namedNode(PREFIXES.sh + type),
      );
      for (const quad of quads) {
        if (this.isClass(quad.subject)) shapes.add(quad.subject);
      }
    }
    return [...shapes];
  }

  getSelectedShapes(options: SparqlGenerationOptions) {
    const shapes = options.shapes?.map(toTerm) ?? this.getTargetedShapes();
    return shapes.filter(
      (shape) => !this.hasTrueValue(shape, PREFIXES.sh + "deactivated"),
    );
  }

  // The targets of the shapes, each with its own focus node variable
  // restricted to the focus nodes
  getFocusTargets(shapes, options: SparqlGenerationOptions) {
    const focusNodes = options.focusNodes?.map(toTerm);
    // Blank nodes aren't allowed in VALUES
    const invalid = focusNodes?.find(
      (term) => term.termType !== "NamedNode" && term.termType !== "Literal",
    );
    if (invalid) throw new Error(`Invalid focus node ${invalid.value}`);
    return shapes.flatMap((shape, index) => {
      let targets = this.getTargets(shape);
      if (!targets.length && focusNodes) {
        targets = [() => ({ select: [], data: [] })];
      }
      return targets.map((createTarget) => {
        const focus = this.createVariable("this");
        const restricted: Branch = {
          ...emptyBranch(focus),
          patterns: focusNodeRestriction(focus, focusNodes),
        };
        const target = createTarget(focus, focusNodes);
        return { shape, index, focus, restricted, target };
      });
    });
  }

  // The branches retrieving the triples the targets select their focus nodes
  // on and the data to validate those focus nodes
  getDataBranches(options: SparqlGenerationOptions): Branch[] {
    const shapes = this.getSelectedShapes(options);
    const branches = [];
    const focusTargets = this.getFocusTargets(shapes, options);
    for (const { shape, focus, restricted, target } of focusTargets) {
      for (const branch of target.data) {
        branches.push(joinBranches(restricted, branch));
      }
      const selection = {
        ...restricted,
        patterns: [...restricted.patterns, ...target.select],
      };
      for (const branch of this.getShapeBranches(shape, focus, [])) {
        branches.push(joinBranches(selection, branch));
      }
    }
    return branches.filter((branch) => branch.templates.length);
  }

  // A branch per target, binding the index of its shape to ?shape when it
  // selects a focus node. Shapes can be blank nodes, which can't be bound.
  getTargetBranches(options: SparqlGenerationOptions) {
    const shapes = this.getSelectedShapes(options);
    const branches: Branch[] = this.getFocusTargets(shapes, options).map(
      ({ index, restricted, target }) => ({
        ...restricted,
        patterns: [
          ...restricted.patterns,
          ...target.select,
          () => `BIND(${index} AS ?shape)`,
        ],
      }),
    );
    return { shapes, branches };
  }

  /*
   * The CONSTRUCT queries of the SPARQL rules of the shapes
   * (sh:rule [ a sh:SPARQLRule ; sh:construct … ]), with $this bound to each
   * of the focus nodes
   */
  getRuleQueries(options: SparqlGenerationOptions): string[] {
    const focusNodes = options.focusNodes?.map(toTerm) ?? [];
    const queries = [];
    for (const shape of this.getSelectedShapes(options)) {
      for (const rule of this.getObjects(shape, PREFIXES.sh + "rule")) {
        if (this.hasTrueValue(rule, PREFIXES.sh + "deactivated")) continue;
        // Only SPARQL rules have a sh:construct, not triple rules
        const [construct] = this.getObjects(rule, PREFIXES.sh + "construct");
        if (!construct) continue;
        // Running the rule without its condition would construct triples for
        // focus nodes it doesn't apply to
        if (this.getObjects(rule, PREFIXES.sh + "condition").length) {
          throw new Error(
            `SPARQL rule ${rule.value} has a sh:condition, which is not supported`,
          );
        }
        const query = this.parseQuery(rule, construct.value);
        for (const focusNode of focusNodes) {
          const bound = transformAst(query, (astNode) =>
            astNode.type === "term" &&
            astNode.subType === "variable" &&
            astNode.value === "this"
              ? termToAst(focusNode)
              : undefined,
          );
          queries.push(generator.generate(bound));
        }
      }
    }
    return queries;
  }
}

// Each branch gets its own variables, numbered in order of appearance
function renderBranch(branch: Branch, next: () => number) {
  const names = new Map<string, string>();
  const name = (variable: string) => {
    if (!names.has(variable)) {
      names.set(variable, `${variable.replace(/_\d+$/, "")}_${next()}`);
    }
    return names.get(variable);
  };
  const patterns = branch.patterns.map((pattern) => pattern(name));
  const templates = branch.templates.map((template) => template(name));
  return { patterns, templates };
}

// Branches only differing in their variables select or retrieve the same, e.g.
// the types of the value nodes of sh:or ( [ sh:class A ] [ sh:class B ] )
function renderDistinctBranches(branches: Branch[]) {
  const distinctBranches = new Map<string, Branch>();
  for (const branch of branches) {
    let local = 0;
    const { patterns } = renderBranch(branch, () => ++local);
    const key = patterns.join("\n");
    if (!distinctBranches.has(key)) distinctBranches.set(key, branch);
  }
  let count = 0;
  return [...distinctBranches.values()].map((branch) =>
    renderBranch(branch, () => ++count),
  );
}

// The UNION of the patterns of the rendered branches
function renderUnion(rendered: { patterns: string[] }[], graph?: string) {
  const unions = rendered.map(({ patterns }) => {
    const indentation = graph ? "      " : "    ";
    const body = patterns
      .map(
        (pattern) => indentation + pattern.replace(/\n/g, `\n${indentation}`),
      )
      .join("\n");
    return graph
      ? `  {\n    GRAPH ${iriToString(graph)} {\n${body}\n    }\n  }`
      : `  {\n${body}\n  }`;
  });
  return unions.join("\n  UNION\n");
}

/*
 * Generates a CONSTRUCT query retrieving the data to validate the focus nodes
 * of the given shapes, see the top of this file. Returns undefined when the
 * shapes don't need any data.
 */
export function generateConstructQuery(
  shapes,
  options: SparqlGenerationOptions = {},
) {
  const sparqlGenerator = new SparqlGenerator(shapes, options.maxDepth);
  const branches = sparqlGenerator.getDataBranches(options);
  if (!branches.length) return undefined;

  const rendered = renderDistinctBranches(branches);
  const templates = [
    ...new Set(rendered.flatMap((branch) => branch.templates)),
  ];
  return `CONSTRUCT {
  ${templates.join("\n  ")}
} WHERE {
${renderUnion(rendered, options.graph)}
}`;
}

/*
 * Generates the CONSTRUCT queries of the SPARQL rules of the given shapes, with
 * $this bound to each of the focus nodes. Run on the store, they construct the
 * triples to add to the data before validation, e.g. to repair data the shapes
 * would otherwise reject. The graph option doesn't apply: a rule's query
 * determines the graphs it reads from.
 */
export function generateRuleQueries(
  shapes,
  options: SparqlGenerationOptions = {},
) {
  const sparqlGenerator = new SparqlGenerator(shapes, options.maxDepth);
  return sparqlGenerator.getRuleQueries(options);
}

/*
 * Generates a SELECT query for the shapes whose targets select one of the
 * focus nodes, e.g. to only retrieve data for the shapes that apply to a
 * resource. Each solution binds ?shape to the index of a shape in the
 * returned shapes. Returns undefined when there are no shapes.
 */
export function generateTargetQuery(
  shapes,
  options: SparqlGenerationOptions = {},
) {
  const sparqlGenerator = new SparqlGenerator(shapes, options.maxDepth);
  const { shapes: selectedShapes, branches } =
    sparqlGenerator.getTargetBranches(options);
  if (!branches.length) return undefined;

  return {
    shapes: selectedShapes,
    query: `SELECT DISTINCT ?shape WHERE {
${renderUnion(renderDistinctBranches(branches), options.graph)}
}`,
  };
}
