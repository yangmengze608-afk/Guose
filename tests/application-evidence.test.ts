import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { detectRepository } from "../src/repo/index.js";
import { recoverDesignSystem } from "../src/recovery/index.js";
import { planMigration } from "../src/planner/index.js";
import { resolveRoleTarget } from "../src/planner/targets.js";
import { loadStylePack } from "../src/style-packs/index.js";
const roots: string[] = [];
const definition = `import {cva} from 'class-variance-authority';
const recipe=cva('',{variants:{variant:{default:'bg-blue-600 text-black',destructive:'bg-red-600 text-white'}},defaultVariants:{variant:'default'}});
export function Button(){return <button className={recipe({variant:'default'})}/>}`;
async function analyze(usage = "", extra: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "guose-m2c-")); roots.push(root);
  const files = { "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4", "class-variance-authority": "0.7" } }), "src/ui/button.tsx": definition,
    ...(usage ? { "src/pages/account.tsx": `import {Button} from '../ui/button'; export function Page(){return ${usage}}` } : {}), ...extra };
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  const bundle = await detectRepository(root);
  return { bundle, mapping: recoverDesignSystem(bundle).sections.semanticTokens.find(x => x.structuralEvidence?.role === "destructive.action.foreground")! };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it("keeps zero application sites declaration-only and LOW", async () => {
  const { mapping } = await analyze();
  expect(mapping.status).toBe("INFERRED"); expect(mapping.applicationEvidence?.strength).toBe("DECLARATION_ONLY");
  expect(mapping.confidence).toMatchObject({ band: "LOW" });
});
it("uses one explicit static variant as application evidence", async () => {
  const { mapping } = await analyze('<Button variant="destructive">Delete</Button>');
  expect(mapping.applicationEvidence?.classes).toEqual(["DECLARATION_EVIDENCE", "APPLICATION_EVIDENCE"]);
  expect(mapping.applicationEvidence?.usageIds).toHaveLength(1);
});
it("adds cross-file support but does not award points for repeated sites", async () => {
  const one = await analyze('<Button variant="destructive"/>');
  const many = await analyze('<Button variant="destructive"/>', { "src/pages/other.tsx": "import {Button} from '../ui/button'; export function Other(){return <Button variant='destructive'/>}" });
  expect(many.mapping.applicationEvidence?.strength).toBe("CROSS_CONTEXT_SUPPORTED");
  expect(many.mapping.applicationEvidence?.usageIds).toHaveLength(2);
  expect(many.mapping.confidence).toMatchObject({ score: one.mapping.confidence.status === "ASSESSED" ? one.mapping.confidence.score : null });
});
it("resolves a named import alias through its actual symbol", async () => {
  const { mapping } = await analyze("", { "src/pages/alias.tsx": "import {Button as ActionButton} from '../ui/button'; export function Page(){return <ActionButton variant='destructive'/>}" });
  expect(mapping.applicationEvidence?.usageIds).toHaveLength(1);
});
it("never joins a package Button by global spelling", async () => {
  const { bundle, mapping } = await analyze("", { "src/pages/other.tsx": "import {Button} from 'other-package'; export function Page(){return <Button variant='destructive'/>}" });
  expect(mapping.applicationEvidence?.usageIds).toHaveLength(0); expect(bundle.unknowns.some(x => x.kind === "component_application_resolution")).toBe(true);
});
it("keeps a dynamic variant UNKNOWN", async () => {
  const { bundle, mapping } = await analyze("<Button variant={runtime}/>");
  expect(mapping.applicationEvidence?.usageIds).toHaveLength(0); expect(bundle.unknowns.some(x => x.kind === "component_application_resolution")).toBe(true);
});
it("does not trust explicit props when a spread can override them", async () => {
  const { bundle, mapping } = await analyze('<Button variant="destructive" {...props}/>');
  expect(mapping.applicationEvidence?.usageIds).toHaveLength(0);
  expect(bundle.observations.find(x => x.kind === "component_application_usage")?.value).toMatchObject({ usageMode: "DYNAMIC", explicitVariant: null });
});
it("unused variant is not positive evidence; absent variant does not imply destructive", async () => {
  const { mapping } = await analyze("<Button/>");
  expect(mapping.applicationEvidence?.negativeSignals).toContain("UNUSED_VARIANT"); expect(mapping.applicationEvidence?.usageIds).toHaveLength(0);
});
it("abstains on a static property conflict in application use", async () => {
  const { mapping, bundle } = await analyze('<Button variant="destructive" className="text-black"/>');
  expect(mapping.status).toBe("UNKNOWN"); expect(mapping.applicationEvidence?.negativeSignals).toContain("APPLICATION_CONFLICT");
  expect(planMigration(bundle, await loadStylePack("neutral-modern")).items.some(x => x.role === "destructive.action.foreground")).toBe(false);
});
it("resolves all six existing roles with property-compatible targets", async () => {
  const pack = await loadStylePack("neutral-modern");
  expect(Object.keys(pack.roleTargets)).toHaveLength(6);
  for (const [role, target] of Object.entries(pack.roleTargets)) expect(resolveRoleTarget(role, target.property, pack)).toMatchObject({ target: target.utility, targetStatus: "TARGET_STYLE_PACK_DEFINED" });
});
it("unknown roles and wrong properties stay explicitly unresolved", async () => {
  const pack = await loadStylePack("neutral-modern");
  expect(resolveRoleTarget("input.border", "border", pack)).toMatchObject({ target: null, targetStatus: "TARGET_UNRESOLVED" });
  expect(resolveRoleTarget("surface.card", "foreground", pack).targetStatus).toBe("TARGET_UNRESOLVED");
});
it("produces concrete inferred review-only plan targets with provenance and patch blockers", async () => {
  const { bundle } = await analyze('<Button variant="destructive"/>');
  const operation = planMigration(bundle, await loadStylePack("neutral-modern")).items.find(x => x.role === "destructive.action.foreground")!;
  expect(operation).toMatchObject({ target: "text-destructive-foreground", targetStatus: "TARGET_REQUIRES_INTRODUCTION", decision: "REVIEW_REQUIRED", requiresTokenIntroduction: true });
  expect(operation.applicationEvidence?.usageIds).toHaveLength(1); expect(operation.patchBlockers).toContain("NO_APPROVED_PATCH_LANE");
  expect(operation.provenance.length).toBe(operation.evidence.length);
});
it("resolves static tsconfig aliases without executing configuration", async () => {
  const { mapping } = await analyze("", { "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}', "src/pages/alias.tsx": "import {Button as B} from '@/ui/button'; export function Page(){return <B variant='destructive'/>}" });
  expect(mapping.applicationEvidence?.usageIds).toHaveLength(1);
});
it("does not mistake a shadowed import, barrel, or example for independent support", async () => {
  const { mapping } = await analyze("", {
    "src/pages/shadow.tsx": "import {Button} from '../ui/button'; export function Page(Button:any){return <Button variant='destructive'/>}",
    "src/ui/index.ts": "export {Button} from './button';",
    "src/pages/barrel.tsx": "import {Button} from '../ui'; export function Page(){return <Button variant='destructive'/>}",
    "examples/demo.tsx": "import {Button} from '../src/ui/button'; export function Demo(){return <Button variant='destructive'/>}",
  });
  expect(mapping.applicationEvidence?.usageIds).toHaveLength(0);
});
it("records dynamic component aliases as UNKNOWN rather than connecting them", async () => {
  const { mapping, bundle } = await analyze("", { "src/pages/dynamic.tsx": "import {Button} from '../ui/button'; const Action=condition?Button:Other; export function Page(){return <Action variant='destructive'/>}" });
  expect(mapping.applicationEvidence?.usageIds).toHaveLength(0); expect(bundle.unknowns.some(x => x.kind === "component_application_resolution")).toBe(true);
});
it("records Card and Input relationships without extending semantic roles", async () => {
  const { bundle } = await analyze("", { "src/ui/fields.tsx": "export function Card(){return <div className='bg-white'/>} export function Input(){return <input className='border-gray-200'/>}", "src/pages/form.tsx": "import {Card,Input} from '../ui/fields'; export function Form(){return <Card><Input disabled/></Card>}" });
  expect(bundle.observations.filter(x => x.kind === "component_application_usage")).toHaveLength(2);
  expect(bundle.observations.find(x => x.kind === "component_application_usage" && (x.value as { component: string }).component === "Input")?.value).toMatchObject({ childrenContext: [] });
  const mappings = recoverDesignSystem(bundle).sections.semanticTokens.filter(x => x.structuralEvidence);
  expect(mappings.find(x => x.structuralEvidence?.component === "Card")?.applicationEvidence?.usageIds).toHaveLength(1);
  expect(mappings.some(x => x.key.includes("input."))).toBe(false);
});
it("recognizes only a bounded theme token as existing, not a matching utility spelling", async () => {
  const { bundle } = await analyze('<Button variant="destructive"/>', { "src/theme.css": "@import 'tailwindcss'; @theme { --color-destructive-foreground: #fafafa; }" });
  expect(resolveRoleTarget("destructive.action.foreground", "foreground", await loadStylePack("neutral-modern"), bundle)).toMatchObject({ targetStatus: "TARGET_EXISTING", requiresTokenIntroduction: false });
});
it("does not serialize application text or arbitrary static data props", async () => {
  const { bundle } = await analyze('<Button variant="destructive" data-account="private-account-label">Sensitive text</Button>');
  const usages = JSON.stringify(bundle.observations.filter(x => x.kind === "component_application_usage"));
  expect(usages).not.toContain("private-account-label"); expect(usages).not.toContain("Sensitive text");
});
it("does not claim token introduction when an unresolved existing binding is observed", async () => {
  const { bundle } = await analyze('<Button variant="destructive"/>', { "src/theme.css": "@theme { --color-destructive-foreground: var(--destructive-foreground); } :root { --destructive-foreground: #fafafa; } .dark { --destructive-foreground: #dc2626; }" });
  expect(resolveRoleTarget("destructive.action.foreground", "foreground", await loadStylePack("neutral-modern"), bundle)).toMatchObject({ targetStatus: "TARGET_STYLE_PACK_DEFINED", requiresTokenIntroduction: false });
});
