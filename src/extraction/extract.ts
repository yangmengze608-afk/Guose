import path from "node:path";

import postcss from "postcss";
import valueParser from "postcss-value-parser";
import ts from "typescript";
import { isStaticColorSyntax } from "./color-syntax.js";
import { extractApplicationEvidence } from "./application.js";
import { obviousNonProductionPath } from "../utils/non-production-path.js";

import type {
  ObservedEvidence,
  SourceLocation,
  UnknownFinding,
} from "../schemas/index.js";

const DETECTOR_VERSION = "0.1.0";
const COLOR_FUNCTIONS = new Set([
  "color",
  "hsl",
  "hsla",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "rgb",
  "rgba",
]);
const COLOR_KEYWORDS = new Set([
  "black",
  "currentcolor",
  "transparent",
  "white",
]);

export interface ExtractionResult {
  observations: ObservedEvidence[];
  unknowns: UnknownFinding[];
}

export interface ExtractionOptions {
  tailwind: boolean;
}

type FileRole = "PRODUCTION" | "TEST" | "STORY" | "GENERATED" | "VENDOR";

function fileRole(file: string): FileRole {
  const obviousRole = obviousNonProductionPath(file);
  if (obviousRole !== null) return obviousRole;
  if (/(?:^|\/)(?:vendor|third_party)(?:\/|$)/u.test(file)) return "VENDOR";
  if (
    /(?:^|\/)(?:generated|__generated__)(?:\/|$)|\.generated\.[^.]+$/u.test(
      file,
    )
  ) {
    return "GENERATED";
  }
  if (/(?:^|\/)(?:stories|storybook)(?:\/|$)|\.stories\.[^.]+$/u.test(file)) {
    return "STORY";
  }
  if (
    /(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)|\.(?:test|spec)\.[^.]+$/u.test(
      file,
    )
  ) {
    return "TEST";
  }
  return "PRODUCTION";
}

function spanFromOffsets(
  file: string,
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
): SourceLocation {
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    type: "SPAN",
    file,
    startLine: startPosition.line + 1,
    startColumn: startPosition.character,
    endLine: endPosition.line + 1,
    endColumn: endPosition.character,
  };
}

function cssDeclarationSpan(
  file: string,
  declaration: postcss.Declaration,
): SourceLocation {
  const start = declaration.source?.start;
  const end = declaration.source?.end;
  if (start === undefined || end === undefined) return { type: "FILE", file };
  return {
    type: "SPAN",
    file,
    startLine: start.line,
    startColumn: start.column - 1,
    endLine: end.line,
    endColumn: end.column,
  };
}

function normalizeColor(raw: string): string {
  return raw.trim().replace(/\s+/gu, " ").toLowerCase();
}

function colorNodes(value: string, allowKeyword: boolean): string[] {
  const colors: string[] = [];
  valueParser(value).walk((node) => {
    if (node.type === "function" && node.value.toLowerCase() === "url") {
      return false;
    }
    if (node.type === "word") {
      const normalized = node.value.toLowerCase();
      if (
        /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.test(
          normalized,
        ) ||
        (allowKeyword && COLOR_KEYWORDS.has(normalized))
      ) {
        colors.push(node.value);
      }
    } else if (node.type === "function" && COLOR_FUNCTIONS.has(node.value.toLowerCase())) {
      const candidate = valueParser.stringify(node);
      if (isStaticColorSyntax(candidate)) colors.push(candidate);
      return false;
    }
    return undefined;
  });
  return colors;
}

function supportsColorKeyword(property: string): boolean {
  return /(?:^|-)color$/u.test(property) ||
    /^(?:background|border(?:-.+)?|outline|fill|stroke|box-shadow|text-shadow|caret-color|accent-color)$/u.test(
      property,
    );
}

function observation(
  id: string,
  kind: string,
  value: Record<string, unknown>,
  source: SourceLocation,
  contextEvidenceIds?: string[],
): ObservedEvidence {
  const base = {
    id,
    status: "OBSERVED",
    kind,
    value: {
      ...value,
      detector: "rules-only",
      detectorVersion: DETECTOR_VERSION,
    },
    source,
  } as const;
  return contextEvidenceIds === undefined
    ? base
    : { ...base, contextEvidenceIds };
}

function cssMetricKind(property: string): string | null {
  if (property === "border-radius" || property.endsWith("-radius")) return "radius";
  if (property === "box-shadow" || property === "text-shadow") return "shadow";
  if (property === "font-family") return "font_family";
  if (property === "font-size") return "font_size";
  if (property === "font-weight") return "font_weight";
  if (
    /^(gap|row-gap|column-gap|margin(?:-.+)?|padding(?:-.+)?|inset(?:-.+)?|top|right|bottom|left)$/u.test(
      property,
    )
  ) {
    return "spacing";
  }
  return null;
}

