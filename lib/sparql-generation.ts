import type { Term } from "@rdfjs/types";
import { Generator } from "@traqula/generator-sparql-1-1";
import { Parser } from "@traqula/parser-sparql-1-1";
import { AstFactory, lex, type QuerySelect } from "@traqula/rules-sparql-1-1";
import { sparqlEscapeString, sparqlEscapeUri } from "mu";
import rdf from "rdf-ext";
import { PREFIXES } from "../constants";

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

const XSD_BOOLEAN = PREFIXES.xsd + "boolean";
const XSD_STRING = PREFIXES.xsd + "string";

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

type PredicatePath = { type: "predicate"; iri: string; inverse: boolean };

type Path =
  | PredicatePath
  | { type: "sequence"; paths: Path[] }
  | { type: "zeroOrMore"; path: Path };

// The id of a variable, which gets its name when its branch is rendered
type Variable = string;

// Part of a query, rendered with the names of the variables of its branch
type Fragment = (name: (variable: Variable) => string) => string;

// The patterns selecting the focus nodes of a target for a focus node variable
type CreateTarget = (focus: Variable, focusNodes?: Term[]) => Fragment[];

export type SparqlGenerationOptions = {
  // The shapes to check, by default all shapes with a target
  shapes?: (string | Term)[];
  // Restricts the focus nodes of the shapes to these nodes, e.g. the resource
  // being validated. Shapes without a target apply to these nodes.
  focusNodes?: (string | Term)[];
  // Graph to select the focus nodes in
  graph?: string;
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

const variableToString = (
  variable: Variable,
  name: (variable: Variable) => string,
) => `?${name(variable)}`;
const toTerm = (value: string | Term) =>
  typeof value === "string" ? rdf.namedNode(value) : value;

const predicatePath = (value: string): PredicatePath => ({
  type: "predicate",
  iri: value,
  inverse: false,
});
const invertPath = (path: PredicatePath): PredicatePath => ({
  ...path,
  inverse: !path.inverse,
});
// rdf:type/rdfs:subClassOf*, the path sh:targetClass relies on
const TYPE_PATH: Path = {
  type: "sequence",
  paths: [
    predicatePath(PREFIXES.rdf + "type"),
    { type: "zeroOrMore", path: predicatePath(PREFIXES.rdfs + "subClassOf") },
  ],
};

function pathToString(path: Path): string {
  switch (path.type) {
    case "predicate":
      return (path.inverse ? "^" : "") + iriToString(path.iri);
    case "sequence":
      return `(${path.paths.map(pathToString).join("/")})`;
    case "zeroOrMore":
      return `(${pathToString(path.path)})*`;
  }
}

// VALUES restricting a focus node variable to the given focus nodes, if any
function focusNodeRestriction(
  focus: Variable,
  focusNodes?: Term[],
): Fragment[] {
  if (!focusNodes) return [];
  const values = focusNodes.map(termToString).join(" ");
  return [(name) => `VALUES ${variableToString(focus, name)} { ${values} }`];
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
  variableCount = 0;

  constructor(shapes) {
    this.shapes = shapes;
  }

  createVariable(hint: string): Variable {
    const name =
      hint.replace(/^.*[#/:]/, "").replace(/[^A-Za-z0-9_]/g, "_") || "v";
    return `${name}_${++this.variableCount}`;
  }

  getObjects(subject, predicate: string) {
    return [...this.shapes.match(subject, rdf.namedNode(predicate))].map(
      (quad) => quad.object,
    );
  }

  hasTrueValue(subject, predicate: string) {
    return this.getObjects(subject, predicate).some(
      (object) =>
        object.value === "true" && object.datatype?.value === XSD_BOOLEAN,
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
    return classes.map((targetClass) => (focus) => [
      (name) =>
        `${variableToString(focus, name)} ${pathToString(TYPE_PATH)} ${termToString(targetClass)} .`,
    ]);
  }

  // sh:targetNode
  getNodeTargets(shape): CreateTarget[] {
    const nodes = this.getObjects(shape, PREFIXES.sh + "targetNode");
    if (!nodes.length) return [];
    const values = nodes.map(termToString).join(" ");
    return [
      (focus) => [
        (name) => `VALUES ${variableToString(focus, name)} { ${values} }`,
      ],
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
    return [...subjectsOf, ...objectsOf].map((path) => (focus, focusNodes) => [
      (name) => {
        const values = focusNodeRestriction(focus, focusNodes).map((pattern) =>
          pattern(name),
        );
        const variable = variableToString(focus, name);
        return `{ SELECT DISTINCT ${variable} WHERE { ${[...values, ""].join(" ")}${variable} ${pathToString(path)} [] . } }`;
      },
    ]);
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

  // A SPARQL-based target selects its focus nodes with a subquery, restricted
  // to the given focus nodes as well
  getSparqlTarget(
    target,
    select: string,
    focus: Variable,
    focusNodes?: Term[],
  ): Fragment[] {
    const prefixes = this.getPrefixes(target);
    // sh:select holds a SELECT query
    const parsed = parser.parse(select, { prefixes }) as QuerySelect;
    for (const declaration of parsed.context) {
      if (declaration.subType === "prefix") {
        prefixes[declaration.key] = declaration.value.value;
      }
    }
    const ids = new Map<string, Variable>();
    const query = renameVariables(
      expandPrefixes({ ...parsed, context: [] }, prefixes),
      (variable) => {
        if (variable === "this") return focus;
        if (!ids.has(variable)) {
          ids.set(variable, this.createVariable(variable));
        }
        return ids.get(variable);
      },
    );
    if (focusNodes) {
      const values = F.patternValues(
        [F.termVariable(focus, F.gen())],
        focusNodes.map((term) => ({ [focus]: termToAst(term) })),
        F.gen(),
      );
      query.where = F.patternGroup(
        [values, ...query.where.patterns],
        query.where.loc,
      );
    }
    return [
      (name) =>
        `{\n  ${generator.generate(renameVariables(query, name)).replace(/\n/g, "\n  ")}\n}`,
    ];
  }

  // The prefixes declared for a SPARQL-based target (sh:prefixes/sh:declare)
  getPrefixes(target) {
    const prefixes = {};
    for (const declarations of this.getObjects(
      target,
      PREFIXES.sh + "prefixes",
    )) {
      for (const declaration of this.getObjects(
        declarations,
        PREFIXES.sh + "declare",
      )) {
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

  // Shapes with a target, as the validator would select them
  getTargetedShapes() {
    const shapes = rdf.termSet();
    for (const target of TARGET_PREDICATES) {
      for (const quad of this.shapes.match(
        null,
        rdf.namedNode(PREFIXES.sh + target),
      )) {
        shapes.add(quad.subject);
      }
    }
    for (const type of ["NodeShape", "PropertyShape"]) {
      for (const quad of this.shapes.match(
        null,
        rdf.namedNode(PREFIXES.rdf + "type"),
        rdf.namedNode(PREFIXES.sh + type),
      )) {
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
        targets = [() => []];
      }
      return targets.map((createTarget) => {
        const focus = this.createVariable("this");
        const restriction = focusNodeRestriction(focus, focusNodes);
        const select = createTarget(focus, focusNodes);
        return { index, restriction, select };
      });
    });
  }

  // A branch per target, binding the index of its shape to ?shape when it
  // selects a focus node. Shapes can be blank nodes, which can't be bound.
  getTargetBranches(options: SparqlGenerationOptions) {
    const shapes = this.getSelectedShapes(options);
    const branches: Fragment[][] = this.getFocusTargets(shapes, options).map(
      ({ index, restriction, select }) => [
        ...restriction,
        ...select,
        () => `BIND(${index} AS ?shape)`,
      ],
    );
    return { shapes, branches };
  }
}

// Each branch gets its own variables, numbered in order of appearance
function renderBranch(branch: Fragment[], next: () => number) {
  const names = new Map<Variable, string>();
  const name = (variable: Variable) => {
    if (!names.has(variable)) {
      names.set(variable, `${variable.replace(/_\d+$/, "")}_${next()}`);
    }
    return names.get(variable);
  };
  return branch.map((pattern) => pattern(name));
}

// Branches only differing in their variables select the same, e.g. two
// identical targets of a shape
function renderDistinctBranches(branches: Fragment[][]) {
  const distinctBranches = new Map<string, Fragment[]>();
  for (const branch of branches) {
    let local = 0;
    const key = renderBranch(branch, () => ++local).join("\n");
    if (!distinctBranches.has(key)) distinctBranches.set(key, branch);
  }
  let count = 0;
  return [...distinctBranches.values()].map((branch) =>
    renderBranch(branch, () => ++count),
  );
}

// The UNION of the patterns of the rendered branches
function renderUnion(rendered: string[][], graph?: string) {
  const unions = rendered.map((patterns) => {
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
    sparqlGenerator.getTargetBranches(options);
  if (!branches.length) return undefined;

  return {
    shapes: selectedShapes,
    query: `SELECT DISTINCT ?shape WHERE {
${renderUnion(renderDistinctBranches(branches), options.graph)}
}`,
  };
}
