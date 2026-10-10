import ts from "typescript";
import type { ReadonlyEvidenceBundle, SourceLocation } from "../schemas/index.js";
import type { TransformationPlan } from "./schema.js";

export const record = (x: unknown): Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x) ? x as Record<string, unknown> : {};
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
export type ScopedTarget = { identity: string; role: "page" | "section" | "text" | "accent" | "primary" | "secondary" | "elevated" | "flat" | "cta"; selector: string; source: SourceLocation; evidenceIds: string[]; classes: string[]; component: boolean };
export type Abstention = TransformationPlan["abstentions"][number];

function location(file: string, sf: ts.SourceFile, node: ts.Node): SourceLocation {
  const a = sf.getLineAndCharacterOfPosition(node.getStart(sf)), b = sf.getLineAndCharacterOfPosition(node.getEnd());
  return { type: "SPAN", file, startLine: a.line + 1, startColumn: a.character, endLine: b.line + 1, endColumn: b.character };
}
function attrs(node: Opening, sf: ts.SourceFile) {
  const values: Record<string, string> = {}; let dynamic = false;
  for (const attr of node.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attr)) { dynamic = true; continue; }
    const name = attr.name.getText(sf), value = attr.initializer;
    if (name in values) dynamic = true;
    if (value && ts.isStringLiteral(value)) values[name] = value.text;
    else if (["className", "variant", "id", "data-slot", "data-page", "data-guose-page", "data-region"].includes(name)) dynamic = true;
  }
  return { values, dynamic };
}
const safe = (s: string) => /^[a-zA-Z0-9_-]+$/u.test(s);

/** Structural replay uses only bytes matching the bundle snapshot; no new scan,
 * runtime resolution or component invocation. Positions identify evidence, never select DOM order. */
