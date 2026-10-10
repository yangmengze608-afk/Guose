import { describe, it, expect, beforeAll } from "vitest";
import { readFile, mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { BriefApprovalReceipt } from "../src/intent/brief-review.js";
import { detectRepository } from "../src/repo/index.js";
import { compileTransformationPlan, type CompileTransformationRequest } from "../src/transformation/compiler.js";
import { transformationPlanSchema, type PlanningBinding, type TransformationPlan } from "../src/transformation/schema.js";
import { createBundleContentFingerprint as fp, hashContent } from "../src/utils/content-hash.js";
import { compareGoldenPlan } from "../src/transformation/evaluation.js";
import { modernEasternDemoStrategy, transformationRules } from "../src/transformation/strategy.js";

const fixture = fileURLToPath(new URL("./fixtures/transformation-project", import.meta.url));
let approved: BriefApprovalReceipt;
let request: CompileTransformationRequest;
beforeAll(async () => {
  approved = (JSON.parse(await readFile(new URL("../docs/validation/t2/design-brief-approval.json", import.meta.url), "utf8")) as { receipt: BriefApprovalReceipt }).receipt;
  request = await syntheticRequest(fixture);
});

// Synthetic approval/binding data for read-only compiler tests, never user events
// or execution permission. Real demo audit is evaluated separately.
async function syntheticRequest(root: string, entry = "dashboard.tsx", page = "dashboard") {
  const bundle = await detectRepository(root), receipt = structuredClone(approved);
  receipt.brief.scope.targets = [page]; receipt.briefFingerprint = fp(receipt.brief);
  const parent = path.dirname(root), targetPath = path.basename(root);
  const binding = { status: "CONFIRMED_FOR_T3_PLANNING", targetConfirmed: true, planningAllowed: true, briefHash: receipt.briefFingerprint,
    repoIdentity: { root: parent, targetPath, identityHash: hashContent(`${parent}\n${targetPath}`) },
    pageTarget: { entry, logicalTarget: page, selector: `${page === "dashboard" ? "article" : "main"}[data-page="${page}"]` },
    scope: { allowed: receipt.brief.modify, preserved: receipt.brief.preserve, allowLayoutChange: false, protectedPaths: [] },
    baseline: { workingTreeFingerprint: bundle.snapshot.workingTreeFingerprint, configHash: bundle.snapshot.configHash, evidenceFingerprint: bundle.contentFingerprint },
  };
  return { briefApproval: receipt, confirmedBinding: binding, expectedBriefHash: receipt.briefFingerprint, expectedBindingHash: fp(binding), bundle };
}
function variant(edit: (r: CompileTransformationRequest, b: PlanningBinding) => void) {
  const r = { ...request, briefApproval: structuredClone(request.briefApproval), confirmedBinding: structuredClone(request.confirmedBinding) };
  const binding = r.confirmedBinding as PlanningBinding;
  edit(r, binding); r.briefApproval.briefFingerprint = fp(r.briefApproval.brief); r.expectedBriefHash = r.briefApproval.briefFingerprint;
  binding.briefHash = r.expectedBriefHash; r.expectedBindingHash = fp(binding);
  return r;
}

describe("Brief-bound read-only plan compiler", () => {
  it("generates all supported core categories without T3 input", async () => {
    const plan = await compileTransformationPlan(request);
    expect(plan.operations.length).toBeGreaterThan(20);
    expect(new Set(plan.operations.map(x => x.type))).toEqual(new Set(["PAGE_BACKGROUND", "TEXT_COLOR", "ACCENT_COLOR", "BUTTON_BACKGROUND", "BUTTON_FOREGROUND", "BUTTON_RADIUS", "BUTTON_SHADOW", "BUTTON_BORDER", "CARD_BACKGROUND", "CARD_RADIUS", "CARD_SHADOW", "CARD_BORDER", "SECTION_SPACING", "COMPONENT_PADDING", "CTA_BACKGROUND"]));
    expect(plan.executionAllowed).toBe(false);
    expect(plan.operations.every(x => x.approvalStatus === "REVIEW_REQUIRED")).toBe(true);
  });
  it("is deterministic and immutable", async () => {
    const a = await compileTransformationPlan(request), b = await compileTransformationPlan(request);
    expect(a).toEqual(b); expect(Object.isFrozen(a.operations)).toBe(true);
    expect(Object.isFrozen(modernEasternDemoStrategy.palette)).toBe(true);
    expect(Object.isFrozen(transformationRules[0]!.intent)).toBe(true);
  });
  it("Card provenance does not borrow unrelated Button templates from the same file", async () => {
    const p = await compileTransformationPlan(request);
    const cards = p.operations.filter(x => ["flat", "elevated", "cta"].includes(x.target.role));
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every(x => !x.before.authoredClasses.includes("bg-primary") && !x.before.authoredClasses.includes("rounded-full"))).toBe(true);
  });
  it("rejects an unapproved brief", async () => {
    const r = { ...request, briefApproval: { ...request.briefApproval, status: "DRAFT" } as unknown as BriefApprovalReceipt };
    await expect(compileTransformationPlan(r)).rejects.toThrow("UNAPPROVED");
  });
  it("rejects changed brief content and pinned brief hash", async () => {
    const r = { ...request, briefApproval: structuredClone(request.briefApproval) };
    r.briefApproval.brief.intensity = "low";
    await expect(compileTransformationPlan(r)).rejects.toThrow("STALE_BRIEF");
    await expect(compileTransformationPlan({ ...request, expectedBriefHash: `sha256:${"0".repeat(64)}` })).rejects.toThrow("STALE_BRIEF");
  });
  it("rejects stale binding content and evidence identity", async () => {
    await expect(compileTransformationPlan({ ...request, expectedBindingHash: `sha256:${"0".repeat(64)}` })).rejects.toThrow("STALE_BINDING");
    const r = variant((_r, b) => { b.baseline.workingTreeFingerprint = `sha256:${"0".repeat(64)}`; });
    await expect(compileTransformationPlan(r)).rejects.toThrow("STALE_BINDING");
  });
  it("rejects unconfirmed target and target substitution", async () => {
    const b = { ...(request.confirmedBinding as PlanningBinding), targetConfirmed: false };
    await expect(compileTransformationPlan({ ...request, confirmedBinding: b, expectedBindingHash: fp(b) })).rejects.toThrow();
    const r = variant((_r, b) => { b.pageTarget.logicalTarget = "not-approved"; });
    await expect(compileTransformationPlan(r)).rejects.toThrow("STALE_BINDING");
  });
  it.each(["palette", "radius", "button", "card"])("preserved %s blocks its visual operations", async dimension => {
    const r = variant((r, b) => { r.briefApproval.brief.modify = r.briefApproval.brief.modify.filter(x => x !== dimension); r.briefApproval.brief.preserve.push(dimension); b.scope.allowed = b.scope.allowed.filter(x => x !== dimension); });
    const p = await compileTransformationPlan(r);
    if (dimension === "palette") expect(p.operations.some(x => /BACKGROUND|FOREGROUND|COLOR/u.test(x.type))).toBe(false);
    if (dimension === "radius") expect(p.operations.some(x => x.type.endsWith("RADIUS"))).toBe(false);
    if (dimension === "button") expect(p.operations.some(x => ["primary", "secondary"].includes(x.target.role))).toBe(false);
    if (dimension === "card") expect(p.operations.some(x => ["cta", "flat", "elevated"].includes(x.target.role))).toBe(false);
  });
  it("binding can narrow but never expand brief categories", async () => {
    const r = variant((_r, b) => { b.scope.allowed = ["page-background", "palette"]; });
    const p = await compileTransformationPlan(r);
    expect(p.operations.every(x => ["PAGE_BACKGROUND", "TEXT_COLOR", "ACCENT_COLOR"].includes(x.type))).toBe(true);
  });
  it("protected entry rejects and shared sources are never edit targets", async () => {
    const r = variant((_r, b) => { b.scope.protectedPaths = ["dashboard.tsx"]; });
    await expect(compileTransformationPlan(r)).rejects.toThrow("REJECTED_PROTECTED_SCOPE");
    const p = await compileTransformationPlan(request);
    expect(p.operations.every(x => x.targetFile === "dashboard.tsx")).toBe(true);
    expect(p.abstentions.some(x => x.identity === "components.tsx" && x.status === "REJECTED_PROTECTED_SCOPE")).toBe(true);
  });
  it("low intensity does not receive high palette, radius, padding or spacing", async () => {
    const p = await compileTransformationPlan(variant(r => { r.briefApproval.brief.intensity = "low"; }));
    expect(p.operations.length).toBeGreaterThan(0);
    expect(p.operations.every(x => x.type === "CARD_SHADOW" && x.proposal.intensity === "low")).toBe(true);
    expect(p.abstentions.some(x => x.reason.startsWith("Low/medium"))).toBe(true);
  });
  it("unsupported style/traditional strength abstains rather than invents", async () => {
    const p = await compileTransformationPlan(variant(r => { r.briefApproval.brief.traditionalStrength = 0.8; }));
    expect(p.operations).toHaveLength(0);
    expect(p.abstentions.some(x => x.reason.includes("Unsupported strategy"))).toBe(true);
  });
  it("every operation cites existing evidence, strategy, brief and scope; no probability", async () => {
    const p = await compileTransformationPlan(request), ids = new Set(request.bundle.observations.map(x => x.id));
    for (const op of p.operations) {
      expect(op.repoEvidence.length).toBeGreaterThan(0); expect(op.repoEvidence.every(id => ids.has(id))).toBe(true);
      expect(op.proposal.source).toBe("STYLE_STRATEGY"); expect(op.after.status).toBe("INFERRED");
      expect(op.scopeEvidence.bindingHash).toBe(p.source.bindingHash); expect(op.target.selector.startsWith(p.scopeProposal.selector)).toBe(true);
      expect(op.target.selector).not.toMatch(/nth-|!important/u); expect(op.briefRequirement.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(p.operations)).not.toMatch(/probability|posterior|AUTO_APPROVED|font-family|grid-template|animation/u);
  });
  it("compiler works on another filename, root and layout order", async () => {
    const p = await compileTransformationPlan(await syntheticRequest(fixture, "landing.tsx", "landing"));
    expect(p.operations.some(x => x.type === "BUTTON_RADIUS")).toBe(true);
    expect(p.operations.every(x => x.targetFile === "landing.tsx")).toBe(true);
  });
  it("golden reference is evaluation-only and core direction matches on a non-demo target", async () => {
    const p = await compileTransformationPlan(request);
    const golden = JSON.parse(await readFile(new URL("../docs/validation/p1/golden-reference.json", import.meta.url), "utf8")) as Parameters<typeof compareGoldenPlan>[1];
    const comparison = compareGoldenPlan(p, golden);
    expect(comparison.unsafe).toBe(0); expect(comparison.unauthorized).toBe(0);
    expect(comparison.match).toBeGreaterThan(10);
    expect(comparison.match + comparison.acceptableVariation).toBe(p.operations.length);
  });
  it("schema refuses protected mutation, layout, global selector and important even with rehash", async () => {
    const p = await compileTransformationPlan(request);
    for (const mutate of [(p: TransformationPlan) => { p.operations[0]!.targetFile = "components.tsx"; }, (p: TransformationPlan) => { p.operations[0]!.target.selector = "button"; }, (p: TransformationPlan) => { p.operations[0]!.after.declarations.color = "red !important"; }, (p: TransformationPlan) => { p.operations[0]!.target.selector = `${p.scopeProposal.selector}+button`; }, (p: TransformationPlan) => { p.operations[0]!.target.selector = `${p.scopeProposal.selector} ~button`; }, (p: TransformationPlan) => { p.operations[0]!.after.declarations["grid-template-columns"] = "1fr"; }]) {
      const bad = structuredClone(p); mutate(bad); const { contentFingerprint: _hash, ...payload } = bad; void _hash;
      expect(transformationPlanSchema.safeParse({ ...payload, contentFingerprint: fp(payload) }).success).toBe(false);
    }
  });
});

describe("adversarial static targets and freshness", () => {
  async function modified(edit: (root: string) => Promise<void>, check: (r: CompileTransformationRequest) => Promise<void>) {
    const root = await mkdtemp(path.join(tmpdir(), "guose-compiler-test-"));
    try { await cp(fixture, root, { recursive: true }); await edit(root); await check(await syntheticRequest(root)); }
    finally { await rm(root, { recursive: true, force: false }); }
  }
  it("dynamic Button variant abstains for the whole selector family", async () => {
    await modified(async root => { const p = path.join(root, "dashboard.tsx"); await writeFile(p, (await readFile(p, "utf8")).replace('<Action>Continue', '<Action variant={mode}>Continue')); }, async r => {
      const p = await compileTransformationPlan(r);
      expect(p.operations.some(x => x.type.startsWith("BUTTON_"))).toBe(false);
      expect(p.abstentions.some(x => x.reason.includes("Dynamic"))).toBe(true);
    });
  });
  it("implicit variant follows the observed CVA default, not a guessed primary default", async () => {
    await modified(async root => { const p = path.join(root, "components.tsx"); await writeFile(p, (await readFile(p, "utf8")).replace('defaultVariants: { variant: "default" }', 'defaultVariants: { variant: "secondary" }')); }, async r => {
      const p = await compileTransformationPlan(r), buttons = p.operations.filter(x => x.type.startsWith("BUTTON_"));
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.every(x => x.target.role === "secondary" && !x.before.authoredClasses.includes("bg-primary"))).toBe(true);
    });
  });
  it("an unrelated CVA helper cannot contaminate Button evidence", async () => {
    await modified(async root => { const p = path.join(root, "components.tsx"); await writeFile(p, `${await readFile(p, "utf8")}\nconst unrelated = cva("bg-red-500 rounded-none");\n`); }, async r => {
      const p = await compileTransformationPlan(r), buttons = p.operations.filter(x => x.type.startsWith("BUTTON_"));
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.every(x => !x.before.authoredClasses.includes("bg-red-500") && !x.before.authoredClasses.includes("rounded-none"))).toBe(true);
    });
  });
  it("a local background override makes the shared Button selector unresolved", async () => {
    await modified(async root => { const p = path.join(root, "dashboard.tsx"); await writeFile(p, (await readFile(p, "utf8")).replace('<Action>Continue', '<Action className="bg-red-500">Continue')); }, async r => {
      const p = await compileTransformationPlan(r);
      expect(p.operations.some(x => x.type.startsWith("BUTTON_"))).toBe(false);
      expect(p.abstentions.some(x => x.status === "UNRESOLVED_SCOPE" && x.reason.includes("override"))).toBe(true);
    });
  });
  it("shared Button with no data-slot has UNRESOLVED_SCOPE", async () => {
    await modified(async root => { const p = path.join(root, "components.tsx"); await writeFile(p, (await readFile(p, "utf8")).replace('data-slot="button"', '')); }, async r => {
      const p = await compileTransformationPlan(r);
      expect(p.operations.some(x => x.type.startsWith("BUTTON_"))).toBe(false);
      expect(p.abstentions.some(x => x.status === "UNRESOLVED_SCOPE")).toBe(true);
    });
  });
  it("opaque component inside root prevents inherited leakage", async () => {
    await modified(async root => { const p = path.join(root, "dashboard.tsx"); await writeFile(p, (await readFile(p, "utf8")).replace('<Action>Continue', '<ProtectedNav /><Action>Continue')); }, async r => {
      const p = await compileTransformationPlan(r); expect(p.operations).toHaveLength(0);
      expect(p.abstentions.some(x => x.status === "UNRESOLVED_SCOPE")).toBe(true);
    });
  });
  it("live source change after scan rejects without writing any plan or target", async () => {
    await modified(async () => {}, async r => {
      const b = r.confirmedBinding as PlanningBinding, p = path.join(b.repoIdentity.root, b.repoIdentity.targetPath, b.pageTarget.entry);
      await writeFile(p, `${await readFile(p, "utf8")}\n// synthetic stale control\n`);
      await expect(compileTransformationPlan(r)).rejects.toThrow("STALE_BINDING");
    });
  });
  it("rehydrated bundle is data, not filesystem authority", async () => {
    await expect(compileTransformationPlan({ ...request, bundle: JSON.parse(JSON.stringify(request.bundle)) as typeof request.bundle })).rejects.toThrow();
  });
  it("duplicate scope roots do not compile", async () => {
    await modified(async root => { const p = path.join(root, "dashboard.tsx"); await writeFile(p, `${await readFile(p, "utf8")}\nexport const Duplicate = () => <article data-page="dashboard" />;`); }, async r => {
      await expect(compileTransformationPlan(r)).rejects.toThrow("UNRESOLVED_SCOPE");
    });
  });
});