function extractCss(file: string, source: string): ExtractionResult {
  const observations: ObservedEvidence[] = [];
  const unknowns: UnknownFinding[] = [];
  let root: postcss.Root;
  try {
    root = postcss.parse(source, { from: file });
  } catch {
    unknowns.push({
      id: `unknown:css-parse:${file}`,
      status: "UNKNOWN",
      kind: "css_parse",
      reasonCode: "PARSE_FAILED",
      reason: "CSS could not be parsed; source text is not included in diagnostics.",
      relatedEvidenceIds: [],
      source: { type: "FILE", file },
    });
    return { observations, unknowns };
  }

  root.walkAtRules("import", (rule) => {
    const specifier = valueParser(rule.params).nodes[0];
    if (specifier?.type === "string") observations.push(observation(
      `css-import:${file}:${rule.source?.start?.line ?? 0}:${rule.source?.start?.column ?? 0}`,
      "css_dependency_reference", { specifier: specifier.value }, { type: "FILE", file },
    ));
    else unknowns.push({ id: `unknown:css-import:${file}:${rule.source?.start?.line ?? 0}`,
      status: "UNKNOWN", kind: "css_dependency", reasonCode: "UNSUPPORTED",
      reason: "CSS import dependency cannot be statically resolved by the supported literal path grammar.",
      relatedEvidenceIds: [], source: { type: "FILE", file } });
  });
  root.walkDecls((declaration) => {
    const property = declaration.prop.toLowerCase();
    const sourceLocation = cssDeclarationSpan(file, declaration);
    const selector = declaration.parent?.type === "rule" ? declaration.parent.selector : null;
    const atRule = declaration.parent?.type === "atrule" ? declaration.parent.name : null;
    const conditionalAtRules: string[] = [];
    let ancestor: postcss.Root | postcss.Rule | postcss.AtRule | postcss.Document | undefined = declaration.parent;
    while (ancestor !== undefined) {
      if (ancestor.type === "atrule" && !["layer", "theme"].includes(ancestor.name)) {
        conditionalAtRules.push(`@${ancestor.name} ${ancestor.params}`);
      }
      ancestor = ancestor.parent;
    }
    const context = { atRule, conditionalAtRules, fileRole: fileRole(file), property, selector };
    if (supportsColorKeyword(property) || property.startsWith("--")) {
      valueParser(declaration.value).walk((node) => {
        if (node.type === "function" && node.value.toLowerCase() === "url") return false;
        if (node.type === "function" && COLOR_FUNCTIONS.has(node.value.toLowerCase())) {
          if (!isStaticColorSyntax(valueParser.stringify(node))) unknowns.push({
            id: `unknown:css-color:${file}:${declaration.source?.start?.line ?? 1}:${declaration.source?.start?.column ?? 1}:${node.sourceIndex}`,
            status: "UNKNOWN",
            kind: "css_color_syntax",
            reasonCode: "INSUFFICIENT_EVIDENCE",
            reason: "Color function is outside the bounded static numeric grammar; its validity and resolved value are unknown.",
            relatedEvidenceIds: [],
            scope: `CSS declaration ${declaration.prop}`,
            source: sourceLocation,
          });
          return false;
        }
        return undefined;
      });
    }

    if (property.startsWith("--")) {
      observations.push(
        observation(
          `css-variable:${file}:${sourceLocation.type === "SPAN" ? `${sourceLocation.startLine}:${sourceLocation.startColumn}` : "file"}:${property}`,
          "design_token_declaration",
          {
            tokenType: "css_custom_property",
            name: declaration.prop,
            rawValue: declaration.value,
            normalizedValue: declaration.value.trim(),
            context,
          },
          sourceLocation,
        ),
      );
    }

    const variableReferences = [...declaration.value.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/gu)];
    for (const [index, match] of variableReferences.entries()) {
      observations.push(
        observation(
          `css-variable-reference:${file}:${declaration.source?.start?.line ?? 1}:${declaration.source?.start?.column ?? 1}:${index}`,
          "design_token_usage",
          {
            tokenType: "css_custom_property_reference",
            name: match[1],
            rawValue: match[0],
            normalizedValue: match[1],
            context,
          },
          sourceLocation,
        ),
      );
    }

    for (const [index, rawColor] of colorNodes(
      supportsColorKeyword(property) || property.startsWith("--") ? declaration.value : "",
      supportsColorKeyword(property),
    ).entries()) {
      observations.push(
        observation(
          `css-color:${file}:${declaration.source?.start?.line ?? 1}:${declaration.source?.start?.column ?? 1}:${index}`,
          "design_value_usage",
          {
            tokenType: "color",
            rawValue: rawColor,
            normalizedValue: normalizeColor(rawColor),
            context,
          },
          sourceLocation,
        ),
      );
    }

    const metricKind = cssMetricKind(property);
    if (metricKind !== null) {
      observations.push(
        observation(
          `css-metric:${file}:${declaration.source?.start?.line ?? 1}:${declaration.source?.start?.column ?? 1}:${property}`,
          "design_value_usage",
          {
            tokenType: metricKind,
            rawValue: declaration.value,
            normalizedValue: declaration.value.trim(),
            context,
          },
          sourceLocation,
        ),
      );
    }
  });

  return { observations, unknowns };
}

interface TailwindClassification {
  tokenType: string;
  ambiguity?: string;
}

const SEMANTIC_COLOR_NAMES = new Set([
  "primary-foreground", "secondary-foreground", "destructive-foreground",
  "accent-foreground", "muted-foreground", "card-foreground", "popover-foreground",
  "accent",
  "background",
  "border",
  "card",
  "current",
  "destructive",
  "foreground",
  "inherit",
  "input",
  "muted",
  "popover",
  "primary",
  "ring",
  "secondary",
  "surface",
  "transparent",
  "black",
  "white",
]);

function baseUtility(token: string): string {
  let bracketDepth = 0;
  let split = -1;
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index];
    if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (character === ":" && bracketDepth === 0) split = index;
  }
  return token.slice(split + 1).replace(/^!/u, "");
}

function isKnownNonColor(prefix: string, suffix: string): boolean {
  if (prefix === "bg") {
    return /^(?:auto|fixed|local|scroll|bottom|center|left|right|top|repeat(?:-.+)?|no-repeat|cover|contain|clip-.+|origin-.+|blend-.+|gradient-.+)$/u.test(
      suffix,
    );
  }
  if (prefix === "text") {
    return /^(?:left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|uppercase|lowercase|capitalize|normal-case)$/u.test(
      suffix,
    );
  }
  if (prefix.startsWith("border")) {
    return /^(?:0|2|4|8|solid|dashed|dotted|double|hidden|none|collapse|separate|spacing-.+)$/u.test(
      suffix,
    );
  }
  if (prefix === "ring") return /^(?:0|1|2|4|8|inset|offset-\d+)$/u.test(suffix);
  if (prefix === "outline") {
    return /^(?:0|1|2|4|8|none|hidden|dashed|dotted|double|offset-.+)$/u.test(
      suffix,
    );
  }
  if (prefix === "stroke" || prefix === "decoration") return /^\d+$/u.test(suffix);
  return false;
}

