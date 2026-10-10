import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGrillSession } from "../src/intent/grill-session.js";
import type { GrillBindings } from "../src/intent/grill-session.js";
import { createDesignBriefReview, assessBriefApproval } from "../src/intent/brief-review.js";
import { createBundleContentFingerprint } from "../src/utils/content-hash.js";

const realSession = readFileSync(new URL("./fixtures/grill/home-modern-eastern.md", import.meta.url), "utf8");
const realBindings = JSON.parse(readFileSync(new URL("./fixtures/grill/home-modern-eastern.bindings.json", import.meta.url), "utf8")) as GrillBindings;
const sourceId = "tests/fixtures/grill/home-modern-eastern.md";

// Synthetic review events and bundles below test the API; they are not the user's approval.
function bundle(override: Record<string, unknown> = {}) {
  const payload = {
    schemaVersion: "1.0.0", snapshot: { gitHead: null, gitDirty: null, gitStateReason: "NOT_GIT_REPOSITORY",
      workingTreeFingerprint: `sha256:${"a".repeat(64)}`, configHash: `sha256:${"b".repeat(64)}`,
      files: [], stylePack: null, guoseVersion: "0.1.0-dev.0", createdAt: "2026-10-06T00:00:00.000Z", ...override },
    repository: { root: ".", frameworks: ["react"], stylingSystems: ["tailwind"], supportStatus: "SUPPORTED" },
    observations: [], inferences: [], unknowns: [], provenance: { sources: [], edges: [] },
  };
  return { ...payload, contentFingerprint: createBundleContentFingerprint({ ...payload, snapshot: { ...payload.snapshot, createdAt: "" } }) };
}
function resolvedReview(baseline?: unknown) {
  const review = createDesignBriefReview(realSession, realBindings, sourceId, baseline);
  review.edit({ traditionalStrength: 0.3, intensity: "high", unresolvedQuestions: [] });
  return review;
}
function context(review: ReturnType<typeof createDesignBriefReview>, currentBundle?: unknown) {
  return { actor: "synthetic-test-human", sessionMarkdown: realSession,
    displayedDraftFingerprint: review.view().draft.fingerprint, currentBundle };
}

