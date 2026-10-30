import type { Term } from "@rdfjs/types";
import { Generator } from "@traqula/generator-sparql-1-1";
import { Parser } from "@traqula/parser-sparql-1-1";
import {
  AstFactory,
  type QueryConstruct,
  type QuerySelect,
} from "@traqula/rules-sparql-1-1";
import rdf from "rdf-ext";

/*
 * Generates a SPARQL CONSTRUCT query retrieving the data needed to validate
 * resources against SHACL shapes, inspired by SHACL Play's SHACL2SPARQL
 * (https://shacl-play.sparna.fr/play/sparql).
 *
 * Starting from the focus nodes of a shape (its targets), the query follows
 * the sh:path of its property shapes and recurses into the shapes their value
 * nodes have to conform to (sh:node, sh:qualifiedValueShape, sh:and, sh:or,
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
 * Every way to reach data is a branch of a UNION. A branch only consists of
 * plain graph patterns, which keeps the variables of a branch bound when they
 * are used in a BIND or FILTER and lets the endpoint evaluate each branch
 * from the focus nodes. Every branch has its own variables: a CONSTRUCT
 * template is instantiated for every solution binding its variables, sharing
 * variables would construct triples of one branch out of the solutions of
 * another (e.g. ?s <p> ?o out of a solution of ?s (<p>|<q>) ?o matching <q>).
 *
 * Not supported: SPARQL-based constraints (sh:sparql) and SPARQL-based
 * targets without a sh:select. Negated property sets in the sh:select of a
 * target are used to select the focus nodes, but their triples are not
 * retrieved.
 */

const SH = "http://www.w3.org/ns/shacl#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const XSD_BOOLEAN = "http://www.w3.org/2001/XMLSchema#boolean";
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";

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

// A variable, by its id, or a constant in SPARQL syntax
type Node = { variable: string } | { constant: string };

// Part of a query, rendered with the names of the variables of its branch
type Fragment = (name: (variable: string) => string) => string;

// Graph patterns, the triples they retrieve (CONSTRUCT template) and the node
// they end in, e.g. the value nodes of a property path
type Branch = { patterns: Fragment[]; templates: Fragment[]; end: Node };

// The patterns selecting the focus nodes of a target and the branches
// retrieving the triples it selects them on
type Target = { select: Fragment[]; data: Branch[] };

export type SparqlGenerationOptions = {
  // The shapes to retrieve data for, by default all shapes with a target
  shapes?: (string | Term)[];
  // Restricts the focus nodes of the shapes to these nodes, e.g. the resource
  // being validated. Shapes without a target apply to these nodes.
  focusNodes?: (string | Term)[];
  // Graph to retrieve the data from
  graph?: string;
  // Maximum number of nested shapes to follow from a shape
  maxDepth?: number;
};

const LITERAL_ESCAPES = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

function literal(value: string, langOrDatatype?: string | { value: string }) {
  const lexical = `"${value.replace(/["\\\n\r\t\b\f]/g, (c) => LITERAL_ESCAPES[c])}"`;
  if (typeof langOrDatatype === "string") return `${lexical}@${langOrDatatype}`;
  if (!langOrDatatype || langOrDatatype.value === XSD_STRING) return lexical;
  return `${lexical}^^<${langOrDatatype.value}>`;
}

const iri = (value: string) => ({ constant: `<${value}>` });

// An RDF/JS term, e.g. of the shapes, as a constant
function constant(term: Term): { constant: string } {
  switch (term.termType) {
    case "NamedNode":
      return iri(term.value);
    case "BlankNode":
      return { constant: `_:${term.value}` };
    case "Literal":
      return { constant: literal(term.value, term.language || term.datatype) };
    default:
      throw new Error(`Unsupported term ${term.value}`);
  }
}

// An RDF/JS term as a term of a Traqula AST
function astTerm(term: Term) {
  if (term.termType !== "Literal") return F.termNamed(F.gen(), term.value);
  if (term.language) return F.termLiteral(F.gen(), term.value, term.language);
  if (term.datatype.value === XSD_STRING) return F.termLiteral(F.gen(), term.value);
  return F.termLiteral(F.gen(), term.value, F.termNamed(F.gen(), term.datatype.value));
}