function tailwindKind(token: string): TailwindClassification | null {
  const base = baseUtility(token);
  const positiveBase = base.replace(/^-/, "");
  if (/^rounded(?:-|$)/u.test(positiveBase)) return { tokenType: "radius" };
  if (/^shadow(?:-|$)/u.test(positiveBase)) {
    if (/^shadow(?:-(?:sm|md|lg|xl|2xl|inner|none))?$/u.test(positiveBase)) {
      return { tokenType: "shadow" };
    }
    return {
      tokenType: "ambiguous_shadow_candidate",
      ambiguity: "Shadow utility color versus shape has not been resolved.",
    };
  }
  if (
    /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/u.test(
      positiveBase,
    ) ||
    /^font-\[weight:.+\]$/u.test(positiveBase)
  ) {
    return { tokenType: "font_weight" };
  }
  if (/^font-\[family-name:.+\]$/u.test(positiveBase)) {
    return { tokenType: "font_family_candidate" };
  }
  if (/^font-\[.+\]$/u.test(positiveBase)) {
    return {
      tokenType: "ambiguous_font_candidate",
      ambiguity: "An arbitrary font utility does not identify family versus weight.",
    };
  }
  if (/^font-/u.test(positiveBase)) return { tokenType: "font_family_candidate" };
  if (
    /^text-(?:xs|sm|base|lg|xl|[2-9]xl)(?:\/.+)?$/u.test(positiveBase) ||
    (positiveBase.startsWith("text-[") && positiveBase.endsWith("]") &&
      !positiveBase.slice(6, -1).includes("]") && ["px", "rem", "em"].some((unit) => positiveBase.slice(6, -1).includes(unit))) ||
    /^text-\[length:.+\]$/u.test(positiveBase)
  ) {
    return { tokenType: "font_size" };
  }
  if (
    /^(?:p[trblxy]?|m[trblxy]?|gap[xy]?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left)-/u.test(
      positiveBase,
    )
  ) {
    return { tokenType: "spacing" };
  }

  const colorMatch = /^(bg|text|border(?:-[trblxy])?|ring|outline|fill|stroke|decoration)-(.+)$/u.exec(
    positiveBase,
  );
  if (colorMatch === null) return null;
  const prefix = colorMatch[1] ?? "";
  const suffix = colorMatch[2] ?? "";
  if (isKnownNonColor(prefix, suffix)) return null;
  const arbitrary = /^\[(.*)\]$/u.exec(suffix)?.[1];
  if (arbitrary !== undefined) {
    if (
      /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(
        arbitrary,
      ) ||
      isStaticColorSyntax(arbitrary.replace(/_/gu, " "))
    ) {
      return { tokenType: "color_candidate" };
    }
    if (/^(?:url\(|image\(|linear-gradient\(|radial-gradient\()/u.test(arbitrary)) {
      return null;
    }
    return {
      tokenType: "ambiguous_color_candidate",
      ambiguity: "An arbitrary utility value cannot be proven to be a color.",
    };
  }
  const normalizedSuffix = suffix.replace(/\/.+$/u, "");
  if (
    SEMANTIC_COLOR_NAMES.has(normalizedSuffix) ||
    /-(?:50|100|200|300|400|500|600|700|800|900|950)$/u.test(
      normalizedSuffix,
    )
  ) {
    return { tokenType: "color_candidate" };
  }
  return {
    tokenType: "ambiguous_color_candidate",
    ambiguity: "The utility name could not be tied to a known color token.",
  };
}

function extractClassLiteral(
  file: string,
  sourceFile: ts.SourceFile,
  literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral,
  context: string,
  usageMode: "STATIC" | "CONDITIONAL",
  unknowns: UnknownFinding[],
  component?: { id: string; name: string },
): ObservedEvidence[] {
  const literalStart = literal.getStart(sourceFile);
  const literalEnd = literal.getEnd();
  const literalSource = spanFromOffsets(file, sourceFile, literalStart, literalEnd);
  const rawLiteral = sourceFile.text.slice(literalStart, literalEnd);
  const tokenSpansReliable = rawLiteral.slice(1, -1) === literal.text;
  const sourceUnit = path.basename(file, path.extname(file));
  return [...literal.text.matchAll(/\S+/gu)].flatMap((match, index) => {
      const rawClass = match[0];
      const tokenStart = match.index;
      const source = tokenSpansReliable
        ? spanFromOffsets(
            file,
            sourceFile,
            literalStart + 1 + tokenStart,
            literalStart + 1 + tokenStart + rawClass.length,
          )
        : literalSource;
      const classification = tailwindKind(rawClass);
      if (classification === null) return [];
      const id = `tailwind-class:${file}:${source.type === "SPAN" ? `${source.startLine}:${source.startColumn}` : "file"}:${index}`;
      const observed = observation(
          id,
          classification.ambiguity === undefined ? "design_value_usage" : "class_literal",
          {
            tokenType: classification.tokenType,
            rawValue: rawClass,
            normalizedValue: rawClass,
            context: {
              ...(component === undefined ? {} : { component: component.name }),
              expression: context,
              fileRole: fileRole(file),
              sourceUnit,
              tokenSpanReliable: tokenSpansReliable,
              usageMode,
            },
          },
          source,
          component === undefined ? undefined : [component.id],
        );
      if (classification.ambiguity !== undefined) {
        unknowns.push({
          id: `unknown:tailwind-class-semantics:${file}:${source.type === "SPAN" ? `${source.startLine}:${source.startColumn}` : "file"}:${index}`,
          status: "UNKNOWN",
          kind: "tailwind_class_semantics",
          reasonCode: "INSUFFICIENT_EVIDENCE",
          reason: classification.ambiguity,
          relatedEvidenceIds: [id],
          source,
        });
      }
      return [observed];
    });
}

interface ComponentContext {
  id: string;
  name: string;
  observation: ObservedEvidence;
}

type ClassHelper = "cn" | "clsx" | "cva";

interface SourceBindings {
  classHelpers: Map<string, ClassHelper>;
  reactNamespaces: Set<string>;
  reactWrappers: Map<string, "forwardRef" | "memo">;
}

function sourceBindings(sourceFile: ts.SourceFile): SourceBindings {
  const bindings: SourceBindings = {
    classHelpers: new Map(),
    reactNamespaces: new Set(),
    reactWrappers: new Map(),
  };
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const moduleName = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (moduleName === "react") {
      if (clause.name !== undefined) bindings.reactNamespaces.add(clause.name.text);
      if (clause.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          bindings.reactNamespaces.add(clause.namedBindings.name.text);
        } else {
          for (const element of clause.namedBindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (imported === "forwardRef" || imported === "memo") {
              bindings.reactWrappers.set(element.name.text, imported);
            }
          }
        }
      }
    }
    if (moduleName === "clsx" && clause.name !== undefined) {
      bindings.classHelpers.set(clause.name.text, "clsx");
    }
    if (clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) {
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (moduleName === "class-variance-authority" && imported === "cva") {
        bindings.classHelpers.set(element.name.text, "cva");
      } else if (moduleName === "clsx" && imported === "clsx") {
        bindings.classHelpers.set(element.name.text, "clsx");
      }
    }
  }
  return bindings;
}

function wrapperName(
  call: ts.CallExpression,
  bindings: SourceBindings,
  checker: ts.TypeChecker,
): "forwardRef" | "memo" | null {
  if (ts.isIdentifier(call.expression) && isRuntimeImport(checker.getSymbolAtLocation(call.expression))) {
    return bindings.reactWrappers.get(call.expression.text) ?? null;
  }
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    isRuntimeImport(checker.getSymbolAtLocation(call.expression.expression)) &&
    bindings.reactNamespaces.has(call.expression.expression.text) &&
    (call.expression.name.text === "forwardRef" || call.expression.name.text === "memo")
  ) {
    return call.expression.name.text;
  }
  return null;
}

function isRuntimeImport(symbol: ts.Symbol | undefined): boolean {
  return symbol?.declarations?.some((declaration) => {
    if (ts.isImportClause(declaration)) return !declaration.isTypeOnly;
    if (ts.isNamespaceImport(declaration)) return !declaration.parent.isTypeOnly;
    if (ts.isImportSpecifier(declaration)) {
      return !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly;
    }
    return false;
  }) === true;
}

function componentContext(
  file: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  jsxPresence: WeakMap<ts.Node, boolean>,
  bindings: SourceBindings,
  checker: ts.TypeChecker,
): ComponentContext | null {
  function containsJsx(candidate: ts.Node): boolean {
    const cached = jsxPresence.get(candidate);
    if (cached !== undefined) return cached;
    let found = false;
    function visit(child: ts.Node): void {
      if (child !== candidate && ts.isFunctionLike(child)) return;
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
        found = true;
        return;
      }
      if (!found) ts.forEachChild(child, visit);
    }
    visit(candidate);
    jsxPresence.set(candidate, found);
    return found;
  }

  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    let nameNode: ts.Identifier | undefined;
    let declarationKind: string | undefined;
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
      nameNode = current.name;
      declarationKind = "function";
    } else if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current)
    ) {
      let owner: ts.Node = current;
      let wrapper: "forwardRef" | "memo" | null = null;
      while (
        ts.isCallExpression(owner.parent) &&
        owner.parent.arguments.includes(owner as ts.Expression)
      ) {
        const currentWrapper = wrapperName(owner.parent, bindings, checker);
        if (currentWrapper === null) break;
        wrapper = currentWrapper;
        owner = owner.parent;
      }
      if (
        ts.isVariableDeclaration(owner.parent) &&
        ts.isIdentifier(owner.parent.name)
      ) {
        nameNode = owner.parent.name;
        declarationKind = wrapper === null ? "variable" : wrapper;
      }
    } else if (ts.isClassDeclaration(current) && current.name !== undefined) {
      nameNode = current.name;
      declarationKind = "class";
    }

    if (
      nameNode !== undefined &&
      /^[A-Z]/u.test(nameNode.text) &&
      containsJsx(current)
    ) {
      const source = spanFromOffsets(
        file,
        sourceFile,
        nameNode.getStart(sourceFile),
        nameNode.getEnd(),
      );
      const id = `component:${file}:${source.type === "SPAN" ? `${source.startLine}:${source.startColumn}` : "file"}:${nameNode.text}`;
      return {
        id,
        name: nameNode.text,
        observation: observation(
          id,
          "component_declaration",
          {
            tokenType: "react_component",
            rawValue: nameNode.text,
            normalizedValue: nameNode.text,
            context: { declarationKind, fileRole: fileRole(file) },
          },
          source,
        ),
      };
    }
    current = current.parent;
  }
  return null;
}

