import type { Term } from "@rdfjs/types";
import { Generator } from "@traqula/generator-sparql-1-1";
import { Parser } from "@traqula/parser-sparql-1-1";
import { AstFactory, lex, type QuerySelect } from "@traqula/rules-sparql-1-1";
import { sparqlEscapeString, sparqlEscapeUri } from "mu";
import rdf from "rdf-ext";
import { PREFIXES } from "../constants";
import { localName } from "../util/iri";
import { getObjects } from "../util/rdf-ext-helpers";

/*
 * Generates SPARQL queries from SHACL shapes:
 * - a SELECT query for the focus nodes the targets of a shape select, at most
 *   a limited number at a time, e.g. the resources a rule may apply to
 * - a CONSTRUCT query retrieving the data needed to validate given focus nodes
 *   against shapes, inspired by SHACL Play's SHACL2SPARQL
 *   (https://shacl-play.sparna.fr/play/sparql)
 *
 * Only the SELECT query uses the targets of a shape. Starting from the given
 * focus node(s), the CONSTRUCT query follows the sh:path of its property shapes
 * and recurses into the shapes their value nodes have to conform to (sh:node,
 * sh:qualifiedValueShape, sh:and, sh:or, sh:xone, sh:not). It retrieves:
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
 * Not supported: SPARQL-based constraints (sh:sparql) and SPARQL-based targets
 * without a sh:select.
 */

const XSD_BOOLEAN = PREFIXES.xsd + "boolean";
const XSD_STRING = PREFIXES.xsd + "string";

const PAIR_PREDICATES = ["equals", "disjoint", "lessThan", "lessThanOrEqual"];
const LOGICAL_LIST_PREDICATES = ["and", "or", "xone"];

// Traqula parsers are expensive to create, a parser is reused for all queries
const parser = new Parser();
const generator = new Generator();
const F = new AstFactory();

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

// The patterns selecting the focus nodes of a target
type Target = { select: Fragment[] };

// A target for a focus node variable
type CreateTarget = (focus: VariableNode, focusNodes?: Term[]) => Target;

export type SparqlGenerationOptions = {
  // The shapes to retrieve data for
  shapes: (string | Term)[];
  // The focus nodes to retrieve data for, e.g. the resource being validated,
  // whatever the targets of the shapes select
  focusNodes: (string | Term)[];
  // Graph to retrieve the data in
  graph?: string;
  // Maximum number of nested shapes to follow from a shape
  maxDepth?: number;
};

