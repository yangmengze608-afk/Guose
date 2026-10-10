import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assessRecoveredSystem } from "../src/confidence/index.js";
import { recoverDesignSystem } from "../src/recovery/index.js";
import { detectRepository } from "../src/repo/index.js";
import { assessedConfidenceSchema, createRecoveryContentFingerprint, currentDesignSystemSchema, type CurrentDesignSystem } from "../src/schemas/index.js";

const directories: string[] = [];
const unscored = { status: "UNSCORED", reasonCode: "PENDING_CONFIDENCE_MODEL", explanation: "Counterfactual input awaiting assessment." } as const;
async function analyze(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "guose-confidence-"));
  directories.push(root);
  for (const [file, content] of Object.entries({
    "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }), ...files,
  })) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const bundle = await detectRepository(root);
  return { bundle, system: recoverDesignSystem(bundle) };
}
function rehash(system: CurrentDesignSystem): CurrentDesignSystem {
  const payload = {
    schemaVersion: system.schemaVersion, source: system.source, sections: system.sections,
    unresolvedEvidenceIds: system.unresolvedEvidenceIds, coverage: system.coverage,
  };
  return { ...payload, contentFingerprint: createRecoveryContentFingerprint(payload) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("ordinal static-support confidence", () => {
  it("distinguishes direct declarations, exact-name inference and utility candidates", async () => {
    const { system } = await analyze({
      "src/app.css": ":root { --primary: #fff; }",
      "src/App.tsx": 'export const App = () => <main className="bg-primary rounded-md" />;',
    });
    expect(system.sections.semanticTokens.find(({ key }) => key === "--primary")?.confidence).toMatchObject({ score: 3, band: "HIGH" });
    expect(system.sections.semanticTokens.find(({ key }) => key === "role:primary")?.confidence).toMatchObject({ score: 2, band: "MEDIUM" });
    expect(system.sections.colors.find(({ key }) => key === "bg-primary")?.confidence).toMatchObject({ score: 1, band: "LOW" });
    // A reliable component identity cannot lend HIGH to candidate style claims.
    expect(system.sections.components[0]?.confidence).toMatchObject({ score: 1, band: "LOW" });
  });

  it("never assigns a numeric score to unresolved claims and records real role counterevidence", async () => {
    const { system } = await analyze({ "src/app.css": ':root { --primary: #fff; } .dark { --primary: #000; } .x { color: var(--missing); }' });
    const role = system.sections.semanticTokens.find(({ key }) => key === "role:primary");
    expect(role?.confidence).toMatchObject({ status: "UNRESOLVED", score: null, band: "UNKNOWN" });
    expect(role?.evidence.some(({ relationship }) => relationship === "CONFLICTS")).toBe(true);
    expect(system.sections.semanticTokens.find(({ key }) => key === "--primary")?.evidence.every(({ relationship }) => relationship === "SUPPORTS")).toBe(true);
    expect(system.sections.semanticTokens.find(({ key }) => key === "--missing")?.confidence).toMatchObject({ score: null });
    const malformed = structuredClone(system) as CurrentDesignSystem;
    const unknown = malformed.sections.semanticTokens.find(({ status }) => status === "UNKNOWN");
    if (unknown?.confidence.status !== "UNRESOLVED") throw new Error("Expected unresolved item");
    Object.assign(unknown.confidence, { score: 1 });
    expect(currentDesignSystemSchema.safeParse(rehash(malformed)).success).toBe(false);
  });

  it("does not boost repeated or cross-file candidates", async () => {
    const repeated = Array.from({ length: 30 }, (_, i) => `<div key={${i}} className="bg-red-500" />`).join("");
    const { system } = await analyze({
      "src/App.tsx": `export const App = () => <>${repeated}</>;`,
      "src/Other.tsx": 'export const Other = () => <main className="bg-red-500" />;',
    });
    const confidence = system.sections.colors.find(({ key }) => key === "bg-red-500")?.confidence;
    expect(confidence).toMatchObject({ score: 1, metrics: { supportingRecords: 31, supportingFiles: 2 } });
  });

  it("associates dynamic component UNKNOWN by evidence ID and leaves unrelated files alone", async () => {
    const { bundle, system } = await analyze({
      "src/App.tsx": 'export const App = ({ x }) => <main className={x} />;',
      "src/app.css": ':root { --primary: #fff; }',
    });
    const component = system.sections.components[0];
    expect(bundle.unknowns.some(({ relatedEvidenceIds }) => relatedEvidenceIds.includes(component?.evidence[0]?.evidenceId ?? ""))).toBe(true);
    expect(component?.confidence).toMatchObject({ score: 2, metrics: { relatedUnknowns: 1 } });
    expect(system.sections.semanticTokens.find(({ key }) => key === "--primary")?.confidence).toMatchObject({ score: 3 });
  });

  it("explains conservative same-file caps and ignores excluded file unknowns", async () => {
    const { system } = await analyze({
      "src/app.css": ':root { --primary: #fff; --other: rgb(nonsense); }',
      "tests/App.test.tsx": 'export const App = ({ x }) => <main className={x} />;',
    });
    const confidence = system.sections.semanticTokens.find(({ key }) => key === "--primary")?.confidence;
    expect(confidence).toMatchObject({ score: 2, metrics: { sameFileUnknowns: 1, relatedUnknowns: 0 } });
    if (confidence?.status !== "ASSESSED") throw new Error("Expected assessed item");
    expect(confidence.adjustments.find(({ ruleId }) => ruleId === "SCOPED_UNRESOLVED")?.explanation).toContain("does not prove this exact item");
  });

  it("strictly lowers a scored claim when a true conflict reference is supplied", async () => {
    const { bundle, system } = await analyze({ "src/app.css": ':root { --primary: #fff; } :root { --primary: #fff; }' });
    const counterfactual = structuredClone(system) as CurrentDesignSystem;
    const claim = counterfactual.sections.semanticTokens.find(({ key }) => key === "--primary");
    if (claim === undefined || claim.evidence[1] === undefined) throw new Error("Expected two references");
    // Counterfactual scorer input tests relation handling, not an engine claim
    // that identical or different-selector declarations are actually conflicts.
    claim.evidence[1].relationship = "CONFLICTS";
    claim.confidence = unscored;
    const scored = assessRecoveredSystem(bundle, rehash(counterfactual));
    const confidence = scored.sections.semanticTokens.find(({ key }) => key === "--primary")?.confidence;
    expect(confidence).toMatchObject({ score: 1, band: "LOW", metrics: { supportingRecords: 1, conflicts: 1 } });
    if (confidence?.status !== "ASSESSED") throw new Error("Expected assessed item");
    expect(confidence.adjustments.find(({ ruleId }) => ruleId === "TRUE_CONFLICT")?.appliedDelta).toBeLessThan(0);
  });

  it("is permutation-invariant and rejects missing references or misleading counts", async () => {
    const { bundle, system } = await analyze({ "src/app.css": ':root { --primary: #fff; } .x { color: var(--primary); }' });
    const reordered = structuredClone(system) as CurrentDesignSystem;
    for (const section of Object.values(reordered.sections)) for (const item of section) item.evidence.reverse();
    expect(assessRecoveredSystem(bundle, rehash(reordered))).toEqual(system);
    const countMismatch = structuredClone(system) as CurrentDesignSystem;
    if (countMismatch.sections.colors[0] === undefined) throw new Error("Expected color");
    countMismatch.sections.colors[0].evidenceCount += 1;
    expect(currentDesignSystemSchema.safeParse(rehash(countMismatch)).success).toBe(false);
    const missing = structuredClone(system) as CurrentDesignSystem;
    if (missing.sections.colors[0]?.evidence[0] === undefined) throw new Error("Expected reference");
    missing.sections.colors[0].evidence[0].evidenceId = "missing";
    missing.sections.colors[0].confidence = unscored;
    expect(() => assessRecoveredSystem(bundle, rehash(missing))).toThrow("non-excluded observation");
  });

  it("rejects contradictory imported scores, counts and invented ledger rules", async () => {
    const { system } = await analyze({ "src/app.css": ':root { --primary: #fff; }' });
    const inflated = structuredClone(system) as CurrentDesignSystem;
    const role = inflated.sections.semanticTokens.find(({ key }) => key === "role:primary");
    if (role?.confidence.status !== "ASSESSED") throw new Error("Expected role score");
    role.confidence.score = 3;
    role.confidence.band = "HIGH";
    Object.assign(role.confidence.adjustments[0] ?? {}, { after: 3, appliedDelta: 3 });
    expect(currentDesignSystemSchema.safeParse(rehash(inflated)).success).toBe(false);
    const mismatched = structuredClone(system) as CurrentDesignSystem;
    const item = mismatched.sections.colors[0];
    if (item?.confidence.status !== "ASSESSED") throw new Error("Expected direct score");
    item.confidence.metrics.conflicts = 1;
    item.confidence.metrics.relatedUnknowns = 1;
    expect(currentDesignSystemSchema.safeParse(rehash(mismatched)).success).toBe(false);
    item.confidence.metrics.conflicts = 0;
    item.confidence.metrics.relatedUnknowns = 0;
    item.confidence.metrics.supportingRecords += 1;
    expect(currentDesignSystemSchema.safeParse(rehash(mismatched)).success).toBe(false);
    item.confidence.metrics.supportingRecords -= 1;
    item.confidence.metrics.supportingFiles = 99;
    expect(currentDesignSystemSchema.safeParse(rehash(mismatched)).success).toBe(false);
    item.confidence.metrics.supportingFiles = 1;
    Object.assign(item.confidence.adjustments[0] ?? {}, { ruleId: "INVENTED_BONUS" });
    expect(currentDesignSystemSchema.safeParse(rehash(mismatched)).success).toBe(false);
  });

  it("caps conditional, CVA and escaped utility evidence without a color candidate", async () => {
    const { system } = await analyze({
      "src/App.tsx": `import { cva } from "class-variance-authority";
const variants = cva("rounded-md", { variants: { size: { small: "p-2" } } });
export const App = () => <main className={variants()} />;`,
      "src/Escaped.tsx": 'export const Escaped = () => <main className={"rounded-\\x6dd"} />;',
    });
    const cva = system.sections.components.find(({ key }) => key === "src/App.tsx#App")?.confidence;
    if (cva?.status !== "ASSESSED") throw new Error("Expected assessed cva");
    expect(cva.score).toBe(2);
    expect(cva.adjustments.map(({ ruleId }) => ruleId)).toEqual(expect.arrayContaining(["CONDITIONAL_POSSIBLE_USAGE_CAP", "UTILITY_GENERATION_UNVERIFIED_CAP"]));
    const escaped = system.sections.components.find(({ key }) => key === "src/Escaped.tsx#Escaped")?.confidence;
    if (escaped?.status !== "ASSESSED") throw new Error("Expected escaped source");
    expect(escaped.score).toBe(2);
    expect(escaped.adjustments.some(({ ruleId }) => ruleId === "IMPRECISE_SOURCE_CAP")).toBe(true);
  });

  it("reduces candidate confidence to zero and reports saturated conflicts honestly", async () => {
    const { bundle, system } = await analyze({
      "src/App.tsx": 'export const App = () => <><div className="bg-red-500" /><div className="bg-red-500" /><div className="bg-red-500" /></>;',
    });
    const input = structuredClone(system) as CurrentDesignSystem;
    const item = input.sections.colors[0];
    if (item === undefined) throw new Error("Expected candidate");
    item.confidence = unscored;
    for (const reference of item.evidence.slice(1)) reference.relationship = "CONFLICTS";
    const confidence = assessRecoveredSystem(bundle, rehash(input)).sections.colors[0]?.confidence;
    if (confidence?.status !== "ASSESSED") throw new Error("Expected numeric low support");
    expect(confidence).toMatchObject({ score: 0, band: "LOW", metrics: { supportingRecords: 1, conflicts: 2 } });
    const penalties = confidence.adjustments.filter(({ ruleId }) => ruleId === "TRUE_CONFLICT");
    expect(penalties.map(({ appliedDelta }) => appliedDelta)).toEqual([-1, 0]);
    expect(penalties[1]?.explanation).toContain("floor");
    const fakeFloor = structuredClone(confidence);
    fakeFloor.score = 1;
    for (const entry of fakeFloor.adjustments.filter(({ ruleId }) => ruleId === "TRUE_CONFLICT")) {
      Object.assign(entry, { before: 1, after: 1, appliedDelta: 0, explanation: "Already at floor" });
    }
    expect(assessedConfidenceSchema.safeParse(fakeFloor).success).toBe(false);
    for (const reference of item.evidence) reference.relationship = "CONFLICTS";
    expect(() => assessRecoveredSystem(bundle, rehash(input))).toThrow("requires supporting observations");
  });
});