function syntaxUnknown(
  file: string,
  source: string,
  sourceFile: ts.SourceFile,
): UnknownFinding | null {
  // Declaration files cannot be transpiled. Syntax checking needs no emit,
  // module resolution, filesystem access, or execution of target code.
  const diagnostics = sourceFile.isDeclarationFile ? ts.createProgram([file], { noResolve: true, noLib: true }, {
    getSourceFile: (name) => name === file ? sourceFile : undefined,
    getDefaultLibFileName: () => "",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => name === file,
    readFile: (name) => name === file ? source : undefined,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  }).getSyntacticDiagnostics(sourceFile) : ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
  }).diagnostics;
  const diagnostic = diagnostics?.find(
    ({ category }) => category === ts.DiagnosticCategory.Error,
  );
  if (diagnostic === undefined) return null;

  const start = diagnostic.start ?? 0;
  const end = start + (diagnostic.length ?? 0);
  return {
    id: `unknown:source-parse:${file}`,
    status: "UNKNOWN",
    kind: "source_parse",
    reasonCode: "PARSE_FAILED",
    reason: "Source could not be parsed; source text is not included in diagnostics.",
    relatedEvidenceIds: [],
    source: spanFromOffsets(file, sourceFile, start, end),
  };
}

function unresolvedClass(
  file: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  index: number,
): UnknownFinding {
  return {
    id: `unknown:dynamic-class:${file}:${index}`,
    status: "UNKNOWN",
    kind: "dynamic_tailwind_class",
    reasonCode: "INSUFFICIENT_EVIDENCE",
    reason: "A dynamic class expression cannot be resolved without executing target code.",
    relatedEvidenceIds: [],
    scope: "static class expression",
    source: spanFromOffsets(file, sourceFile, node.getStart(sourceFile), node.getEnd()),
  };
}

