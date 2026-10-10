import path from "node:path";
import ts from "typescript";
import type { ObservedEvidence, UnknownFinding, SourceLocation } from "../schemas/index.js";
import { obviousNonProductionPath } from "../utils/non-production-path.js";

const object = (x: unknown): Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x) ? x as Record<string, unknown> : {};
const supported = new Set(["Button", "Card", "Input"]);
export function extractApplicationEvidence(entries: ReadonlyArray<readonly [string, string]>, declarations: readonly ObservedEvidence[]) {
  const observations: ObservedEvidence[] = [], unknowns: UnknownFinding[] = [];
  const definitionsByFile = new Map<string, ObservedEvidence[]>();
  for (const declaration of declarations) if (declaration.kind === "component_declaration") definitionsByFile.set(declaration.source.file, [...(definitionsByFile.get(declaration.source.file) ?? []), declaration]);
  const sources = new Map(entries.filter(([file]) => /\.[jt]sx?$/u.test(file) && !file.endsWith(".d.ts")).map(([file, text]) => [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/u.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)]));
  const exports = new Map<string, Map<string, string>>();
  const span = (file: string, source: ts.SourceFile, node: ts.Node): SourceLocation => {
    const a = source.getLineAndCharacterOfPosition(node.getStart(source)), b = source.getLineAndCharacterOfPosition(node.getEnd());
    return { type: "SPAN", file, startLine: a.line + 1, startColumn: a.character, endLine: b.line + 1, endColumn: b.character };
  };
  // Only direct local exports. Barrels, re-exports and computed modules remain unresolved.
  for (const [file, source] of sources) {
    if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) continue;
    const names = new Map<string, string>();
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const e of statement.exportClause.elements) if (!e.isTypeOnly) names.set(e.name.text, (e.propertyName ?? e.name).text);
      } else if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const isDefault = ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.set(isDefault ? "default" : statement.name.text, statement.name.text);
        if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name)) names.set(d.name.text, d.name.text);
      } else if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) names.set("default", statement.expression.text);
    }
    exports.set(file, names);
  }
  // Config is data only. Extended/nested configs are not guessed or executed.
  const aliases: Record<string, string[]> = {}; let baseUrl = ".";
  const config = entries.find(([file]) => file === "tsconfig.json");
  if (config) {
    const parsed = ts.parseConfigFileTextToJson("tsconfig.json", config[1]);
    const data = object(parsed.config), options = object(data.compilerOptions);
    if (!parsed.error && data.extends === undefined) {
      baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : ".";
      for (const [key, values] of Object.entries(object(options.paths))) if (Array.isArray(values) && values.length === 1 && typeof values[0] === "string") aliases[key] = [values[0]];
    }
  }
  function resolve(file: string, specifier: string): string | null {
    let base: string | undefined;
    if (specifier.startsWith(".")) base = path.posix.join(path.posix.dirname(file), specifier);
    else {
      const matches = Object.entries(aliases).flatMap(([key, values]) => {
        const parts = key.split("*");
        if (parts.length === 1 && key === specifier) return [path.posix.join(baseUrl, values[0]!)];
        if (parts.length === 2 && specifier.startsWith(parts[0]!) && specifier.endsWith(parts[1]!)) return [path.posix.join(baseUrl, values[0]!.replace("*", specifier.slice(parts[0]!.length, specifier.length - parts[1]!.length)))];
        return [];
      });
      if (matches.length === 1) base = matches[0];
    }
    if (!base) return null;
    base = path.posix.normalize(base);
    if (base.startsWith("../") || path.posix.isAbsolute(base)) return null;
    const candidates = [base, ...[".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"].map(ext => base + ext)].filter(x => sources.has(x));
    return candidates.length === 1 ? candidates[0]! : null;
  }
  for (const [file, source] of sources) {
    if (!exports.has(file)) continue;
    let hasJsx = false;
    const findJsx = (node: ts.Node): void => { if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) hasJsx = true; else if (!hasJsx) ts.forEachChild(node, findJsx); };
    findJsx(source);
    if (!hasJsx) continue;
    const program = ts.createProgram([file], { noResolve: true, noLib: true, allowJs: true, jsx: ts.JsxEmit.Preserve }, {
      getSourceFile: name => name === file ? source : undefined, getDefaultLibFileName: () => "", writeFile: () => undefined,
      getCurrentDirectory: () => "", getDirectories: () => [], fileExists: name => name === file, readFile: () => undefined,
      getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    });
    const checker = program.getTypeChecker();
    const imports = new Map<ts.Symbol, { specifier: string; exported: string; local: string; location: SourceLocation }>();
    for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !statement.importClause?.isTypeOnly) {
      const clause = statement.importClause;
      const add = (name: ts.Identifier, exported: string) => { const symbol = checker.getSymbolAtLocation(name); if (symbol) imports.set(symbol, { specifier: (statement.moduleSpecifier as ts.StringLiteral).text, exported, local: name.text, location: span(file, source, statement) }); };
      if (clause?.name) add(clause.name, "default");
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const e of clause.namedBindings.elements) if (!e.isTypeOnly) add(e.name, (e.propertyName ?? e.name).text);
    }
    const aliasesOfSupportedImports = new Set<ts.Symbol>();
    function collectAliases(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let relevant = false;
        const search = (child: ts.Node): void => {
          const symbol = ts.isIdentifier(child) ? checker.getSymbolAtLocation(child) : undefined;
          if (symbol && supported.has(imports.get(symbol)?.exported ?? "")) relevant = true;
          ts.forEachChild(child, search);
        };
        search(node.initializer);
        const symbol = checker.getSymbolAtLocation(node.name);
        if (relevant && symbol) aliasesOfSupportedImports.add(symbol);
      }
      ts.forEachChild(node, collectAliases);
    }
    collectAliases(source);
    function visit(node: ts.Node): void {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (ts.isIdentifier(node.tagName) && /^[a-z]/u.test(node.tagName.text)) { ts.forEachChild(node, visit); return; }
        const symbol = ts.isIdentifier(node.tagName) ? checker.getSymbolAtLocation(node.tagName) : undefined;
        const imported = symbol ? imports.get(symbol) : undefined;
        const definitionFile = imported ? resolve(file, imported.specifier) : null;
        const name = definitionFile && imported ? exports.get(definitionFile)?.get(imported.exported) : undefined;
        const definitions = (definitionFile ? definitionsByFile.get(definitionFile) ?? [] : []).filter(d => object(d.value).normalizedValue === name);
        const relevant = supported.has(name ?? "") || supported.has(node.tagName.getText(source)) || supported.has(imported?.exported ?? "") || (symbol && aliasesOfSupportedImports.has(symbol));
        if (relevant) {
          const location = span(file, source, node), id = `component-usage:${file}:${node.getStart(source)}`;
          let dynamic = !imported || definitions.length !== 1;
          const props: Record<string, string | number | boolean | null> = {}, unmodeledProps: string[] = [];
          for (const attribute of node.attributes.properties) {
            if (ts.isJsxSpreadAttribute(attribute)) { dynamic = true; continue; }
            const key = attribute.name.getText(source), value = attribute.initializer;
            // Do not serialize application text, URLs, credentials or arbitrary data props.
            if (!["variant", "size", "className", "disabled", "type", "asChild"].includes(key)) { unmodeledProps.push(key); continue; }
            if (key in props) dynamic = true;
            if (!value) props[key] = true;
            else if (ts.isStringLiteral(value)) props[key] = value.text;
            else if (ts.isJsxExpression(value) && value.expression) {
              const e = value.expression;
              if (ts.isStringLiteral(e) || ts.isNumericLiteral(e)) props[key] = ts.isNumericLiteral(e) ? Number(e.text) : e.text;
              else if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) props[key] = e.kind === ts.SyntaxKind.TrueKeyword;
              else if (e.kind === ts.SyntaxKind.NullKeyword) props[key] = null;
              else { unmodeledProps.push(key); if (key === "variant" || key === "className" || key === "asChild") dynamic = true; }
            } else dynamic = true;
          }
          if ("variant" in props && typeof props.variant !== "string") dynamic = true;
          const parent = ts.isJsxOpeningElement(node) && ts.isJsxElement(node.parent) ? node.parent : null;
          const childrenContext = parent ? [...new Set(parent.children.map(child => ts.isJsxText(child) ? "TEXT_PRESENT" : ts.isJsxExpression(child) ? "EXPRESSION" : "ELEMENT"))].sort() : [];
          const independent = definitionFile !== file && !obviousNonProductionPath(file) && !/(?:^|\/)(?:registry|examples?|stories|__tests__|tests)(?:\/|$)|\.(?:test|spec|stories)\./u.test(file);
          observations.push({ id, status: "OBSERVED", kind: "component_application_usage", source: location,
            ...(definitions.length === 1 ? { contextEvidenceIds: [definitions[0]!.id] } : {}),
            value: { tokenType: "component_application_usage", normalizedValue: name ?? node.tagName.getText(source), component: name ?? null,
              importSource: imported?.specifier ?? null, importLocation: imported?.location ?? null, exportIdentity: imported?.exported ?? null, localAlias: imported?.local ?? null,
              definitionId: definitions.length === 1 ? definitions[0]!.id : null, resolution: definitions.length === 1 ? "RESOLVED" : "UNKNOWN",
              usageMode: dynamic ? "DYNAMIC" : "STATIC", explicitVariant: !dynamic && typeof props.variant === "string" ? props.variant : null,
              staticProps: props, unmodeledProps, childrenContext, independent, context: { usageMode: dynamic ? "DYNAMIC" : "STATIC" } } });
          if (dynamic) unknowns.push({ id: `unknown:${id}`, status: "UNKNOWN", kind: "component_application_resolution", reasonCode: "UNSUPPORTED",
            reason: "Import/export identity or effective variant/class props are not statically resolved; no runtime evaluation or text semantics.", source: location, relatedEvidenceIds: [id] });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { observations, unknowns };
}