describe("real native Grill session adapter", () => {
  it("parses the real session and honestly leaves two required fields missing", () => {
    const draft = parseGrillSession(realSession, realBindings, sourceId);
    expect(draft.status).toBe("DRAFT");
    expect(draft.missing).toEqual(["traditionalStrength", "intensity"]);
    expect(draft.candidate).not.toHaveProperty("traditionalStrength");
    expect(draft.candidate).not.toHaveProperty("intensity");
    expect(draft.canConfirm).toBe(false);
    expect(draft.candidate.scope).toEqual({ type: "page", targets: ["guose-demo/home"] });
    expect(draft.sections["Key decisions"]).toContain("偏灰、不过分发黄");
    expect(draft.sections.Constraints).toContain("其他页面");
  });
  it("does not convert 70% of visual language into tradition strength or certainty", () => {
    const draft = parseGrillSession(realSession, realBindings);
    expect(draft.sections["Key decisions"]).toContain("70%");
    expect(draft.fields.traditionalStrength.status).toBe("MISSING");
    expect(draft.fields.style.status).toBe("NEEDS_CONFIRMATION");
  });
  it("keeps quote provenance that resolves back to real session lines", () => {
    const draft = parseGrillSession(realSession, realBindings, sourceId);
    const lines = realSession.split("\n");
    for (const field of Object.values(draft.fields)) for (const citation of field.citations) {
      expect(citation.sourceId).toBe(sourceId);
      expect(lines.slice(citation.startLine - 1, citation.endLine).join("\n")).toContain(citation.quote);
    }
    expect(Object.isFrozen(draft.candidate.scope)).toBe(true);
  });
  it("does not invent unselected structured fields from natural prose", () => {
    const draft = parseGrillSession(realSession);
    expect(draft.candidate.goal).toContain("AI SaaS 模板感");
    expect(draft.fields.scope.status).toBe("MISSING");
    expect(draft.fields.style.status).toBe("MISSING");
  });
  it("preserves all native sections including constraints not representable in T1", () => {
    expect(Object.keys(parseGrillSession(realSession).sections)).toHaveLength(6);
  });
  it("marks missing or ambiguous quotes as issues instead of trusting a mapping", () => {
    const absent = parseGrillSession(realSession, { intensity: { value: "high", citations: [{ section: "Constraints", quote: "invented" }] } });
    expect(absent.parseIssues).toContain("Missing or ambiguous citation for intensity.");
    expect(absent.fields.intensity.status).toBe("MISSING");
    const duplicated = realSession.replace("克制不等于整个页面灰蒙蒙", "克制不等于整个页面灰蒙蒙；克制不等于整个页面灰蒙蒙");
    expect(parseGrillSession(duplicated, realBindings).parseIssues).toContain("Missing or ambiguous citation for avoid.");
  });
  it("does not clear native open questions via an empty mapping proposal", () => {
    const bindings = { ...realBindings, unresolvedQuestions: { value: [], citations: [{ section: "Intent" as const, quote: "AI SaaS 模板感" }] } };
    expect(parseGrillSession(realSession, bindings).candidate.unresolvedQuestions).toHaveLength(2);
  });
  it("ignores headings and claims in fenced code", () => {
    const fenced = `${realSession}\n\`\`\`md\n## Key decisions\n- CONFIRM\n\`\`\`\n`;
    expect(parseGrillSession(fenced, realBindings).parseIssues).toEqual([]);
    expect(parseGrillSession(fenced, realBindings).status).toBe("DRAFT");
  });
  it("keeps literal line citations when fenced material interrupts Intent", () => {
    const session = realSession.replace("## Intent\n", "## Intent\nFirst intent line\n```md\nignored claim\n```\n");
    const draft = parseGrillSession(session);
    expect(draft.candidate.goal).not.toContain("ignored claim");
    for (const citation of draft.fields.goal.citations) {
      expect(session.split("\n")[citation.startLine - 1]).toBe(citation.quote);
    }
  });
  it.each([
    realSession.replace("Date: 2026-10-06", "Date: 2026-99-99"),
    `${realSession}\n## Intent\ncontradiction`, `${realSession}\n## Unknown section\ntext`,
    `${realSession}\n\`\`\`\nunfinished`, realSession.replace("## Intent", "## Constraints"),
  ])("blocks confirmation for malformed native structure", (text) => {
    const review = createDesignBriefReview(text, realBindings);
    review.edit({ traditionalStrength: 0.3, intensity: "high", unresolvedQuestions: [] });
    expect(review.view().draft.canConfirm).toBe(false);
    expect(() => review.decide("CONFIRM", { ...context(review), sessionMarkdown: text })).toThrow();
  });
  it.each(["", "x".repeat(65537)])("rejects empty or unbounded session input", (text) => {
    expect(() => parseGrillSession(text)).toThrow();
  });
  it("rejects arbitrary field names and unsafe source identifiers", () => {
    expect(() => parseGrillSession(realSession, { execute: { value: "deploy", citations: [{ section: "Intent", quote: "AI SaaS 模板感" }] } } as GrillBindings)).toThrow();
    expect(() => parseGrillSession(realSession, {}, "../escape.md")).toThrow();
  });
});