export function resolveScopedTargets(bundle: ReadonlyEvidenceBundle, sources: ReadonlyMap<string, string>, entry: string, rootQuery: string, scopeSelector: string, protectedPaths: readonly string[]) {
  const text = sources.get(entry);
  if (text === undefined) throw new Error("MISSING_ENTRY");
  const sf = ts.createSourceFile(entry, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if ((sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) throw new Error("UNKNOWN_PARSE");
  const nodes: Opening[] = [];
  const visit = (n: ts.Node): void => { if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) nodes.push(n); ts.forEachChild(n, visit); };
  visit(sf);
  const query = /^([a-z][a-z0-9-]*)\[([a-z][a-z0-9-]*)="([a-zA-Z0-9_-]+)"\]$/u.exec(rootQuery);
  if (!query) throw new Error("UNRESOLVED_SCOPE: only a literal tag/attribute root is supported");
  const roots = nodes.filter(n => n.tagName.getText(sf) === query[1] && attrs(n, sf).values[query[2]!] === query[3]);
  const root = roots[0];
  if (roots.length !== 1 || !root || attrs(root, sf).dynamic || !ts.isJsxElement(root.parent)) throw new Error("UNRESOLVED_SCOPE: root not unique/static");
  const rootEnd = root.parent.getEnd(), rootStart = root.getStart(sf);
  const within = (n: Opening) => n.getStart(sf) >= rootStart && n.getEnd() <= rootEnd;
  const observations = bundle.observations.filter(x => x.source.file === entry);
  const evidenceFor = (n: Opening) => observations.filter(e => e.source.type === "SPAN" &&
    sf.getPositionOfLineAndCharacter(e.source.startLine - 1, e.source.startColumn) >= n.getStart(sf) &&
    sf.getPositionOfLineAndCharacter(e.source.endLine - 1, e.source.endColumn) <= n.getEnd());
  const targets: ScopedTarget[] = [], abstentions: Abstention[] = [];
  const rootSource = location(entry, sf, root);
  const opaque = nodes.filter(n => within(n) && /^[A-Z]/u.test(n.tagName.getText(sf))).some(n => {
    const usage = evidenceFor(n).find(e => e.kind === "component_application_usage" && e.source.type === "SPAN" && e.source.startColumn === sf.getLineAndCharacterOfPosition(n.getStart(sf)).character);
    return !usage || !["Button", "Card"].includes(String(record(usage.value).component)) || record(usage.value).resolution !== "RESOLVED";
  });
  if (opaque) return { targets, rootSource, abstentions: [{ status: "UNRESOLVED_SCOPE" as const, identity: entry, reason: "Opaque or protected component inside scope: inherited styles cannot be bounded", evidenceIds: [], source: rootSource }] };
  for (const node of nodes) {
    if (!within(node)) continue;
    const a = attrs(node, sf), tag = node.tagName.getText(sf), source = location(entry, sf, node);
    const evidence = evidenceFor(node), usage = evidence.find(e => e.kind === "component_application_usage" && e.source.type === "SPAN" && e.source.startColumn === sf.getLineAndCharacterOfPosition(node.getStart(sf)).character);
    const id = `${entry}:${node.getStart(sf)}`;
    if (a.dynamic || (usage && record(usage.value).usageMode !== "STATIC")) { abstentions.push({ status: "ABSTAIN", identity: id, reason: "Dynamic/spread/ambiguous attributes remain UNKNOWN", evidenceIds: evidence.map(e => e.id), source }); continue; }
    const localClasses = (a.values.className ?? "").split(/\s+/u).filter(Boolean);
    const classes = [...localClasses], ids = evidence.map(e => e.id);
    const add = (role: ScopedTarget["role"], selector: string, component = false) => {
      if (!ids.length) { abstentions.push({ status: "ABSTAIN", identity: id, reason: "No observed design/application evidence for target", evidenceIds: [], source }); return; }
      targets.push({ identity: id, role, selector, source, evidenceIds: [...new Set(ids)].sort(), classes: [...new Set(classes)].sort(), component });
    };
    if (node === root) { add("page", scopeSelector); continue; }
    if (tag === "section" && a.values["data-region"] && safe(a.values["data-region"])) {
      add("section", `${scopeSelector} section[data-region="${a.values["data-region"]}"]`); continue;
    }
    if (usage) {
      const data = record(usage.value), definition = bundle.observations.find(e => e.id === data.definitionId);
      if (!definition || protectedPaths.includes(entry)) { abstentions.push({ status: "REJECTED_PROTECTED_SCOPE", identity: id, reason: "Protected or unresolved target", evidenceIds: ids, source }); continue; }
      ids.push(definition.id);
      const definitionText = sources.get(definition.source.file);
      if (!definitionText) continue;
      const ds = ts.createSourceFile(definition.source.file, definitionText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let definitionNode: ts.Node | undefined;
      const findDefinition = (n: ts.Node): void => {
        if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && n.name.getText(ds) === record(definition.value).normalizedValue) {
          const pos = ds.getLineAndCharacterOfPosition(n.name.getStart(ds));
          if (definition.source.type === "SPAN" && pos.line + 1 === definition.source.startLine && pos.character === definition.source.startColumn) definitionNode = n;
        }
        ts.forEachChild(n, findDefinition);
      };
      findDefinition(ds);
      const returned: Opening[] = [];
      const scan = (n: ts.Node): void => { if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) returned.push(n); ts.forEachChild(n, scan); };
      if (definitionNode) scan(definitionNode);
      const expectedTag = data.component === "Button" ? "button" : "div";
      const slot = returned.length === 1 && returned[0]?.tagName.getText(ds) === expectedTag ? attrs(returned[0], ds).values["data-slot"] : undefined;
      if (!slot || !safe(slot) || "asChild" in record(data.staticProps) || Object.keys(a.values).some(k => k === "data-slot")) { abstentions.push({ status: "UNRESOLVED_SCOPE", identity: id, reason: "No supported literal intrinsic data-slot contract", evidenceIds: ids, source }); continue; }
      // Refer to literal templates, not effective cn/cva resolution or computed CSS.
      const references = bundle.observations.filter(e => e.kind === "component_style_usage" && e.contextEvidenceIds?.includes(definition.id));
      const referencedIds = new Set(references.flatMap(e => e.contextEvidenceIds ?? []));
      const candidates = bundle.observations.filter(e => e.source.file === definition.source.file && e.id.startsWith("tailwind-class:") && referencedIds.has(e.id));
      const defaults = [...new Set(candidates.map(e => record(record(e.value).context)).filter(c => c.variantName === "variant").map(c => c.defaultVariant).filter((v): v is string => typeof v === "string"))];
      const selectedVariant = data.explicitVariant ?? (defaults.length === 1 ? defaults[0] : undefined);
      const templates = candidates.filter(e => {
        const context = record(record(e.value).context);
        const variant = context.variantValue;
        return variant === undefined || variant === null || (context.variantName === "variant" && variant === selectedVariant);
      });
      ids.push(...references.map(e => e.id), ...templates.map(e => e.id)); classes.push(...templates.map(e => String(record(e.value).normalizedValue)));
      const base = `${scopeSelector} ${expectedTag}[data-slot="${slot}"]`;
      if (data.component === "Button") {
        const variant = selectedVariant;
        if (variant !== "default" && variant !== "secondary") { abstentions.push({ status: "ABSTAIN", identity: id, reason: "Unsupported Button variant", evidenceIds: ids, source }); continue; }
        if (localClasses.some(c => /(?:^|:)!?bg-/u.test(c))) { abstentions.push({ status: "UNRESOLVED_SCOPE", identity: id, reason: "Local background override may remove the variant selector anchor", evidenceIds: ids, source }); continue; }
        const anchor = variant === "default" ? "bg-primary" : "bg-card";
        if (!classes.includes(anchor)) { abstentions.push({ status: "UNRESOLVED_SCOPE", identity: id, reason: "No literal variant class selector anchor", evidenceIds: ids, source }); continue; }
        add(variant === "default" ? "primary" : "secondary", `${base}[class~="${anchor}"]`, true);
      } else {
        const gradient = localClasses.find(c => /^bg-gradient-to-[a-z]+$/u.test(c));
        if (gradient) add("cta", `${base}[class~="${gradient}"]`, true);
        else if (a.values.id && safe(a.values.id) && localClasses.some(c => /^shadow-(?:xl|2xl)$/u.test(c))) add("elevated", `${base}[id="${a.values.id}"]`, true);
        else if (!localClasses.some(c => /^(?:bg-|shadow-)/u.test(c))) add("flat", `${base}:not([id]):not([class*="bg-gradient-"])`, true);
        else abstentions.push({ status: "ABSTAIN", identity: id, reason: "Unresolved Card surface role", evidenceIds: ids, source });
      }
      continue;
    }
    if (["p", "span", "h1", "h2", "h3"].includes(tag)) {
      const token = localClasses.find(c => /^text-(?:muted-foreground|[a-z]+-[1-9]00)$/u.test(c));
      if (token) add(token === "text-muted-foreground" || token.endsWith("100") ? "text" : "accent", `${scopeSelector} ${tag}[class~="${token}"]`);
    }
  }
  // A group selector may also hit an unresolved application. Abstain from the
  // entire family instead of pretending only the resolved JSX sites will match.
  const unresolved = new Set<string>();
  for (const n of nodes.filter(within)) {
    const u = evidenceFor(n).find(e => e.kind === "component_application_usage");
    const data = record(u?.value);
    if (u && (data.usageMode !== "STATIC" || abstentions.some(a => a.identity === `${entry}:${n.getStart(sf)}`))) unresolved.add(String(data.component));
  }
  const ambiguousTextTags = new Set(nodes.filter(n => within(n) && attrs(n, sf).dynamic).map(n => n.tagName.getText(sf)));
  return { targets: targets.filter(t => t.component ? !unresolved.has(["primary", "secondary"].includes(t.role) ? "Button" : "Card") :
    !(["text", "accent"].includes(t.role) && ambiguousTextTags.has(t.selector.slice(scopeSelector.length + 1).split("[")[0]!))), rootSource, abstentions };
}
