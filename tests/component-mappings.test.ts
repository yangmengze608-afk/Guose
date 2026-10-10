import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { detectRepository } from "../src/repo/index.js";
import { recoverDesignSystem } from "../src/recovery/index.js";
import { planMigration } from "../src/planner/index.js";
import { loadStylePack } from "../src/style-packs/index.js";
import { generateDryRunPatch } from "../src/patch/index.js";
import { recoveredDesignItemSchema, migrationItemSchema } from "../src/schemas/index.js";
import { traceSemanticRecovery } from "../src/recovery/semantic-trace.js";

const roots: string[] = [];
async function analyze(source: string) {
  const root = await mkdtemp(path.join(tmpdir(), "guose-m2b-")); roots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "19", tailwindcss: "4", "class-variance-authority": "0.7", clsx: "2" } }));
  await writeFile(path.join(root, "src/components.tsx"), source);
  return detectRepository(root);
}
const button = (classes: string, destructive = "bg-red-600 text-black") => `import { cva } from 'class-variance-authority';
const buttonVariants = cva('', { variants: { variant: { default: '${classes}', destructive: '${destructive}' } }, defaultVariants: { variant: 'default' } });
export function Button(){ return <button className={buttonVariants({variant: 'default'})}/> }`;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it("preserves variant structure and activates default/destructive roles without palette semantics", async () => {
  const bundle = await analyze(button("bg-blue-600 text-white"));
  const evidence = bundle.observations.find(x => JSON.stringify(x.value).includes('bg-blue-600'));
  expect(evidence?.value).toMatchObject({ context: { cvaDefinition: "buttonVariants", styleProperty: "background", helper: "cva", variantName: "variant", variantValue: "default", defaultVariant: "default", defaultVariantSource: { type: "SPAN" }, variantSource: { type: "SPAN" } } });
  const mappings = recoverDesignSystem(bundle).sections.semanticTokens.filter(x => x.structuralEvidence);
  expect(mappings).toHaveLength(4);
  expect(mappings.every(x => x.status === "INFERRED")).toBe(true);
  expect(mappings.map(x => x.structuralEvidence?.role)).toEqual(expect.arrayContaining(["primary.action.background", "primary.action.foreground", "destructive.action.background", "destructive.action.foreground"]));
  const reversed = recoverDesignSystem(await analyze(button("bg-red-600 text-white", "bg-blue-600 text-black")));
  expect(reversed.sections.semanticTokens.find(x => x.structuralEvidence?.rawClass === "bg-red-600")?.structuralEvidence?.role).toBe("primary.action.background");
});
it("abstains on incompatible same raw implementation roles", async () => {
  const mappings = recoverDesignSystem(await analyze(button("bg-blue-600", "bg-blue-600"))).sections.semanticTokens.filter(x => x.structuralEvidence);
  expect(mappings).toHaveLength(2);
  expect(mappings.every(x => x.status === "UNKNOWN" && x.structuralEvidence?.conflictKinds.includes("TRUE_SEMANTIC_CONFLICT"))).toBe(true);
});
it("recognizes static Card background and border", async () => {
  const mappings = recoverDesignSystem(await analyze('export function Card(){ return <div className="bg-white border-gray-200"/> }')).sections.semanticTokens.filter(x => x.structuralEvidence);
  expect(mappings.map(x => x.structuralEvidence?.role).sort()).toEqual(["border.default", "surface.card"]);
});
it("keeps dynamic helper expressions unknown", async () => {
  const bundle = await analyze("import clsx from 'clsx'; export function Card(){ return <div className={clsx('bg-white', dynamic())}/> }");
  expect(bundle.unknowns.length).toBeGreaterThan(0);
  expect(recoverDesignSystem(bundle).sections.semanticTokens.filter(x => x.structuralEvidence).every(x => x.status === "UNKNOWN")).toBe(true);
});
it("does not manufacture inference for an existing semantic alias", async () => {
  const bundle = await analyze(button("bg-primary text-primary-foreground", "bg-destructive text-destructive-foreground"));
  expect(recoverDesignSystem(bundle).sections.semanticTokens.filter(x => x.structuralEvidence)).toHaveLength(0);
  expect(traceSemanticRecovery(bundle).traces.some(x => x.conflict_kinds?.includes("EXISTING_SEMANTIC_TOKEN_ALIAS"))).toBe(true);
  expect(planMigration(bundle, await loadStylePack("neutral-modern")).items.some(x => x.current.includes("bg-primary") && x.status === "OBSERVED")).toBe(true);
});
it("routes valid recovered inference into review-only planner operations", async () => {
  const bundle = await analyze(button("bg-blue-600 text-white"));
  const plan = planMigration(bundle, await loadStylePack("neutral-modern"));
  const operations = plan.items.filter(x => x.kind === "STRUCTURAL_SEMANTIC_REVIEW");
  expect(operations).toHaveLength(4);
  expect(operations.every(x => x.decision === "REVIEW_REQUIRED" && x.target !== null && x.risk === "MEDIUM" && x.patchBlockers?.includes("NO_APPROVED_PATCH_LANE"))).toBe(true);
  expect(plan.summary.autoSafe).toBe(0);
});
it("does not plan conflicted inference", async () => {
  const bundle = await analyze(button("bg-blue-600", "bg-blue-600"));
  expect(planMigration(bundle, await loadStylePack("neutral-modern")).items.filter(x => x.kind === "STRUCTURAL_SEMANTIC_REVIEW")).toHaveLength(0);
});
it("does not infer from computed variants or unrelated component names", async () => {
  const bundle = await analyze(button("bg-blue-600").replace("default:", "[runtime]:"));
  expect(recoverDesignSystem(bundle).sections.semanticTokens.filter(x => x.structuralEvidence).every(x => x.status === "UNKNOWN")).toBe(true);
  const other = await analyze('export function Decorative(){return <div className="bg-blue-600"/>}');
  expect(recoverDesignSystem(other).sections.semanticTokens.filter(x => x.structuralEvidence)).toHaveLength(0);
});
it("does not let a CVA base or another axis override a structural direction", async () => {
  const bundle = await analyze(button("bg-blue-600").replace("cva('',", "cva('bg-red-600',"));
  expect(recoverDesignSystem(bundle).sections.semanticTokens.filter(x => x.structuralEvidence?.property === "background").every(x => x.status === "UNKNOWN")).toBe(true);
});
it("rejects competing classes for the same declared variant property", async () => {
  const bundle = await analyze(button("bg-blue-600 bg-gray-500"));
  expect(recoverDesignSystem(bundle).sections.semanticTokens.filter(x => x.structuralEvidence?.role === "primary.action.background").every(x => x.status === "UNKNOWN")).toBe(true);
});
it("separates static declared recipe inference from dynamic runtime composition", async () => {
  const bundle = await analyze(button("bg-blue-600").replace("className={buttonVariants({variant: 'default'})}", "className={buttonVariants({variant: runtime})}"));
  expect(bundle.unknowns.length).toBeGreaterThan(0);
  expect(recoverDesignSystem(bundle).sections.semanticTokens.find(x => x.structuralEvidence?.role === "primary.action.background")?.status).toBe("INFERRED");
});
it("keeps vendor and generated structural evidence excluded", async () => {
  const bundle = await analyze(button("bg-blue-600"));
  const root = roots.at(-1)!;
  await mkdir(path.join(root, "vendor")); await writeFile(path.join(root, "vendor/Button.tsx"), button("bg-gray-200"));
  await mkdir(path.join(root, "generated")); await writeFile(path.join(root, "generated/Button.tsx"), button("bg-green-200"));
  const observed = await detectRepository(root);
  expect(recoverDesignSystem(observed).sections.semanticTokens.filter(x => x.structuralEvidence).some(x => x.values.includes("bg-gray-200"))).toBe(false);
  expect(recoverDesignSystem(observed).sections.semanticTokens.filter(x => x.structuralEvidence).some(x => x.values.includes("bg-green-200"))).toBe(false);
  expect(bundle.observations.length).toBeGreaterThan(0);
});
it("does not interpret CVA ClassValue object values as class strings", async () => {
  const bundle = await analyze(button("bg-blue-600").replace("default: 'bg-blue-600'", "default: { ignored: 'bg-blue-600' }"));
  expect(bundle.unknowns.length).toBeGreaterThan(0);
  expect(recoverDesignSystem(bundle).sections.semanticTokens.filter(x => x.structuralEvidence).every(x => x.status === "UNKNOWN")).toBe(true);
});
it("keeps computed/helper object conditions dynamic", async () => {
  const bundle = await analyze("import clsx from 'clsx'; export function Card(){return <div className={clsx('bg-white',{[runtime]:true,'bg-blue-600':condition})}/>}");
  expect(bundle.unknowns.length).toBeGreaterThan(0);
  expect(recoverDesignSystem(bundle).sections.semanticTokens.filter(x => x.structuralEvidence).every(x => x.status === "UNKNOWN")).toBe(true);
});
it("preserves an unrelated UNKNOWN without invalidating a distinct property claim", async () => {
  const bundle = await analyze(button("bg-blue-600").replace("cva('',", "cva('focus-visible:ring-[3px]',"));
  expect(bundle.unknowns.length).toBeGreaterThan(0);
  expect(recoverDesignSystem(bundle).sections.semanticTokens.find(x => x.structuralEvidence?.role === "primary.action.background")?.status).toBe("INFERRED");
});
it("does not confuse font-size variants with foreground color overrides", async () => {
  const source = button("bg-blue-600 text-white").replace("variant: { default:", "size: { small: 'text-sm' }, variant: { default:");
  expect(recoverDesignSystem(await analyze(source)).sections.semanticTokens.find(x => x.structuralEvidence?.role === "primary.action.foreground")?.status).toBe("INFERRED");
});
it("rejects forged accepted conflicts and structural mutation targets at schema boundaries", async () => {
  const bundle = await analyze(button("bg-blue-600"));
  const mapping = recoverDesignSystem(bundle).sections.semanticTokens.find(x => x.structuralEvidence)!;
  expect(recoveredDesignItemSchema.safeParse({ ...mapping, structuralEvidence: { ...mapping.structuralEvidence, conflictKinds: ["TRUE_SEMANTIC_CONFLICT"] } }).success).toBe(false);
  const operation = planMigration(bundle, await loadStylePack("neutral-modern")).items.find(x => x.kind === "STRUCTURAL_SEMANTIC_REVIEW")!;
  expect(migrationItemSchema.safeParse({ ...operation, decision: "AUTO_SAFE" }).success).toBe(false);
  expect(migrationItemSchema.safeParse({ ...operation, target: null }).success).toBe(false);
});
it("does not grant dry-run edits to review-only structural mappings", async () => {
  const bundle = await analyze(button("bg-blue-600 text-white"));
  const patch = await generateDryRunPatch(bundle, await loadStylePack("neutral-modern"));
  expect(patch.files).toHaveLength(0); expect(patch.diff).toBe("");
});
it("retains literal branches but marks runtime ternary and boolean assembly UNKNOWN", async () => {
  const bundle = await analyze("import clsx from 'clsx'; export function Card(){return <div className={clsx('bg-white', flag && 'bg-blue-600', other ? 'text-white':'text-black')}/>}");
  expect(bundle.unknowns.filter(x => x.kind === "dynamic_tailwind_class").length).toBeGreaterThanOrEqual(2);
  expect(recoverDesignSystem(bundle).sections.semanticTokens.filter(x => x.structuralEvidence).every(x => x.status === "UNKNOWN")).toBe(true);
});
it("does not turn compatible shared implementation values into true role conflicts", async () => {
  const source = button("bg-white text-black", "bg-red-600 text-gray-100") + '\nexport function Card(){return <div className="bg-white"/>}';
  const mappings = recoverDesignSystem(await analyze(source)).sections.semanticTokens.filter(x => x.values.includes("bg-white") && x.structuralEvidence);
  expect(mappings).toHaveLength(2);
  expect(mappings.every(x => x.status === "INFERRED" && x.structuralEvidence?.conflictKinds.includes("SHARED_IMPLEMENTATION_VALUE"))).toBe(true);
});
it("preserves static boolean default selections as variant keys with source provenance", async () => {
  const bundle = await analyze("import {cva} from 'class-variance-authority'; const recipe=cva('',{variants:{disabled:{false:'text-white',true:'text-black'}},defaultVariants:{disabled:false}}); export function Button(){return <button className={recipe({disabled:false})}/>}");
  const evidence = bundle.observations.find(x => JSON.stringify(x.value).includes('"variantValue":"false"'));
  expect(evidence?.value).toMatchObject({ context: { variantName: "disabled", defaultVariant: "false", defaultVariantSource: { type: "SPAN" } } });
  expect(recoverDesignSystem(bundle).sections.semanticTokens.filter(x => x.structuralEvidence)).toHaveLength(0);
});