// A term of a Traqula AST, after expanding prefixes and renaming blank nodes
// to variables
function astNode(term): Node {
  switch (term.subType) {
    case "variable":
      return { variable: term.value };
    case "namedNode":
      return iri(term.value);
    case "literal":
      return { constant: literal(term.value, term.langOrIri) };
    default:
      throw new Error(`Unsupported term ${term.subType} ${term.value}`);
  }
}

// A pattern of a Traqula AST, generated as the body of PATTERN_QUERY
function patternToSparql(pattern): string {
  const query = generator.generate({
    ...PATTERN_QUERY,
    where: F.patternGroup([pattern], F.gen()),
  });
  return query
    .slice(query.indexOf("{") + 1, query.lastIndexOf("}"))
    .replace(/^\n|\n$/g, "")
    .replace(/^  /gm, "");
}
const show = (node: Node, name: (variable: string) => string) =>
  "variable" in node ? `?${name(node.variable)}` : node.constant;
const toTerm = (value: string | Term) =>
  typeof value === "string" ? rdf.namedNode(value) : value;

const predicate = (value: string): Path => ({
  type: "predicate",
  iri: value,
  inverse: false,
});
// rdf:type/rdfs:subClassOf*, the path sh:targetClass and sh:class rely on
const TYPE_PATH: Path = {
  type: "sequence",
  paths: [
    predicate(RDF + "type"),
    { type: "zeroOrMore", path: predicate(RDFS + "subClassOf") },
  ],
};

// Inverse paths are pushed down to their predicates, e.g. ^(p/q) is ^q/^p
function invert(path: Path): Path {
  switch (path.type) {
    case "predicate":
      return { ...path, inverse: !path.inverse };
    case "sequence":
      return { type: "sequence", paths: path.paths.map(invert).reverse() };
    case "alternative":
      return { type: "alternative", paths: path.paths.map(invert) };
    default:
      return { type: path.type, path: invert(path.path) };
  }
}

function pathToString(path: Path): string {
  switch (path.type) {
    case "predicate":
      return (path.inverse ? "^" : "") + iri(path.iri).constant;
    case "sequence":
      return `(${path.paths.map(pathToString).join("/")})`;
    case "alternative":
      return `(${path.paths.map(pathToString).join("|")})`;
    default:
      return `(${pathToString(path.path)})${CLOSURE_OPERATORS[path.type]}`;
  }
}

function triple(subject: Node, predicate: Node, object: Node): Fragment {
  return (name) =>
    `${show(subject, name)} ${show(predicate, name)} ${show(object, name)} .`;
}

function join(first: Branch, second: Branch): Branch {
  return {
    patterns: [...first.patterns, ...second.patterns],
    templates: [...first.templates, ...second.templates],
    end: second.end,
  };
}

// Every branch followed by every branch next creates from it
function product(branches: Branch[], next: (branch: Branch) => Branch[]) {
  return branches.flatMap((branch) =>
    next(branch).map((nextBranch) => join(branch, nextBranch)),
  );
}

// VALUES restricting a focus node variable to the given focus nodes, if any
function restriction(focus: Node, focusNodes?: Term[]): Fragment[] {
  if (!focusNodes) return [];
  const values = focusNodes.map((node) => constant(node).constant).join(" ");
  return [(name) => `VALUES ${show(focus, name)} { ${values} }`];
}

const emptyBranch = (end: Node): Branch => ({
  patterns: [],
  templates: [],
  end,
});

// Copies a Traqula AST, replacing the nodes replace returns a node for
function transform(node, replace: (node) => unknown) {
  if (Array.isArray(node)) return node.map((item) => transform(item, replace));
  if (!node || typeof node !== "object") return node;
  const replacement = replace(node);
  if (replacement !== undefined) return replacement;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, transform(value, replace)]),
  );
}

// Renames the variables, and blank nodes, which act as variables, in a
// Traqula AST
function renameVariables(ast, rename: (variable: string) => string) {
  let anonymous = 0;
  const replace = (node) => {
    if (node.type === "term" && node.subType === "variable") {
      return F.termVariable(rename(node.value), node.loc);
    }
    if (node.type === "term" && node.subType === "blankNode") {
      const label = node.label ?? `anonymous_${++anonymous}`;
      return F.termVariable(rename(`_:${label}`), node.loc);
    }
    // The rows of VALUES are keyed by variable name, e.g. { x: <a> }
    if (node.type === "pattern" && node.subType === "values") {
      return F.patternValues(
        transform(node.variables, replace),
        node.values.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [rename(key), value]),
          ),
        ),
        node.loc,
      );
    }
    return undefined;
  };
  return transform(ast, replace);
}

