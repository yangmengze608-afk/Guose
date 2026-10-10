import ts from "typescript";
import postcss from "postcss";
import type { TransformationPlan } from "../transformation/schema.js";
export const HOME_FILE = "src/pages/Home.tsx";
export const CSS_FILE = "src/styles/guose-p2-home.css";
export const MUTATION_ALLOWLIST = [HOME_FILE, CSS_FILE] as const;
export function assertMutationAllowlist(files: readonly string[]) {
  if (files.some(f => !MUTATION_ALLOWLIST.some(a => a === f))) throw new Error("THIRD_FILE_MUTATION_FORBIDDEN");
}
export function materializePlan(plan: TransformationPlan, source: string) {
  if (plan.source.entry !== HOME_FILE || plan.operations.some(o => o.targetFile !== HOME_FILE)) throw new Error("PROTECTED_FILE_OPERATION");
  const sf = ts.createSourceFile(HOME_FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const roots: ts.JsxOpeningElement[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) && n.tagName.getText(sf) === "main" && n.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText(sf) === "data-page" && a.initializer && ts.isStringLiteral(a.initializer) && a.initializer.text === "home")) roots.push(n);
    ts.forEachChild(n, visit);
  }; visit(sf);
  const root = roots[0];
  if (roots.length !== 1 || !root || source.includes("guose-p2-home.css") || source.includes(plan.scopeProposal.value)) throw new Error("EXECUTION_UNRESOLVED_ROOT");
  const position = sf.getPositionOfLineAndCharacter(plan.scopeProposal.targetSource.type === "SPAN" ? plan.scopeProposal.targetSource.startLine - 1 : 0, plan.scopeProposal.targetSource.type === "SPAN" ? plan.scopeProposal.targetSource.startColumn : 0);
  if (position !== root.getStart(sf)) throw new Error("STALE_ROOT");
  const marker = ` data-guose-page="${plan.scopeProposal.value}"`, importLine = 'import "../styles/guose-p2-home.css";\n';
  const insertAt = root.tagName.getEnd();
  const home = importLine + source.slice(0, insertAt) + marker + source.slice(insertAt);
  if (home.slice(importLine.length).replace(marker, "") !== source) throw new Error("HOME_BYTE_REVERSIBILITY_FAILED");
  const rootCss = postcss.root(), results: { id: string; status: "APPLIED" | "SKIPPED_UNKNOWN" | "SKIPPED_SCOPE"; reason: string }[] = [];
  const unresolvedSurface = plan.operations.some(o => o.certainty === "REVIEW_REQUIRED_WITH_UNKNOWN" && /BACKGROUND|FOREGROUND/u.test(o.type));
  for (const op of plan.operations) {
    if (op.certainty === "REVIEW_REQUIRED_WITH_UNKNOWN") { results.push({ id: op.id, status: "SKIPPED_UNKNOWN", reason: "EXECUTION_UNRESOLVED: shared cn/cva effective classes and intrinsic ownership are not statically established; human approval does not resolve UNKNOWN" }); continue; }
    if (unresolvedSurface && ["TEXT_COLOR", "ACCENT_COLOR"].includes(op.type)) { results.push({ id: op.id, status: "SKIPPED_UNKNOWN", reason: "EXECUTION_UNRESOLVED: foreground/inheritance may depend on skipped shared surface/background operations; partial application cannot establish a safe color pairing" }); continue; }
    if (op.target.selector === plan.scopeProposal.selector) { results.push({ id: op.id, status: "SKIPPED_SCOPE", reason: "EXECUTION_UNRESOLVED: bare scope marker has class-level specificity; effective override would depend on utility CSS import order. Cannot change approved selector or add important" }); continue; }
    const p = op.target.source;
    const start = p.type === "SPAN" ? sf.getPositionOfLineAndCharacter(p.startLine - 1, p.startColumn) : -1;
    const end = p.type === "SPAN" ? sf.getPositionOfLineAndCharacter(p.endLine - 1, p.endColumn) : -1;
    if (p.file !== HOME_FILE || start < root.getStart(sf) || end > root.parent.getEnd() || op.scopeEvidence.rootSelector !== plan.scopeProposal.selector) { results.push({ id: op.id, status: "SKIPPED_SCOPE", reason: "EXECUTION_UNRESOLVED: source ownership outside confirmed visual root" }); continue; }
    if (op.unknownIds.length || Object.keys(op.after.declarations).some(k => k.includes(":"))) { results.push({ id: op.id, status: "SKIPPED_UNKNOWN", reason: "EXECUTION_UNRESOLVED: unsupported state or evidence" }); continue; }
    rootCss.append(postcss.comment({ text: `guose-op:${op.id}` }));
    const rule = postcss.rule({ selector: op.target.selector });
    for (const [prop, value] of Object.entries(op.after.declarations)) rule.append(postcss.decl({ prop, value }));
    rootCss.append(rule); results.push({ id: op.id, status: "APPLIED", reason: "Current digest-bound native JSX target inside confirmed main; exact approved declarations" });
  }
  const css = rootCss.toString() + "\n";
  auditEmittedCss(css, plan, results.filter(r => r.status === "APPLIED").map(r => r.id));
  return { home, css, results, homeReverse: { importLine, marker, insertAt } };
}
export function auditEmittedCss(css: string, plan: TransformationPlan, appliedIds: readonly string[]) {
  const parsed = postcss.parse(css), seen = new Set<string>();
  let current: string | undefined;
  for (const node of parsed.nodes) {
    if (node.type === "comment") { current = node.text.startsWith("guose-op:") ? node.text.slice(9) : undefined; continue; }
    if (node.type !== "rule" || !current || seen.has(current)) throw new Error("CSS_DECLARATION_WITHOUT_OPERATION");
    const op = plan.operations.find(o => o.id === current);
    if (!op || !appliedIds.includes(current) || node.selector !== op.target.selector) throw new Error("CSS_DECLARATION_WITHOUT_OPERATION");
    const actual: Record<string, string> = {};
    for (const d of node.nodes) { if (d.type !== "decl" || d.important || d.prop in actual) throw new Error("CSS_DECLARATION_WITHOUT_OPERATION"); actual[d.prop] = d.value; }
    if (JSON.stringify(actual) !== JSON.stringify(op.after.declarations)) throw new Error("CSS_DECLARATION_WITHOUT_OPERATION");
    seen.add(current); current = undefined;
  }
  if (seen.size !== appliedIds.length) throw new Error("MISSING_OPERATION_DECLARATIONS");
}
