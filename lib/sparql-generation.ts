import type { Term } from "@rdfjs/types";
import { Generator } from "@traqula/generator-sparql-1-1";
import { Parser } from "@traqula/parser-sparql-1-1";
import { AstFactory, type QuerySelect } from "@traqula/rules-sparql-1-1";
import rdf from "rdf-ext";

/*
 * Generates a SPARQL SELECT query for the SHACL shapes whose targets select a
 * resource, so the shapes that are relevant for a resource are determined from
 * their target configuration.
 *
 * Every target of a shape is a branch of a UNION: sh:targetClass, sh:targetNode,
 * sh:targetSubjectsOf, sh:targetObjectsOf and SPARQL-based targets. A branch
 * only consists of plain graph patterns and subqueries, restricted to the focus
 * nodes, and has its own variables.
 *
 * Not supported: SPARQL-based targets without a sh:select.
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

// Traqula parsers are expensive to create, a parser is reused for all queries
const parser = new Parser();
const generator = new Generator();
const F = new AstFactory();

type Path =
  | { type: "predicate"; iri: string; inverse: boolean }
  | { type: "sequence" | "alternative"; paths: Path[] }
  | { type: "zeroOrMore" | "oneOrMore" | "zeroOrOne"; path: Path };

const CLOSURE_OPERATORS = { zeroOrMore: "*", oneOrMore: "+", zeroOrOne: "?" };

// A variable, by its id, or a constant in SPARQL syntax
type Node = { variable: string } | { constant: string };

// Part of a query, rendered with the names of the variables of its branch
type Fragment = (name: (variable: string) => string) => string;

// Graph patterns
type Branch = { patterns: Fragment[] };

// The patterns selecting the focus nodes of a target
type Target = { select: Fragment[] };

export type SparqlGenerationOptions = {
  // The shapes to check, by default all shapes with a target
  shapes?: (string | Term)[];
  // Restricts the focus nodes of the shapes to these nodes, e.g. the resource
  // being validated. Shapes without a target apply to these nodes.
  focusNodes?: (string | Term)[];
  // Graph to select the focus nodes in
  graph?: string;
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
  if (term.datatype.value === XSD_STRING)
    return F.termLiteral(F.gen(), term.value);
  return F.termLiteral(
    F.gen(),
    term.value,
    F.termNamed(F.gen(), term.datatype.value),
  );
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

// VALUES restricting a focus node variable to the given focus nodes, if any
function restriction(focus: Node, focusNodes?: Term[]): Fragment[] {
  if (!focusNodes) return [];
  const values = focusNodes.map((node) => constant(node).constant).join(" ");
  return [(name) => `VALUES ${show(focus, name)} { ${values} }`];
}

// Copies a Traqula AST, replacing the nodes replace returns a node for
function transform(node, replace: (node) => unknown) {
  if (Array.isArray(node)) return node.map((item) => transform(item, replace));
  if (!node || typeof node !== "object") return node;
  const replacement = replace(node);
  if (replacement !== undefined) return replacement;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      transform(value, replace),
    ]),
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
  variableCount = 0;

  constructor(shapes) {
    this.shapes = shapes;
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
      (object) =>
        object.value === "true" && object.datatype?.value === XSD_BOOLEAN,
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
    if (
      this.shapes.match(
        shape,
        rdf.namedNode(RDF + "type"),
        rdf.namedNode(RDFS + "Class"),
      ).size
    ) {
      classes.push(shape);
    }
    for (const targetClass of classes) {
      targets.push((focus: Node) => ({
        select: [
          (name) =>
            `${show(focus, name)} ${pathToString(TYPE_PATH)} ${constant(targetClass).constant} .`,
        ],
      }));
    }

    const nodes = this.objects(shape, SH + "targetNode");
    if (nodes.length) {
      const values = nodes.map((node) => constant(node).constant).join(" ");
      targets.push((focus: Node) => ({
        select: [(name) => `VALUES ${show(focus, name)} { ${values} }`],
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

  // A SPARQL-based target selects its focus nodes with a subquery
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
        if (
          this.shapes.match(
            quad.subject,
            rdf.namedNode(RDF + "type"),
            rdf.namedNode(RDFS + "Class"),
          ).size
        ) {
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
        targets = [() => ({ select: [] })];
      }
      return targets.map((createTarget) => {
        const focus = this.variable("this");
        const restricted: Branch = {
          patterns: restriction(focus, focusNodes),
        };
        const target = createTarget(focus, focusNodes);
        return { index, restricted, target };
      });
    });
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
  return { patterns };
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
      .map(
        (pattern) => indentation + pattern.replace(/\n/g, `\n${indentation}`),
      )
      .join("\n");
    return graph
      ? `  {\n    GRAPH <${graph}> {\n${body}\n    }\n  }`
      : `  {\n${body}\n  }`;
  });
  return unions.join("\n  UNION\n");
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
  const sparqlGenerator = new SparqlGenerator(shapes);
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