function extractSource(file: string, source: string): ExtractionResult {
  const observations: ObservedEvidence[] = [];
  const unknowns: UnknownFinding[] = [];
  const scriptKind = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.(?:cjs|mjs|js)$/u.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const parseFailure = syntaxUnknown(file, source, sourceFile);
  if (parseFailure !== null) {
    return { observations, unknowns: [parseFailure] };
  }
  // Ambient declarations are not runtime class/component evidence.
  if (sourceFile.isDeclarationFile) return { observations, unknowns };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && /\.css$/u.test(statement.moduleSpecifier.text)) {
      observations.push(observation(`css-import:${file}:${statement.moduleSpecifier.getStart(sourceFile)}`,
        "css_dependency_reference", { specifier: statement.moduleSpecifier.text },
        spanFromOffsets(file, sourceFile, statement.moduleSpecifier.getStart(sourceFile), statement.moduleSpecifier.getEnd())));
    }
  }
  let dynamicIndex = 0;
  const components = new Map<string, ObservedEvidence>();
  const jsxPresence = new WeakMap<ts.Node, boolean>();
  const bindings = sourceBindings(sourceFile);
  // Single in-memory source: resolve lexical identity without reading modules,
  // evaluating target code, or trusting a same-spelled local declaration.
  const program = ts.createProgram([file], { noResolve: true, noLib: true, allowJs: true, jsx: ts.JsxEmit.Preserve }, {
    getSourceFile: (name) => name === file ? sourceFile : undefined,
    getDefaultLibFileName: () => "",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => name === file,
    readFile: () => undefined,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  });
  const checker = program.getTypeChecker();
  const cvaDefinitions = new Map<ts.Symbol, { name: string; ids: string[] }>();

  function dynamicUnknown(
    file: string,
    sourceFile: ts.SourceFile,
    node: ts.Node,
    index: number,
  ): UnknownFinding {
    const finding = unresolvedClass(file, sourceFile, node, index);
    const component = componentContext(file, sourceFile, node, jsxPresence, bindings, checker);
    if (component === null) return finding;
    components.set(component.id, component.observation);
    return { ...finding, relatedEvidenceIds: [component.id] };
  }

  function helperKind(call: ts.CallExpression): ClassHelper | null {
    if (!ts.isIdentifier(call.expression)) return null;
    const name = call.expression.text;
    if (!isRuntimeImport(checker.getSymbolAtLocation(call.expression))) return null;
    return bindings.classHelpers.get(name) ?? null;
  }

  function classLiteral(
    literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral,
    context: string,
    usageMode: "STATIC" | "CONDITIONAL",
    helper?: ClassHelper,
  ): ObservedEvidence[] {
    const component = componentContext(
      file,
      sourceFile,
      literal,
      jsxPresence,
      bindings,
      checker,
    );
    if (component !== null) components.set(component.id, component.observation);
    const extracted = extractClassLiteral(
      file,
      sourceFile,
      literal,
      context,
      usageMode,
      unknowns,
      component === null ? undefined : component,
    );
    // Preserve AST structure, never evaluate a variant expression.
    let ancestor: ts.Node | undefined = literal;
    let choice: ts.PropertyAssignment | undefined;
    let axis: ts.PropertyAssignment | undefined;
    let definition: string | undefined;
    let definitionSource: ReturnType<typeof spanFromOffsets> | undefined;
    let defaultVariant: string | undefined;
    let defaultVariantSource: ReturnType<typeof spanFromOffsets> | undefined;
    const staticName = (name: ts.PropertyName): string | undefined =>
      ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
    while (ancestor !== undefined) {
      if (ts.isPropertyAssignment(ancestor) && ts.isObjectLiteralExpression(ancestor.parent)) {
        const parent = ancestor.parent.parent;
        if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent) &&
            ts.isPropertyAssignment(parent.parent.parent) && staticName(parent.parent.parent.name) === "variants") {
          choice = ancestor; axis = parent;
        }
      }
      if (ts.isCallExpression(ancestor) && helperKind(ancestor) === "cva") {
        if (ts.isVariableDeclaration(ancestor.parent) && ts.isIdentifier(ancestor.parent.name)) {
          definition = ancestor.parent.name.text;
          definitionSource = spanFromOffsets(file, sourceFile, ancestor.getStart(sourceFile), ancestor.getEnd());
        }
        const options = ancestor.arguments[1];
        if (options && ts.isObjectLiteralExpression(options) && axis) {
          const defaults = options.properties.find(p => ts.isPropertyAssignment(p) && staticName(p.name) === "defaultVariants");
          if (defaults && ts.isPropertyAssignment(defaults) && ts.isObjectLiteralExpression(defaults.initializer)) {
            const selection = defaults.initializer.properties.find(p => ts.isPropertyAssignment(p) && staticName(p.name) === staticName(axis!.name));
            if (selection && ts.isPropertyAssignment(selection) && (ts.isStringLiteral(selection.initializer) ||
                selection.initializer.kind === ts.SyntaxKind.TrueKeyword || selection.initializer.kind === ts.SyntaxKind.FalseKeyword)) {
              defaultVariant = ts.isStringLiteral(selection.initializer) ? selection.initializer.text : selection.initializer.getText(sourceFile);
              defaultVariantSource = spanFromOffsets(file, sourceFile, selection.getStart(sourceFile), selection.getEnd());
            }
          }
        }
        break;
      }
      ancestor = ancestor.parent;
    }
    return extracted.map(evidence => {
      const data = evidence.value as Record<string, unknown>;
      const utility = typeof data.rawValue === "string" ? baseUtility(data.rawValue) : "";
      const prefix = typeof data.tokenType === "string" && data.tokenType.includes("color") ? /^(bg|text|border|ring)-/u.exec(utility)?.[1] : undefined;
      return { ...evidence, value: {
      ...(evidence.value as Record<string, unknown>),
      context: { ...((evidence.value as Record<string, unknown>).context as Record<string, unknown>),
        helper: helper ?? context,
        styleProperty: prefix === "bg" ? "background" : prefix === "text" ? "foreground" : prefix ?? null,
        ...(definition === undefined ? {} : { cvaDefinition: definition, cvaDefinitionSource: definitionSource }),
        ...(choice === undefined || axis === undefined ? {} : {
          variantName: staticName(axis.name) ?? null, variantValue: staticName(choice.name) ?? null,
          defaultVariant: defaultVariant ?? null,
          defaultVariantSource: defaultVariantSource ?? null,
          variantSource: spanFromOffsets(file, sourceFile, choice.getStart(sourceFile), choice.getEnd()),
        }),
      },
    } }; });
  }

  function cvaBinding(call: ts.CallExpression): string | null {
    if (!ts.isIdentifier(call.expression)) return null;
    const symbol = checker.getSymbolAtLocation(call.expression);
    return symbol === undefined ? null : cvaDefinitions.get(symbol)?.name ?? null;
  }

  function addCvaUsage(call: ts.CallExpression, binding: string): void {
    const staticSelection = (node: ts.Node): boolean => {
      if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) ||
          node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
      if (ts.isObjectLiteralExpression(node)) return node.properties.every(property =>
        ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && staticSelection(property.initializer));
      return false;
    };
    if (!call.arguments.every(staticSelection)) unknowns.push(dynamicUnknown(file, sourceFile, call, dynamicIndex++));
    const component = componentContext(
      file,
      sourceFile,
      call,
      jsxPresence,
      bindings,
      checker,
    );
    if (component !== null) components.set(component.id, component.observation);
    const source = spanFromOffsets(
      file,
      sourceFile,
      call.getStart(sourceFile),
      call.getEnd(),
    );
    const symbol = checker.getSymbolAtLocation(call.expression);
    const definitionIds = symbol === undefined ? [] : cvaDefinitions.get(symbol)?.ids ?? [];
    const contextEvidenceIds = [
      ...(component === null ? [] : [component.id]),
      ...definitionIds,
    ];
    observations.push(
      observation(
        `component-style-reference:${file}:${source.type === "SPAN" ? `${source.startLine}:${source.startColumn}` : "file"}:${binding}`,
        "component_style_usage",
        {
          tokenType: "cva_reference",
          rawValue: binding,
          normalizedValue: binding,
          context: {
            ...(component === null ? {} : { component: component.name }),
            fileRole: fileRole(file),
            referencedEvidenceIds: definitionIds,
            possibleVariantClasses: true,
          },
        },
        source,
        contextEvidenceIds.length === 0 ? undefined : contextEvidenceIds,
      ),
    );
  }

  function collectCallValue(
    node: ts.Node,
    conditional: boolean,
    helper: ClassHelper,
  ): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      observations.push(
        ...classLiteral(
          node,
          "class helper",
          conditional ? "CONDITIONAL" : "STATIC",
          helper,
        ),
      );
      return;
    }
    if (ts.isTemplateExpression(node)) {
      unknowns.push(dynamicUnknown(file, sourceFile, node, dynamicIndex++));
      return;
    }
    if (ts.isConditionalExpression(node)) {
      unknowns.push(dynamicUnknown(file, sourceFile, node.condition, dynamicIndex++));
      collectCallValue(node.whenTrue, true, helper);
      collectCallValue(node.whenFalse, true, helper);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      unknowns.push(dynamicUnknown(file, sourceFile, node, dynamicIndex++));
      if (
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) {
          collectCallValue(node.left, true, helper);
        }
        collectCallValue(node.right, true, helper);
      } else {
        unknowns.push(dynamicUnknown(file, sourceFile, node, dynamicIndex++));
      }
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          if (helper === "cva") {
            unknowns.push(dynamicUnknown(file, sourceFile, property, dynamicIndex++));
          } else if (
            ts.isStringLiteral(property.name) ||
            ts.isNoSubstitutionTemplateLiteral(property.name)
          ) {
            observations.push(
              ...classLiteral(property.name, "class helper object key", "CONDITIONAL", helper),
            );
            if (property.initializer.kind !== ts.SyntaxKind.TrueKeyword && property.initializer.kind !== ts.SyntaxKind.FalseKeyword) {
              unknowns.push(dynamicUnknown(file, sourceFile, property.initializer, dynamicIndex++));
            }
          } else {
            unknowns.push(dynamicUnknown(file, sourceFile, property, dynamicIndex++));
          }
        } else if (ts.isSpreadAssignment(property)) {
          unknowns.push(dynamicUnknown(file, sourceFile, property, dynamicIndex++));
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        collectCallValue(element, conditional, helper);
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      const nestedHelper = helperKind(node);
      if (nestedHelper === null) {
        const binding = cvaBinding(node);
        if (binding !== null) {
          addCvaUsage(node, binding);
          return;
        }
        unknowns.push(dynamicUnknown(file, sourceFile, node, dynamicIndex++));
        return;
      }
      for (const [index, argument] of node.arguments.entries()) {
        if (nestedHelper === "cva" && index > 0) collectCvaOptions(argument);
        else collectCallValue(argument, conditional, nestedHelper);
      }
      return;
    }
    if (ts.isParenthesizedExpression(node)) {
      collectCallValue(node.expression, conditional, helper);
      return;
    }
    if (
      ts.isIdentifier(node) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isCallExpression(node)
    ) {
      unknowns.push(dynamicUnknown(file, sourceFile, node, dynamicIndex++));
      return;
    }
    ts.forEachChild(node, (child) => collectCallValue(child, conditional, helper));
  }

  function collectCvaOptions(node: ts.Node): void {
    if (!ts.isObjectLiteralExpression(node)) {
      unknowns.push(dynamicUnknown(file, sourceFile, node, dynamicIndex++));
      return;
    }
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        unknowns.push(dynamicUnknown(file, sourceFile, property, dynamicIndex++));
        continue;
      }
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text : null;
      if (name === "defaultVariants") {
        if (!ts.isObjectLiteralExpression(property.initializer)) unknowns.push(dynamicUnknown(file, sourceFile, property, dynamicIndex++));
        else for (const selection of property.initializer.properties) {
          if (!ts.isPropertyAssignment(selection) ||
              !(ts.isIdentifier(selection.name) || ts.isStringLiteral(selection.name)) ||
              !(ts.isStringLiteral(selection.initializer) || selection.initializer.kind === ts.SyntaxKind.TrueKeyword || selection.initializer.kind === ts.SyntaxKind.FalseKeyword)) {
            unknowns.push(dynamicUnknown(file, sourceFile, selection, dynamicIndex++));
          }
        }
        continue;
      }
      const value = property.initializer;
      if (name === "variants" && ts.isObjectLiteralExpression(value)) {
        for (const variant of value.properties) {
          if (!ts.isPropertyAssignment(variant) || !(ts.isIdentifier(variant.name) || ts.isStringLiteral(variant.name)) || !ts.isObjectLiteralExpression(variant.initializer)) {
            unknowns.push(dynamicUnknown(file, sourceFile, variant, dynamicIndex++));
            continue;
          }
          for (const choice of variant.initializer.properties) {
            if (ts.isPropertyAssignment(choice) && (ts.isIdentifier(choice.name) || ts.isStringLiteral(choice.name))) collectCallValue(choice.initializer, true, "cva");
            else unknowns.push(dynamicUnknown(file, sourceFile, choice, dynamicIndex++));
          }
        }
      } else if (name === "compoundVariants" && ts.isArrayLiteralExpression(value)) {
        for (const compound of value.elements) {
          if (!ts.isObjectLiteralExpression(compound)) {
            unknowns.push(dynamicUnknown(file, sourceFile, compound, dynamicIndex++));
            continue;
          }
          for (const field of compound.properties) {
            if (!ts.isPropertyAssignment(field)) {
              unknowns.push(dynamicUnknown(file, sourceFile, field, dynamicIndex++));
              continue;
            }
            const fieldName = ts.isIdentifier(field.name) || ts.isStringLiteral(field.name)
              ? field.name.text : null;
            if (fieldName === "class" || fieldName === "className") {
              collectCallValue(field.initializer, true, "cva");
            }
          }
        }
      } else {
        unknowns.push(dynamicUnknown(file, sourceFile, property, dynamicIndex++));
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "className") {
      const initializer = node.initializer;
      const ownerNode =
        initializer !== undefined && ts.isJsxExpression(initializer)
          ? initializer.expression
          : initializer;
      if (ownerNode !== undefined) {
        const component = componentContext(
          file,
          sourceFile,
          ownerNode,
          jsxPresence,
          bindings,
          checker,
        );
        if (component !== null) components.set(component.id, component.observation);
      }
      if (initializer !== undefined && ts.isStringLiteral(initializer)) {
        observations.push(
          ...classLiteral(initializer, "className", "STATIC"),
        );
      } else if (initializer !== undefined && ts.isJsxExpression(initializer)) {
        const expression = initializer.expression;
        if (
          expression !== undefined &&
          (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
        ) {
          observations.push(
            ...classLiteral(expression, "className", "STATIC"),
          );
        } else if (
          expression !== undefined &&
          !(
            ts.isCallExpression(expression) &&
            (helperKind(expression) !== null || cvaBinding(expression) !== null)
          )
        ) {
          unknowns.push(dynamicUnknown(file, sourceFile, expression, dynamicIndex++));
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const helper = helperKind(node);
      if (helper === null) {
        const binding = cvaBinding(node);
        if (binding !== null) {
          addCvaUsage(node, binding);
          return;
        }
        ts.forEachChild(node, visit);
        return;
      }
      const observationStart = observations.length;
      for (const [index, argument] of node.arguments.entries()) {
        if (helper === "cva" && index > 0) collectCvaOptions(argument);
        else collectCallValue(argument, false, helper);
      }
      if (
        helper === "cva" &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name)
      ) {
        const symbol = checker.getSymbolAtLocation(node.parent.name);
        if (symbol !== undefined) cvaDefinitions.set(symbol, {
          name: node.parent.name.text,
          ids: observations.slice(observationStart).map(({ id }) => id),
        });
      }
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  observations.unshift(...components.values());
  return { observations, unknowns };
}

function extractTailwindConfig(file: string, source: string): ExtractionResult {
  const observations: ObservedEvidence[] = [];
  const unknowns: UnknownFinding[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseFailure = syntaxUnknown(file, source, sourceFile);
  if (parseFailure !== null) {
    return { observations, unknowns: [parseFailure] };
  }
  let unknownIndex = 0;

  function propertyName(node: ts.PropertyName): string | null {
    return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
      ? node.text
      : null;
  }

  function propertyPath(property: ts.PropertyAssignment): string[] {
    const names: string[] = [];
    let current: ts.Node | undefined = property;
    while (current !== undefined) {
      if (ts.isPropertyAssignment(current)) {
        const name = propertyName(current.name);
        if (name !== null) names.push(name);
      }
      current = current.parent;
    }
    return names.reverse();
  }

  function belongsToExportedConfig(property: ts.PropertyAssignment): boolean {
    let root: ts.Node = property;
    while (
      root.parent !== undefined &&
      (ts.isObjectLiteralExpression(root.parent) ||
        ts.isPropertyAssignment(root.parent) ||
        ts.isParenthesizedExpression(root.parent) ||
        ts.isAsExpression(root.parent) ||
        ts.isSatisfiesExpression(root.parent))
    ) {
      root = root.parent;
    }
    if (ts.isExportAssignment(root.parent)) return true;
    if (
      ts.isVariableDeclaration(root.parent) &&
      ts.isIdentifier(root.parent.name)
    ) {
      const name = root.parent.name.text;
      return sourceFile.statements.some(
        (statement) =>
          ts.isExportAssignment(statement) &&
          ts.isIdentifier(statement.expression) &&
          statement.expression.text === name,
      );
    }
    if (
      ts.isBinaryExpression(root.parent) &&
      root.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(root.parent.left)
    ) {
      return root.parent.left.getText(sourceFile) === "module.exports";
    }
    return false;
  }

  function configUnknown(node: ts.Node, configPath: string[]): void {
    unknowns.push({
      id: `unknown:tailwind-config:${file}:${unknownIndex++}`,
      status: "UNKNOWN",
      kind: "tailwind_config_color",
      reasonCode: "INSUFFICIENT_EVIDENCE",
      reason: "A Tailwind color configuration subtree is dynamic or uses an unsupported property form.",
      relatedEvidenceIds: [],
      scope: configPath.join(".") || "exported Tailwind configuration",
      source: spanFromOffsets(file, sourceFile, node.getStart(sourceFile), node.getEnd()),
    });
  }

  function extractColorValue(node: ts.Node, configPath: string[]): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isStaticColorSyntax(node.text)) {
        configUnknown(node, configPath);
        return;
      }
      const location = spanFromOffsets(
        file,
        sourceFile,
        node.getStart(sourceFile),
        node.getEnd(),
      );
      observations.push(
        observation(
          `tailwind-config-color:${file}:${location.type === "SPAN" ? `${location.startLine}:${location.startColumn}` : "file"}:${configPath.join(".")}`,
          "design_token_declaration",
          {
            tokenType: "color",
            name: configPath.slice(configPath.indexOf("colors") + 1).join("."),
            rawValue: node.text,
            normalizedValue: node.text.trim().replace(/\s+/gu, " "),
            context: {
              configPath: configPath.join("."),
              configuration: "tailwind",
              fileRole: fileRole(file),
            },
          },
          location,
        ),
      );
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = propertyName(property.name);
          if (name === null) configUnknown(property, configPath);
          else extractColorValue(property.initializer, [...configPath, name]);
        } else {
          configUnknown(property, configPath);
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const [index, element] of node.elements.entries()) {
        extractColorValue(element, [...configPath, String(index)]);
      }
      return;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      extractColorValue(node.expression, configPath);
      return;
    }
    configUnknown(node, configPath);
  }

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === "colors" &&
      belongsToExportedConfig(node)
    ) {
      const path = propertyPath(node);
      if (
        path.join(".") === "theme.colors" ||
        path.join(".") === "theme.extend.colors"
      ) {
        extractColorValue(node.initializer, path);
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  function inspectConfigShape(node: ts.Node, configPath: string[] = [], visited = new Set<ts.Node>()): void {
    if (visited.has(node) || visited.size >= 64 ||
        (ts.isIdentifier(node) && [...visited].some((previous) => ts.isIdentifier(previous)))) {
      configUnknown(node, configPath);
      return;
    }
    visited.add(node);
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
      inspectConfigShape(node.expression, configPath, visited);
      return;
    }
    if (ts.isIdentifier(node) && configPath.length === 0) {
      const declaration = sourceFile.statements.flatMap((statement) =>
        ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
      ).find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === node.text);
      if (declaration?.initializer !== undefined) inspectConfigShape(declaration.initializer, configPath, visited);
      else configUnknown(node, configPath);
      return;
    }
    if (!ts.isObjectLiteralExpression(node)) {
      configUnknown(node, configPath);
      return;
    }
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        configUnknown(property, configPath);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        if (["theme", "extend", "colors"].includes(property.name.text)) {
          configUnknown(property, [...configPath, property.name.text]);
        }
        continue;
      }
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyName(property.name);
      if ((configPath.length === 0 && name === "theme") ||
          (configPath.join(".") === "theme" && name === "extend")) {
        inspectConfigShape(property.initializer, [...configPath, name], new Set(visited));
      }
    }
  }
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) inspectConfigShape(statement.expression);
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
        statement.expression.left.getText(sourceFile) === "module.exports") {
      inspectConfigShape(statement.expression.right);
    }
  }
  return { observations, unknowns };
}

