import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { detectRepository } from "../src/repo/index.js";
import { recoverDesignSystem } from "../src/recovery/index.js";
import { traceSemanticRecovery } from "../src/recovery/semantic-trace.js";
import { planMigration } from "../src/planner/index.js";
import { loadStylePack } from "../src/style-packs/index.js";
import { createProvenanceGraph } from "../src/provenance/index.js";
import { createBundleContentFingerprint } from "../src/utils/content-hash.js";
import { evidenceBundleSchema, type ReadonlyEvidenceBundle } from "../src/schemas/index.js";

const roots: string[] = [];
async function analyze(css: string, tsx = 'export function Button(){ return <button className="bg-blue-500"/> }') {
  const root = await mkdtemp(path.join(tmpdir(), "guose-trace-")); roots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "package.json"), '{"dependencies":{"react":"19","tailwindcss":"4"}}');
  await writeFile(path.join(root, "src/app.css"), css);
  await writeFile(path.join(root, "src/Button.tsx"), tsx);
  return detectRepository(root);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("traces existing explicit-role candidates and does not invent a rule from component context", async () => {
  const bundle = await analyze(':root { --primary: #123456; }');
  const before = recoverDesignSystem(bundle), result = traceSemanticRecovery(bundle);
  expect(result.summary.candidatesGenerated).toBe(1);
  expect(result.summary.acceptedInferredMappings).toBe(1);
  const component = result.traces.find(x => x.contexts.some(c => JSON.stringify(c).includes('"component":"Button"')));
  expect(component).toMatchObject({ record_type: "POTENTIAL_INPUT_PROBE", decision: "ABSTAIN_NO_CANDIDATE_RULE", candidate_semantic_role: null });
  expect(recoverDesignSystem(bundle)).toEqual(before);
});
it("records insufficient global-scope evidence, provenance and actual unscored UNKNOWN confidence", async () => {
  const result = traceSemanticRecovery(await analyze('.local { --primary: #123456; }'));
  const candidate = result.traces.find(x => x.candidate_semantic_role === "primary");
  expect(candidate).toMatchObject({ decision: "ABSTAIN_INSUFFICIENT_EVIDENCE", confidence_result: { score: null, band: "UNKNOWN" }, confidence_inputs: { threshold_used: false } });
  expect(candidate?.provenance[0]?.source).toMatchObject({ file: "src/app.css", type: "SPAN" });
  expect(candidate?.negative_evidence.length).toBeGreaterThan(0);
});
it("records competing role values as conflict without tuning weights", async () => {
  const result = traceSemanticRecovery(await analyze(':root { --primary: #123456; } .dark { --primary: #654321; }'));
  const candidate = result.traces.find(x => x.candidate_semantic_role === "primary");
  expect(candidate?.decision).toBe("ABSTAIN_CONFLICT");
  expect(candidate?.conflicting_evidence).toHaveLength(1);
});
it("records dynamic abstention and actual confidence ledger for accepted name-based inference", async () => {
  const result = traceSemanticRecovery(await analyze(':root { --primary: #123456; }', 'export function Button({tone}:{tone:string}){ return <button className={`bg-${tone}`}/> }'));
  expect(result.traces.some(x => x.decision === "ABSTAIN_DYNAMIC")).toBe(true);
  expect(result.traces.find(x => x.decision === "ACCEPTED")?.confidence_result).toMatchObject({ status: "ASSESSED", score: 2, adjustments: [expect.objectContaining({ ruleId: "BASE_STATIC_SUPPORT" })] });
});
it("preserves cva choice labels while abstaining on an unsupported variant axis", async () => {
  const bundle = await analyze('', 'import {cva} from "class-variance-authority"; const variants=cva("rounded-md",{variants:{intent:{default:"bg-blue-500",destructive:"bg-red-500",outline:"border"}},defaultVariants:{intent:"default"}});export function Button(){return <button className={variants({intent:"default"})}/>;}');
  expect(bundle.observations.some(x => x.kind === "component_style_usage")).toBe(true);
  const classes = bundle.observations.filter(x => x.id.startsWith("tailwind-class:"));
  expect(classes.some(x => JSON.stringify(x.value).includes('"usageMode":"CONDITIONAL"'))).toBe(true);
  expect(classes.some(x => JSON.stringify(x.value).includes('"variantName":"intent"') && JSON.stringify(x.value).includes('"variantValue":"default"'))).toBe(true);
  expect(traceSemanticRecovery(bundle).summary.candidatesGenerated).toBe(0);
});
it("planner consumes the existing inferred role vocabulary without granting automatic edits", async () => {
  const bundle = await analyze(':root { --primary-foreground: #ffffff; }', 'export function Button(){return <button className="text-primary-foreground"/>}');
  expect(recoverDesignSystem(bundle).sections.semanticTokens.find(x => x.key === "role:primary-foreground")?.status).toBe("INFERRED");
  const plan = planMigration(bundle, await loadStylePack("neutral-modern"));
  expect(plan.items.find(x => x.current.includes("text-primary-foreground"))).toMatchObject({ kind: "UNCHANGED_SEMANTIC_USAGE", role: "primary-foreground", decision: "DO_NOT_TOUCH" });
  expect(plan.summary.autoSafe).toBe(0);
});
function withInference(bundle: ReadonlyEvidenceBundle, evidenceId: string) {
  const copy = structuredClone(bundle);
  const inference = { id: "synthetic:component-primary", status: "INFERRED" as const, kind: "semantic_mapping", value: { sourceValue: "#123456", role: "primary" }, rationale: "Synthetic wiring probe only, not production inference.", evidence: [{ evidenceId, relationship: "SUPPORTS" as const }] };
  const inferences = [...copy.inferences, inference];
  const { contentFingerprint: previousFingerprint, ...base } = copy;
  expect(previousFingerprint).toMatch(/^sha256:/u);
  const payload = { ...base, inferences, provenance: createProvenanceGraph({ ...copy, inferences }) };
  return { ...payload, contentFingerprint: createBundleContentFingerprint({ ...payload, snapshot: { ...payload.snapshot, createdAt: "" } }) };
}
it("diagnoses that a valid synthetic generic INFERRED mapping is not a planner input lane", async () => {
  const bundle = await analyze('.x { color: #123456; }');
  const observation = bundle.observations.find(x => x.kind === "design_value_usage");
  if (!observation) throw new Error("Expected source evidence");
  const synthetic = evidenceBundleSchema.parse(withInference(bundle, observation.id));
  expect(synthetic.inferences).toHaveLength(1);
  const pack = await loadStylePack("neutral-modern");
  expect(planMigration(synthetic, pack).items).toEqual(planMigration(bundle, pack).items);
  expect(planMigration(synthetic, pack).items.find(x => x.kind === "RAW_LITERAL_REPLACEMENT")?.status).toBe("UNKNOWN");
});
it("rejects an invalid synthetic mapping at the schema boundary, not a nonexistent planner mapping API", async () => {
  const bundle = await analyze('.x { color: #123456; }');
  expect(evidenceBundleSchema.safeParse(withInference(bundle, "missing-observation")).success).toBe(false);
});