// Replaces prefixed names by full IRIs: a subquery can't declare prefixes
function expandPrefixes(ast, prefixes: Record<string, string>) {
  return transform(ast, (node) => {
    if (
      node.type === "term" &&
      node.subType === "namedNode" &&
      node.prefix !== undefined
    ) {
      if (!(node.prefix in prefixes)) {
        throw new Error(`Undeclared prefix ${node.prefix}:`);
      }
      return F.termNamed(node.loc, prefixes[node.prefix] + node.value);
    }
    return undefined;
  });
}

class SparqlGenerator {
  shapes;
  maxDepth: number;
  variableCount = 0;

  constructor(shapes, maxDepth: number) {
    this.shapes = shapes;
    this.maxDepth = maxDepth;
  }

  variable(hint: string): { variable: string } {
    const name =
      hint.replace(/^.*[#/:]/, "").replace(/[^A-Za-z0-9_]/g, "_") || "v";
    return { variable: `${name}_${++this.variableCount}` };
  }

  objects(subject, predicate: string) {
    return [...this.shapes.match(subject, rdf.namedNode(predicate))].map(
      (quad) => quad.object,
    );
  }

  isTrue(subject, predicate: string) {
    return this.objects(subject, predicate).some(
      (object) => object.value === "true" && object.datatype?.value === XSD_BOOLEAN,
    );
  }

  list(node) {
    const items = [];
    while (node && node.value !== RDF + "nil") {
      const [first] = this.objects(node, RDF + "first");
      if (!first) throw new Error(`${node.value} is not an RDF list`);
      items.push(first);
      [node] = this.objects(node, RDF + "rest");
    }
    return items;
  }

  parsePath(node): Path {
    if (node.termType === "NamedNode" && node.value !== RDF + "nil") {
      return predicate(node.value);
    }
    if (this.objects(node, RDF + "first").length) {
      return {
        type: "sequence",
        paths: this.list(node).map((item) => this.parsePath(item)),
      };
    }
    const [inverse] = this.objects(node, SH + "inversePath");
    if (inverse) return invert(this.parsePath(inverse));
    const [alternatives] = this.objects(node, SH + "alternativePath");
    if (alternatives) {
      return {
        type: "alternative",
        paths: this.list(alternatives).map((item) => this.parsePath(item)),
      };
    }
    for (const type of Object.keys(CLOSURE_OPERATORS)) {
      const [path] = this.objects(node, `${SH}${type}Path`);
      if (path) {
        return { type, path: this.parsePath(path) } as Path;
      }
    }
    throw new Error(`Unsupported SHACL path ${node.value}`);
  }

  /*
   * The branches following a path from start. Each branch ends in a fresh
   * variable for the nodes the path reaches, or in end when given.
   */
  compilePath(path: Path, start: Node, end?: Node): Branch[] {
    switch (path.type) {
      case "predicate": {
        const target = end ?? this.variable(path.iri);
        const pattern = path.inverse
          ? triple(target, iri(path.iri), start)
          : triple(start, iri(path.iri), target);
        return [{ patterns: [pattern], templates: [pattern], end: target }];
      }
      case "sequence":
        return path.paths.reduce(
          (branches, step, index) =>
            product(branches, (branch) =>
              this.compilePath(
                step,
                branch.end,
                index === path.paths.length - 1 ? end : undefined,
              ),
            ),
          [emptyBranch(start)],
        );
      case "alternative": {
        const branches = [];
        for (const inverse of [false, true]) {
          const iris = path.paths
            .filter((alternative) => alternative.type === "predicate")
            .filter((alternative) => alternative.inverse === inverse)
            .map((alternative) => alternative.iri);
          if (iris.length) {
            branches.push(this.alternativePredicates(iris, inverse, start, end));
          }
        }
        for (const alternative of path.paths) {
          if (alternative.type !== "predicate") {
            branches.push(...this.compilePath(alternative, start, end));
          }
        }
        return branches;
      }
      case "zeroOrOne":
        return [
          this.zeroLength(start, end),
          ...this.compilePath(path.path, start, end),
        ];
      case "zeroOrMore":
        return [
          this.zeroLength(start, end),
          ...this.oneOrMore(path.path, start, end),
        ];
      case "oneOrMore":
        return this.oneOrMore(path.path, start, end);
    }
  }

  // Alternative predicates in a single branch, e.g. p|q as ?s ?predicate ?o
  // with VALUES ?predicate { p q }: the template only constructs the triple
  // matched, with the predicate it is matched with
  alternativePredicates(
    iris: string[],
    inverse: boolean,
    start: Node,
    end?: Node,
  ): Branch {
    if (iris.length === 1) {
      return this.compilePath({ type: "predicate", iri: iris[0], inverse }, start, end)[0];
    }
    const target = end ?? this.variable(iris[0]);
    const property = this.variable("predicate");
    const values = iris.map((value) => iri(value).constant).join(" ");
    const pattern = inverse
      ? triple(target, property, start)
      : triple(start, property, target);
    return {
      patterns: [(name) => `VALUES ${show(property, name)} { ${values} }`, pattern],
      templates: [pattern],
      end: target,
    };
  }

  // A zero length path ends in the start node itself, without patterns
  zeroLength(start: Node, end?: Node): Branch {
    if (!end) return emptyBranch(start);
    return {
      patterns: [
        (name) => `FILTER(sameTerm(${show(start, name)}, ${show(end, name)}))`,
      ],
      templates: [],
      end,
    };
  }

  // The last step of path+ from every node path* reaches, which retrieves
  // every triple along the way
  oneOrMore(path: Path, start: Node, end?: Node): Branch[] {
    const via = this.variable("via");
    const closure: Branch = {
      patterns: [
        (name) => `${show(start, name)} ${pathToString(path)}* ${show(via, name)} .`,
      ],
      templates: [],
      end: via,
    };
    return product([closure], () => this.compilePath(path, via, end));
  }

  /*
   * The branches retrieving the data to validate the focus nodes against a
   * shape. visited holds the shapes being followed, to stop at cycles.
   */
  shapeBranches(shape, focus: Node, visited: string[]): Branch[] {
    const key = `${shape.termType}:${shape.value}`;
    if (
      visited.includes(key) ||
      visited.length >= this.maxDepth ||
      this.isTrue(shape, SH + "deactivated")
    ) {
      return [];
    }
    const followed = [...visited, key];

    const [path] = this.objects(shape, SH + "path");
    if (!path) {
      return [
        ...this.valueNodeBranches(shape, focus, followed),
        ...this.pairBranches(shape, focus),
        ...this.objects(shape, SH + "property").flatMap((property) =>
          this.shapeBranches(property, focus, followed),
        ),
      ];
    }
    return [
      ...this.compilePath(this.parsePath(path), focus).flatMap((branch) => [
        branch,
        ...product([branch], () =>
          this.valueNodeBranches(shape, branch.end, followed),
        ),
      ]),
      ...this.pairBranches(shape, focus),
    ];
  }

  // The data the constraints on the value nodes of a shape need
  valueNodeBranches(shape, value: Node, followed: string[]): Branch[] {
    const branches = [];
    if (this.objects(shape, SH + "class").length) {
      branches.push(...this.compilePath(TYPE_PATH, value));
    }
    if (this.isTrue(shape, SH + "closed")) {
      const property = this.variable("property");
      const object = this.variable("object");
      const pattern = triple(value, property, object);
      branches.push({ patterns: [pattern], templates: [pattern], end: object });
    }
    const nestedShapes = [
      ...this.objects(shape, SH + "node"),
      ...this.objects(shape, SH + "not"),
      ...this.objects(shape, SH + "qualifiedValueShape"),
      ...LOGICAL_LIST_PREDICATES.flatMap((logical) =>
        this.objects(shape, SH + logical).flatMap((list) => this.list(list)),
      ),
    ];
    for (const nestedShape of nestedShapes) {
      branches.push(...this.shapeBranches(nestedShape, value, followed));
    }
    return branches;
  }

  // Property pair constraints compare the value nodes with the values of a
  // property of the focus node
  pairBranches(shape, focus: Node): Branch[] {
    return PAIR_PREDICATES.flatMap((pair) =>
      this.objects(shape, SH + pair).flatMap((property) =>
        this.compilePath(predicate(property.value), focus),
      ),
    );
  }

  /*
   * The targets of a shape, to create for a focus node variable. Targets
   * selecting their focus nodes in a subquery restrict them to the given focus
   * nodes in the subquery as well, so the endpoint doesn't select the focus
   * nodes of the whole store first.
   */
  targets(shape): ((focus: Node, focusNodes?: Term[]) => Target)[] {
    const targets = [];
    const classes = this.objects(shape, SH + "targetClass");
    if (this.shapes.match(shape, rdf.namedNode(RDF + "type"), rdf.namedNode(RDFS + "Class")).size) {
      classes.push(shape);
    }
    for (const targetClass of classes) {
      targets.push((focus: Node) => ({
        select: [
          (name) =>
            `${show(focus, name)} ${pathToString(TYPE_PATH)} ${constant(targetClass).constant} .`,
        ],
        data: this.compilePath(TYPE_PATH, focus, constant(targetClass)),
      }));
    }

    const nodes = this.objects(shape, SH + "targetNode");
    if (nodes.length) {
      const values = nodes.map((node) => constant(node).constant).join(" ");
      targets.push((focus: Node) => ({
        select: [(name) => `VALUES ${show(focus, name)} { ${values} }`],
        data: [],
      }));
    }

    for (const [type, inverse] of [
      ["targetSubjectsOf", false],
      ["targetObjectsOf", true],
    ] as const) {
      for (const property of this.objects(shape, SH + type)) {
        const path = inverse
          ? invert(predicate(property.value))
          : predicate(property.value);
        targets.push((focus: Node, focusNodes?: Term[]) => ({
          select: [
            (name) => {
              const values = restriction(focus, focusNodes).map((pattern) =>
                pattern(name),
              );
              return `{ SELECT DISTINCT ${show(focus, name)} WHERE { ${[...values, ""].join(" ")}${show(focus, name)} ${pathToString(path)} [] . } }`;
            },
          ],
          data: this.compilePath(path, focus),
        }));
      }
    }

    for (const target of this.objects(shape, SH + "target")) {
      const [select] = this.objects(target, SH + "select");
      if (select) {
        targets.push((focus: Node, focusNodes?: Term[]) =>
          this.sparqlTarget(target, select.value, focus, focusNodes),
        );
      }
    }
    return targets;
  }

  /*
   * A SPARQL-based target selects its focus nodes with a subquery. The
   * triples it selects them on are retrieved by flattening its graph patterns
   * into branches.
   */
  sparqlTarget(
    target,
    select: string,
    focus: Node,
    focusNodes?: Term[],
  ): Target {
    const prefixes = this.prefixes(target);
    // sh:select holds a SELECT query
    const parsed = parser.parse(select, { prefixes }) as QuerySelect;
    for (const definition of parsed.context) {
      if (definition.subType === "prefix") {
        prefixes[definition.key] = definition.value.value;
      }
    }
    const ids = new Map<string, string>();
    const query = renameVariables(
      expandPrefixes({ ...parsed, context: [] }, prefixes),
      (variable) => {
        if (variable === "this" && "variable" in focus) return focus.variable;
        if (!ids.has(variable)) {
          ids.set(variable, this.variable(variable).variable);
        }
        return ids.get(variable);
      },
    );
    const where = query.where.patterns;
    if (focusNodes && "variable" in focus) {
      const values = F.patternValues(
        [F.termVariable(focus.variable, F.gen())],
        focusNodes.map((node) => ({ [focus.variable]: astTerm(node) })),
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

  // The prefixes declared for a SPARQL-based target (sh:prefixes/sh:declare)
  prefixes(node) {
    const prefixes = {};
    for (const declarations of this.objects(node, SH + "prefixes")) {
      for (const declaration of this.objects(declarations, SH + "declare")) {
        const [prefix] = this.objects(declaration, SH + "prefix");
        const [namespace] = this.objects(declaration, SH + "namespace");
        if (prefix && namespace) prefixes[prefix.value] = namespace.value;
      }
    }
    return prefixes;
  }

  flattenPatterns(patterns): Branch[] {
    return patterns.reduce(
      (branches, pattern) =>
        product(branches, () => this.flattenPattern(pattern)),
      [emptyBranch({ constant: "" })],
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
            emptyBranch({ constant: "" }),
            ...this.flattenPatterns(pattern.patterns),
          ];
      }
    }
    return [this.rawBranch(pattern)];
  }

  // The triples of blank node property lists and collections, [ … ] and
  // ( … ), are triples of their own, with the blank node as subject or object
  flattenTriples(items): Branch[] {
    const triples = [];
    const node = (item) => {
      if (item.type !== "tripleCollection") return item;
      item.triples.forEach(add);
      return item.identifier;
    };
    const add = (item) => {
      if (item.type === "tripleCollection") {
        node(item);
      } else {
        triples.push({
          ...item,
          subject: node(item.subject),
          object: node(item.object),
        });
      }
    };
    items.forEach(add);
    return triples.reduce(
      (branches, astTriple) =>
        product(branches, () => this.flattenTriple(astTriple)),
      [emptyBranch({ constant: "" })],
    );
  }

  flattenTriple(astTriple): Branch[] {
    const subject = astNode(astTriple.subject);
    const object = astNode(astTriple.object);
    if (astTriple.predicate.type === "term") {
      const pattern = triple(subject, astNode(astTriple.predicate), object);
      return [{ patterns: [pattern], templates: [pattern], end: object }];
    }
    const path = this.fromAstPath(astTriple.predicate);
    if (!path) return [this.rawBranch(F.patternBgp([astTriple], F.gen()))];
    return this.compilePath(path, subject, object);
  }

  rawBranch(pattern): Branch {
    return {
      patterns: [(name) => patternToSparql(renameVariables(pattern, name))],
      templates: [],
      end: { constant: "" },
    };
  }

  // A property path of a Traqula AST, undefined for a negated property set
  fromAstPath(path): Path | undefined {
    if (path.type === "term") return predicate(path.value);
    const items = path.items.map((item) => this.fromAstPath(item));
    if (items.includes(undefined)) return undefined;
    switch (path.subType) {
      case "/":
        return { type: "sequence", paths: items };
      case "|":
        return { type: "alternative", paths: items };
      case "^":
        return invert(items[0]);
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

  // The CONSTRUCT queries of the SPARQL rules of the shapes, with $this bound
  // to each of the focus nodes
  ruleQueries(options: SparqlGenerationOptions): string[] {
    const focusNodes = options.focusNodes?.map(toTerm) ?? [];
    const queries = [];
    for (const shape of this.selectedShapes(options)) {
      for (const rule of this.objects(shape, SH + "rule")) {
        const [construct] = this.objects(rule, SH + "construct");
        if (!construct || this.isTrue(rule, SH + "deactivated")) continue;
        const prefixes = this.prefixes(rule);
        // sh:construct holds a CONSTRUCT query
        const parsed = parser.parse(construct.value, { prefixes }) as QueryConstruct;
        for (const definition of parsed.context) {
          if (definition.subType === "prefix") {
            prefixes[definition.key] = definition.value.value;
          }
        }
        const query = expandPrefixes({ ...parsed, context: [] }, prefixes);
        for (const focusNode of focusNodes) {
          const bound = transform(query, (node) =>
            node.type === "term" &&
            node.subType === "variable" &&
            node.value === "this"
              ? astTerm(focusNode)
              : undefined,
          );
          queries.push(generator.generate(bound));
        }
      }
    }
    return queries;
  }

  // Shapes with a target, as the validator would select them
  targetedShapes() {
    const shapes = rdf.termSet();
    for (const target of TARGET_PREDICATES) {
      for (const quad of this.shapes.match(null, rdf.namedNode(SH + target))) {
        shapes.add(quad.subject);
      }
    }
    for (const type of ["NodeShape", "PropertyShape"]) {
      for (const quad of this.shapes.match(
        null,
        rdf.namedNode(RDF + "type"),
        rdf.namedNode(SH + type),
      )) {
        if (this.shapes.match(quad.subject, rdf.namedNode(RDF + "type"), rdf.namedNode(RDFS + "Class")).size) {
          shapes.add(quad.subject);
        }
      }
    }
    return [...shapes];
  }

  selectedShapes(options: SparqlGenerationOptions) {
    const shapes = options.shapes?.map(toTerm) ?? this.targetedShapes();
    return shapes.filter((shape) => !this.isTrue(shape, SH + "deactivated"));
  }

  // The targets of the shapes, each with its own focus node variable
  // restricted to the focus nodes
  focusTargets(shapes, options: SparqlGenerationOptions) {
    const focusNodes = options.focusNodes?.map(toTerm);
    return shapes.flatMap((shape, index) => {
      let targets = this.targets(shape);
      if (!targets.length && focusNodes) {
        targets = [() => ({ select: [], data: [] })];
      }
      return targets.map((createTarget) => {
        const focus = this.variable("this");
        const restricted: Branch = {
          ...emptyBranch(focus),
          patterns: restriction(focus, focusNodes),
        };
        const target = createTarget(focus, focusNodes);
        return { shape, index, focus, restricted, target };
      });
    });
  }

  branches(options: SparqlGenerationOptions): Branch[] {
    const shapes = this.selectedShapes(options);
    const branches = [];
    for (const { shape, focus, restricted, target } of this.focusTargets(
      shapes,
      options,
    )) {
      for (const branch of target.data) {
        branches.push(join(restricted, branch));
      }
      const selection = {
        ...restricted,
        patterns: [...restricted.patterns, ...target.select],
      };
      for (const branch of this.shapeBranches(shape, focus, [])) {
        branches.push(join(selection, branch));
      }
    }
    return branches.filter((branch) => branch.templates.length);
  }

  // A branch per target, binding the index of its shape to ?shape when it
  // selects a focus node. Shapes can be blank nodes, which can't be bound.
  targetBranches(options: SparqlGenerationOptions) {
    const shapes = this.selectedShapes(options);
    const branches = this.focusTargets(shapes, options).map(
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
}

// Each branch gets its own variables, numbered in order of appearance
function render(branch: Branch, next: () => number) {
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

// Branches only differing in their variables retrieve the same data, e.g.
// the types of the value nodes of sh:or ( [ sh:class A ] [ sh:class B ] )
function renderDistinct(branches: Branch[]) {
  const distinctBranches = new Map<string, Branch>();
  for (const branch of branches) {
    let local = 0;
    const { patterns } = render(branch, () => ++local);
    const key = patterns.join("\n");
    if (!distinctBranches.has(key)) distinctBranches.set(key, branch);
  }
  let count = 0;
  return [...distinctBranches.values()].map((branch) =>
    render(branch, () => ++count),
  );
}

// The UNION of the patterns of the rendered branches
function union(rendered: { patterns: string[] }[], graph?: string) {
  const unions = rendered.map(({ patterns }) => {
    const indentation = graph ? "      " : "    ";
    const body = patterns
      .map((pattern) => indentation + pattern.replace(/\n/g, `\n${indentation}`))
      .join("\n");
    return graph
      ? `  {\n    GRAPH <${graph}> {\n${body}\n    }\n  }`
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
  const sparqlGenerator = new SparqlGenerator(shapes, options.maxDepth ?? 10);
  const branches = sparqlGenerator.branches(options);
  if (!branches.length) return undefined;

  const rendered = renderDistinct(branches);
  const templates = [...new Set(rendered.flatMap((branch) => branch.templates))];
  return `CONSTRUCT {
  ${templates.join("\n  ")}
} WHERE {
${union(rendered, options.graph)}
}`;
}

/*
 * Generates the CONSTRUCT queries of the SPARQL rules of the shapes
 * (sh:rule [ a sh:SPARQLRule ; sh:construct … ], SHACL Advanced Features),
 * with $this bound to each of the focus nodes. Run on the store, they add
 * triples to the data graph before validation, e.g. to repair data the shapes
 * would otherwise reject.
 */
export function generateRuleQueries(
  shapes,
  options: SparqlGenerationOptions = {},
) {
  const sparqlGenerator = new SparqlGenerator(shapes, options.maxDepth ?? 10);
  return sparqlGenerator.ruleQueries(options);
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
  const sparqlGenerator = new SparqlGenerator(shapes, options.maxDepth ?? 10);
  const { shapes: selectedShapes, branches } =
    sparqlGenerator.targetBranches(options);
  if (!branches.length) return undefined;

  return {
    shapes: selectedShapes,
    query: `SELECT DISTINCT ?shape WHERE {
${union(renderDistinct(branches), options.graph)}
}`,
  };
}