export function extractDesignEvidence(
  entries: ReadonlyArray<readonly [string, string]>,
  options: ExtractionOptions,
): ExtractionResult {
  const observations: ObservedEvidence[] = [];
  const unknowns: UnknownFinding[] = [];

  for (const [file, source] of entries) {
    let result: ExtractionResult | null = null;
    try {
      if (file.endsWith(".css")) result = extractCss(file, source);
      else if (file.startsWith("tailwind.config.")) result = extractTailwindConfig(file, source);
      else if (options.tailwind && /\.(?:[cm]?[jt]sx?)$/u.test(file)) result = extractSource(file, source);
    } catch {
      result = { observations: [], unknowns: [{ id: `unknown:parser-failure:${file}`, status: "UNKNOWN", kind: "source_parse", reasonCode: "PARSE_FAILED", reason: "Static parser could not safely analyze this file; source and exception text are not emitted.", source: { type: "FILE", file }, relatedEvidenceIds: [] }] };
    }
    if (result !== null) {
      observations.push(...result.observations);
      unknowns.push(...result.unknowns);
    }
  }

  if (options.tailwind) {
    const application = extractApplicationEvidence(entries, observations);
    observations.push(...application.observations); unknowns.push(...application.unknowns);
  }
  return { observations, unknowns };
}