export type FocusNodeQueryOptions = {
  // Restricts the focus nodes to these nodes, e.g. the resource being
  // validated. A shape without a target applies to these nodes instead of to
  // every resource.
  focusNodes?: (string | Term)[];
  // Graph to select the focus nodes in
  graph?: string;
  // The maximum number of focus nodes to select, which is required: without
  // it, a shape would select every resource its targets select
  limit: number;
  // The number of focus nodes to skip, in the order of their IRIs, to select
  // the next ones
  offset?: number;
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
  if (term.datatype.value === XSD_STRING) {
    return F.termLiteral(F.gen(), term.value);
  }
  return F.termLiteral(
    F.gen(),
    term.value,
    F.termNamed(F.gen(), validIri(term.datatype.value)),
  );
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

// VALUES restricting a focus node variable to the given focus nodes, if any
function focusNodeRestriction(
  focus: VariableNode,
  focusNodes?: Term[],
): Fragment[] {
  if (!focusNodes) return [];
  const values = focusNodes.map(termToString).join(" ");
  return [(name) => `VALUES ${nodeToString(focus, name)} { ${values} }`];
}

// The focus nodes as terms. Blank nodes aren't allowed in VALUES.
function toFocusNodes(focusNodes?: (string | Term)[]) {
  const terms = focusNodes?.map(toTerm);
  const invalid = terms?.find(
    (term) => term.termType !== "NamedNode" && term.termType !== "Literal",
  );
  if (invalid) throw new Error(`Invalid focus node ${invalid.value}`);
  return terms;
}

// The target of a shape without a target: every resource, i.e. every node
// with a type
const allResourcesTarget: CreateTarget = (focus) => ({
  select: [
    (name) =>
      `${nodeToString(focus, name)} ${pathToString(predicatePath(PREFIXES.rdf + "type"))} [] .`,
  ],
});

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

  // A new variable, named after the hint so the generated query stays
  // readable, e.g. ?heeftAgenda_3 for besluit:heeftAgenda. An IRI is cut to its
  // local name, without the '-' a SPARQL variable name doesn't allow, and an
  // empty name becomes 'v'. The counter makes the variable unique in the query,
  // so the name only has to be readable.
  createVariable(hint: string): VariableNode {
    const name = localName(hint, /[^A-Za-z0-9_]/g) || "v";
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
   * to the given focus nodes as well.
   */
  getSparqlTarget(
    target,
    select: string,
    focus: VariableNode,
    focusNodes?: Term[],
  ): Target {
    const prefixes = this.getPrefixes(target);
    // sh:select holds a SELECT query
    const parsed = parser.parse(select, { prefixes }) as QuerySelect;
    for (const declaration of parsed.context) {
      if (declaration.subType === "prefix") {
        prefixes[declaration.key] = declaration.value.value;
      }
    }
    const ids = new Map<string, string>();
    const query = renameVariables(
      expandPrefixes({ ...parsed, context: [] }, prefixes),
      (variable) => {
        if (variable === "this") return focus.variable;
        if (!ids.has(variable)) {
          ids.set(variable, this.createVariable(variable).variable);
        }
        return ids.get(variable);
      },
    );
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
    };
  }

  // The prefixes declared for a SPARQL-based target (sh:prefixes/sh:declare)
  getPrefixes(target) {
    const prefixes = {};
    const prefixLists = this.getObjects(target, PREFIXES.sh + "prefixes");
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

  // The shapes that aren't deactivated
  getActiveShapes(shapes: (string | Term)[]) {
    return shapes
      .map(toTerm)
      .filter(
        (shape) => !this.hasTrueValue(shape, PREFIXES.sh + "deactivated"),
      );
  }

  // A focus node variable restricted to the focus nodes, if any
  getRestrictedFocus(focusNodes?: Term[]) {
    const focus = this.createVariable("this");
    const restricted: Branch = {
      ...emptyBranch(focus),
      patterns: focusNodeRestriction(focus, focusNodes),
    };
    return { focus, restricted };
  }

  // The branches retrieving the data to validate the focus nodes against the
  // shapes, without their targets
  getDataBranches(options: SparqlGenerationOptions): Branch[] {
    const focusNodes = toFocusNodes(options.focusNodes);
    if (!focusNodes?.length) {
      throw new Error("No focus nodes to retrieve the data of");
    }
    const branches = [];
    for (const shape of this.getActiveShapes(options.shapes)) {
      const { focus, restricted } = this.getRestrictedFocus(focusNodes);
      for (const branch of this.getShapeBranches(shape, focus, [])) {
        branches.push(joinBranches(restricted, branch));
      }
    }
    return branches.filter((branch) => branch.templates.length);
  }

  // The targets of a shape, each with its own focus node variable restricted
  // to the focus nodes. A shape without a target applies to the given focus
  // nodes, or else to every resource.
  getFocusTargets(shape, focusNodes?: Term[]) {
    const targets = this.getTargets(shape);
    if (!targets.length) {
      targets.push(focusNodes ? () => ({ select: [] }) : allResourcesTarget);
    }
    return targets.map((createTarget) => {
      const { focus, restricted } = this.getRestrictedFocus(focusNodes);
      return { focus, restricted, target: createTarget(focus, focusNodes) };
    });
  }

  // A branch per target of the shape, binding the focus nodes it selects to
  // ?focusNode
  getFocusNodeBranches(shape, options: FocusNodeQueryOptions): Branch[] {
    const focusNodes = toFocusNodes(options.focusNodes);
    const focusTargets = this.getActiveShapes([shape]).flatMap((active) =>
      this.getFocusTargets(active, focusNodes),
    );
    return focusTargets.map(({ focus, restricted, target }) => ({
      ...restricted,
      patterns: [
        ...restricted.patterns,
        ...target.select,
        (name) => `BIND(${nodeToString(focus, name)} AS ?focusNode)`,
      ],
    }));
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
 * Generates a CONSTRUCT query retrieving the data to validate the given focus
 * nodes against the given shapes, see the top of this file. Returns undefined
 * when the shapes don't need any data.
 */
export function generateConstructQuery(
  shapes,
  options: SparqlGenerationOptions,
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

const isCount = (value: number, minimum: number) =>
  Number.isInteger(value) && value >= minimum;

/*
 * Generates a SELECT query for the focus nodes the targets of a shape select,
 * bound to ?focusNode: at most limit of them, ordered so offset selects the
 * next ones. A shape without a target selects the given focus nodes, or else
 * every resource, i.e. every node with a type. Returns undefined for a
 * deactivated shape.
 */
export function generateFocusNodeQuery(
  shapes,
  shape: string | Term,
  options: FocusNodeQueryOptions,
) {
  const { limit, offset = 0 } = options;
  if (!isCount(limit, 1)) {
    throw new Error(`Invalid limit ${limit}, a positive integer is required`);
  }
  if (!isCount(offset, 0)) throw new Error(`Invalid offset ${offset}`);

  const sparqlGenerator = new SparqlGenerator(shapes);
  const branches = sparqlGenerator.getFocusNodeBranches(toTerm(shape), options);
  if (!branches.length) return undefined;

  return `SELECT DISTINCT ?focusNode WHERE {
${renderUnion(renderDistinctBranches(branches), options.graph)}
}
ORDER BY ?focusNode
LIMIT ${limit}${offset ? `\nOFFSET ${offset}` : ""}`;
}
