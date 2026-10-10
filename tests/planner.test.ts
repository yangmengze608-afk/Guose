import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planMigration } from "../src/planner/index.js";
import { detectRepository } from "../src/repo/index.js";
import { loadStylePack } from "../src/style-packs/index.js";
import { createBundleContentFingerprint } from "../src/utils/content-hash.js";
import { migrationPlanSchema, type MigrationPlan } from "../src/schemas/index.js";

const directories: string[] = [];
async function analyze(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "guose-plan-"));
  directories.push(root);
  for (const [file, content] of Object.entries({ "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }), ...files })) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const bundle = await detectRepository(root);
  const pack = await loadStylePack("neutral-modern");
  return { root, bundle, pack, plan: planMigration(bundle, pack) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("review-first migration planner", () => {
  it("proposes a bounded review hypothesis, not AUTO_SAFE or behavior equivalence", async () => {
    const css = ':root { --primary: #fff; } .button { color: var(--primary); } .button { color: #fff; }';
    const { root, bundle, pack, plan } = await analyze({
      "src/app.css": css,
      "src/App.tsx": 'export const App = () => <button style={{ "--primary": "#000" }} />;',
    });
    const candidate = plan.items.find(({ kind }) => kind === "RAW_LITERAL_REPLACEMENT");
    expect(candidate).toMatchObject({ status: "INFERRED", role: "primary", target: "var(--primary)", decision: "REVIEW_REQUIRED", risk: "MEDIUM", confidence: { score: 2 } });
    expect(candidate?.rationale).toContain("behavior remain unproven");
    expect(plan.summary.autoSafe).toBe(0);
    expect(candidate?.provenance.every(({ evidenceId }) => bundle.observations.some(({ id }) => id === evidenceId))).toBe(true);
    expect(planMigration(bundle, pack)).toEqual(plan);
    expect(Object.isFrozen(plan.items)).toBe(true);
    expect(await readFile(path.join(root, "src/app.css"), "utf8")).toBe(css);
  });
  it("does not choose between same-value roles or infer role from equality alone", async () => {
    const { plan } = await analyze({ "src/app.css": ':root { --primary: #fff; --background: #fff; } .x { color: #fff; }' });
    const item = plan.items.find(({ kind }) => kind === "RAW_LITERAL_REPLACEMENT");
    expect(item).toMatchObject({ status: "UNKNOWN", target: null, decision: "REVIEW_REQUIRED", confidence: { score: null }, candidateTokens: ["--background", "--primary"] });
    const unique = await analyze({ "src/app.css": ':root { --primary: #fff; } .x { color: #fff; }' });
    expect(unique.plan.items.find(({ kind }) => kind === "RAW_LITERAL_REPLACEMENT")).toMatchObject({ status: "UNKNOWN", role: null, target: null, decision: "REVIEW_REQUIRED" });
  });
  it("does not rewrite shorthands, scoped/conditional tokens or unsupported utility classes", async () => {
    const { plan } = await analyze({
      "src/app.css": ':root { --primary: #fff; } .dark { --primary: #000; } .x { color: var(--primary); border: 1px solid #fff; color: #fff; } @media (min-width: 800px) { .x { color: #fff; } }',
      "src/App.tsx": 'export const App = () => <main className="bg-red-500" />;',
    });
    expect(plan.items.filter(({ kind }) => kind === "RAW_LITERAL_REPLACEMENT").every(({ decision }) => decision === "DO_NOT_TOUCH")).toBe(true);
    expect(plan.items.find(({ current }) => current.includes("bg-red-500"))).toMatchObject({ status: "UNKNOWN", decision: "DO_NOT_TOUCH" });
  });
  it("blocks review substitutions when any production CSS failed parsing", async () => {
    const { plan } = await analyze({
      "src/app.css": ':root { --primary: #fff; } .x { color: var(--primary); } .x { color: #fff; }',
      "src/broken.css": '.x { color:',
    });
    const item = plan.items.find(({ kind }) => kind === "RAW_LITERAL_REPLACEMENT");
    expect(item?.decision).toBe("DO_NOT_TOUCH");
    expect(item?.blockingUnknownIds.length).toBeGreaterThan(0);
    const policy = plan.items.find(({ kind }) => kind === "TOKEN_POLICY_CHANGE");
    expect(policy).toMatchObject({ status: "UNKNOWN", target: null, decision: "DO_NOT_TOUCH", confidence: { score: null } });
    expect(policy?.blockingUnknownIds).toEqual(item?.blockingUnknownIds);
  });
  it("separates generic variable references and blocks unresolved imported CSS", async () => {
    const { bundle, plan } = await analyze({
      "src/app.css": ':root { --primary: #fff; } .x { color: var(--font-sans); }',
      "src/layout.tsx": 'import "@shared/ui/globals.css"; export const Layout = () => <main />;',
    });
    expect(bundle.unknowns.some(({ kind }) => kind === "css_dependency")).toBe(true);
    expect(plan.summary.existingSemanticUsages).toBe(0);
    expect(plan.summary.existingVariableReferences).toBe(1);
    expect(plan.items.find(({ kind }) => kind === "TOKEN_POLICY_CHANGE")).toMatchObject({ status: "UNKNOWN", target: null, decision: "DO_NOT_TOUCH" });
  });
  it("keeps token policy changes separate and recognizes already semantic projects", async () => {
    const { plan } = await analyze({
      "src/app.css": ':root { --primary: #18181b; --background: #ffffff; } .x { background-color: var(--background); }',
      "src/App.tsx": 'export const App = () => <main className="bg-primary" />;',
      "tests/fixture.css": '.x { color: #abcdef; }',
      "vendor/theme.css": '.x { color: #123456; }',
    });
    expect(plan.summary.rawLiteralReviewCandidates).toBe(0);
    expect(plan.summary.tokenPolicyReviewChanges).toBe(0);
    expect(plan.summary.existingSemanticUsages).toBe(2);
    expect(plan.items.some(({ current }) => current.includes("#abcdef") || current.includes("#123456"))).toBe(false);
    expect(plan.summary.statement).toContain("not a completeness guarantee");
  });
  it("rejects tampering, fake AUTO_SAFE and miscounted plan artifacts", async () => {
    const { plan } = await analyze({ "src/app.css": ':root { --primary: #fff; }' });
    const fake = structuredClone(plan) as MigrationPlan;
    const item = fake.items[0];
    if (item === undefined) throw new Error("Expected policy item");
    item.decision = "AUTO_SAFE";
    const { contentFingerprint, ...payload } = fake;
    expect(contentFingerprint).toMatch(/^sha256:/u);
    expect(migrationPlanSchema.safeParse({ ...payload, contentFingerprint: createBundleContentFingerprint(payload) }).success).toBe(false);
    expect(migrationPlanSchema.safeParse({ ...plan, summary: { ...plan.summary, reviewRequired: 99 } }).success).toBe(false);
  });
});