describe("explicit human review and receipt freshness (synthetic events)", () => {
  it("cannot confirm the real unresolved DRAFT", () => {
    const review = createDesignBriefReview(realSession, realBindings);
    expect(() => review.decide("CONFIRM", context(review))).toThrow("MISSING");
    expect(review.view().status).toBe("DRAFT");
  });
  it("requires resolved fields, no open questions and a distinct CONFIRM event", () => {
    const review = resolvedReview();
    expect(review.view().status).toBe("DRAFT");
    expect(review.view().draft.brief).not.toBeNull();
    const result = review.decide("CONFIRM", context(review));
    expect(result.receipt?.targetBinding).toBe("UNBOUND");
    expect(result.receipt?.scope).toBe("DESIGN_INTENT_ONLY");
    expect(result.receipt?.nativeSections.Constraints).toContain("其他页面");
    expect(result.receipt?.nativeSections["Key decisions"]).toContain("主按钮用更深的强调色");
    expect(result.receipt?.fieldProvenance.traditionalStrength.sourceKind).toBe("HUMAN_EDIT");
    expect(assessBriefApproval(result.receipt, { sessionMarkdown: realSession, draftFingerprint: review.view().draft.fingerprint, currentBundle: bundle() })).toEqual({ status: "UNKNOWN", planningAllowed: false });
  });
  it("does not claim fresh target evidence for the future demo", () => {
    const review = resolvedReview();
    const receipt = review.decide("CONFIRM", context(review)).receipt;
    expect(receipt?.evidenceFingerprint).toBeNull();
    expect(assessBriefApproval(receipt, { sessionMarkdown: realSession, draftFingerprint: review.view().draft.fingerprint }).planningAllowed).toBe(false);
  });
  it.each(["EDIT", "CANCEL"])("revokes an old receipt after %s", (decision) => {
    const review = resolvedReview(bundle());
    const receipt = review.decide("CONFIRM", context(review, bundle())).receipt;
    review.decide(decision, context(review));
    expect(assessBriefApproval(receipt, { sessionMarkdown: realSession, draftFingerprint: review.view().draft.fingerprint, currentBundle: bundle() }).status).toBe("UNAPPROVED");
    if (decision === "CANCEL") expect(() => review.edit({ goal: "changed" })).toThrow();
  });
  it("invalidates previous approval when a field changes", () => {
    const review = resolvedReview(bundle());
    const receipt = review.decide("CONFIRM", context(review, bundle())).receipt;
    review.edit({ goal: "new intent" });
    expect(assessBriefApproval(receipt, { sessionMarkdown: realSession, draftFingerprint: review.view().draft.fingerprint, currentBundle: bundle() }).planningAllowed).toBe(false);
  });
  it("revokes approval even when a requested edit is invalid", () => {
    const review = resolvedReview(bundle());
    const receipt = review.decide("CONFIRM", context(review, bundle())).receipt;
    expect(() => review.edit({ traditionalStrength: 1.5 })).toThrow();
    expect(review.view().status).toBe("DRAFT");
    expect(assessBriefApproval(receipt, { sessionMarkdown: realSession, draftFingerprint: review.view().draft.fingerprint, currentBundle: bundle() }).status).toBe("UNAPPROVED");
  });
  it("rejects confirming a stale displayed draft or changed session", () => {
    const review = resolvedReview();
    const old = context(review); review.edit({ goal: "new goal" });
    expect(() => review.decide("CONFIRM", old)).toThrow("STALE");
    expect(() => review.decide("CONFIRM", { ...context(review), sessionMarkdown: `${realSession}\n` })).toThrow("STALE");
  });
  it("saved JSON cannot manufacture human or filesystem authority", () => {
    const review = resolvedReview(bundle());
    const receipt = review.decide("CONFIRM", context(review, bundle())).receipt;
    const copied: unknown = JSON.parse(JSON.stringify(receipt));
    expect(assessBriefApproval(copied, { sessionMarkdown: realSession, draftFingerprint: review.view().draft.fingerprint, currentBundle: bundle() })).toEqual({ status: "UNAPPROVED", planningAllowed: false });
  });
  it("compares fresh EvidenceBundle identity and ignores timestamps alone", () => {
    const review = resolvedReview(bundle());
    const receipt = review.decide("CONFIRM", context(review, bundle())).receipt;
    const result = assessBriefApproval(receipt, { sessionMarkdown: realSession, draftFingerprint: review.view().draft.fingerprint,
      currentBundle: bundle({ createdAt: "2026-10-07T00:00:00.000Z" }) });
    expect(result).toEqual({ status: "FRESH", planningAllowed: true });
  });
  it.each([
    { workingTreeFingerprint: `sha256:${"c".repeat(64)}` }, { configHash: `sha256:${"c".repeat(64)}` },
    { guoseVersion: "0.2.0" }, { gitHead: "c".repeat(40), gitDirty: false, gitStateReason: null },
  ])("marks a changed evidence dependency STALE", (override) => {
    const review = resolvedReview(bundle());
    const receipt = review.decide("CONFIRM", context(review, bundle())).receipt;
    const current = bundle(override);
    expect(assessBriefApproval(receipt, { sessionMarkdown: realSession, draftFingerprint: review.view().draft.fingerprint, currentBundle: current }).status).toBe("STALE");
    expect(() => review.decide("CONFIRM", context(review, current))).toThrow("STALE");
  });
  it.each([undefined, {}, bundle({ gitStateReason: "GIT_UNAVAILABLE" })])("does not approve UNKNOWN target freshness", (current) => {
    const review = resolvedReview(bundle());
    expect(() => review.decide("CONFIRM", context(review, current))).toThrow("UNKNOWN");
  });
  it("blocks contradictory human edits and preserves all native context", () => {
    const review = resolvedReview(); review.edit({ allowLayoutChange: true });
    expect(review.view().draft.canConfirm).toBe(false);
    expect(review.view().draft.sections.Constraints).toContain("Navbar");
    expect(() => review.decide("CONFIRM", context(review))).toThrow("MISSING");
  });
  it.each(["APPROVE", "CONFIRM; deploy", { decision: "CONFIRM" }])("does not accept injected decision commands", (decision) => {
    const review = resolvedReview(); expect(() => review.decide(decision, context(review))).toThrow();
  });
  it("requires a recorded human actor and rejects invalid individual edits", () => {
    const review = resolvedReview();
    expect(() => review.decide("CONFIRM", { ...context(review), actor: " " })).toThrow();
    expect(() => review.edit({ traditionalStrength: 1.5 })).toThrow();
  });
});
