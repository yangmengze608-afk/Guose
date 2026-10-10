import { z } from "zod";
import { designBriefDecisionSchema, designBriefSchema, evidenceBundleSchema, sha256DigestSchema } from "../schemas/index.js";
import type { DesignBrief, EvidenceBundle } from "../schemas/index.js";
import { createBundleContentFingerprint, hashContent } from "../utils/content-hash.js";
import { deepFreeze } from "../utils/deep-freeze.js";
import { BRIEF_FIELDS, finalizeBriefDraft, parseGrillSession } from "./grill-session.js";
import type { BriefField, DesignBriefDraft, GrillBindings } from "./grill-session.js";

export type BriefApprovalReceipt = {
  schemaVersion: "1.0.0"; status: "APPROVED"; scope: "DESIGN_INTENT_ONLY";
  actor: string; approvedAt: string; revision: number; draftFingerprint: string;
  sessionFingerprint: string; briefFingerprint: string; brief: DesignBrief;
  nativeSections: DesignBriefDraft["sections"]; fieldProvenance: DesignBriefDraft["fields"];
  evidenceFingerprint: string | null; targetBinding: "BOUND" | "UNBOUND";
};
type ReviewContext = { displayedDraftFingerprint: string; sessionMarkdown: string; actor: string; currentBundle?: unknown };
type FreshnessContext = { draftFingerprint: string; sessionMarkdown: string; currentBundle?: unknown };
const issued = new WeakMap<object, { active: () => boolean; baseline: EvidenceBundle | null }>();

/** The trusted host must freshly scan a real target. JSON and relative roots
 * establish content identity only, never filesystem or operation authority. */
function bundleFreshness(baseline: EvidenceBundle | null, current: unknown): "FRESH" | "STALE" | "UNKNOWN" {
  if (baseline === null) return "UNKNOWN";
  const parsed = evidenceBundleSchema.safeParse(current);
  if (!parsed.success || baseline.snapshot.gitStateReason === "GIT_UNAVAILABLE" || parsed.data.snapshot.gitStateReason === "GIT_UNAVAILABLE") return "UNKNOWN";
  return baseline.contentFingerprint === parsed.data.contentFingerprint ? "FRESH" : "STALE";
}

export function assessBriefApproval(receipt: unknown, context: FreshnessContext) {
  const state = typeof receipt === "object" && receipt !== null ? issued.get(receipt) : undefined;
  if (!state || !state.active()) return deepFreeze({ status: "UNAPPROVED" as const, planningAllowed: false });
  const item = receipt as BriefApprovalReceipt;
  if (hashContent(context.sessionMarkdown) !== item.sessionFingerprint || context.draftFingerprint !== item.draftFingerprint) {
    return deepFreeze({ status: "STALE" as const, planningAllowed: false });
  }
  const status = bundleFreshness(state.baseline, context.currentBundle);
  return deepFreeze({ status, planningAllowed: status === "FRESH" });
}

/** In-memory review API: only explicit trusted-host human events create receipts.
 * Persisted receipts are audit data; reloading them requires renewed confirmation. */
export function createDesignBriefReview(markdown: string, bindings: GrillBindings = {}, sourceId = ".grill/session.md", baselineBundle?: unknown) {
  let draft = parseGrillSession(markdown, bindings, sourceId);
  const baseline = baselineBundle === undefined ? null : deepFreeze(evidenceBundleSchema.parse(baselineBundle));
  let revision = 0;
  let status: "DRAFT" | "APPROVED" | "CANCELLED" = "DRAFT";
  let activeReceipt: BriefApprovalReceipt | null = null;
  const view = () => deepFreeze({ status, revision, draft });
  const edit = (changes: Partial<DesignBrief>) => {
    if (status === "CANCELLED") throw new Error("Cancelled review requires a new session/review.");
    revision += 1; status = "DRAFT"; activeReceipt = null;
    const candidate = structuredClone(draft.candidate), fields = structuredClone(draft.fields);
    for (const [key, value] of Object.entries(changes)) {
      if (!BRIEF_FIELDS.some((field) => field === key)) throw new Error(`Unknown Brief field: ${key}`);
      const field = key as BriefField;
      candidate[field] = designBriefSchema.shape[field].parse(value);
      fields[field] = { status: "NEEDS_CONFIRMATION", sourceKind: "HUMAN_EDIT", citations: [] };
    }
    draft = finalizeBriefDraft({ sessionFingerprint: draft.sessionFingerprint, sourceId: draft.sourceId,
      sections: draft.sections, candidate, fields, parseIssues: draft.parseIssues });
    return view();
  };
  const decide = (decision: unknown, context: ReviewContext) => {
    const parsedDecision = designBriefDecisionSchema.parse(decision);
    if (status === "CANCELLED") throw new Error("Cancelled review requires a new session/review.");
    if (parsedDecision === "EDIT") { edit({}); return { ...view(), receipt: null }; }
    if (parsedDecision === "CANCEL") { revision += 1; status = "CANCELLED"; activeReceipt = null; return { ...view(), receipt: null }; }
    z.string().trim().min(1).max(200).parse(context.actor);
    sha256DigestSchema.parse(context.displayedDraftFingerprint);
    if (context.displayedDraftFingerprint !== draft.fingerprint || hashContent(context.sessionMarkdown) !== draft.sessionFingerprint) {
      throw new Error("STALE: re-display the current session and draft before confirmation.");
    }
    if (!draft.canConfirm || draft.brief === null) throw new Error("MISSING / NEEDS_CONFIRMATION: resolve draft issues before CONFIRM.");
    if (baseline !== null && bundleFreshness(baseline, context.currentBundle) !== "FRESH") throw new Error("Target evidence is STALE / UNKNOWN; rescan and create a new review.");
    const receipt: BriefApprovalReceipt = deepFreeze({
      schemaVersion: "1.0.0", status: "APPROVED", scope: "DESIGN_INTENT_ONLY",
      actor: context.actor.trim(), approvedAt: new Date().toISOString(), revision,
      draftFingerprint: draft.fingerprint, sessionFingerprint: draft.sessionFingerprint,
      briefFingerprint: createBundleContentFingerprint(draft.brief), brief: draft.brief,
      nativeSections: draft.sections, fieldProvenance: draft.fields,
      evidenceFingerprint: baseline?.contentFingerprint ?? null, targetBinding: baseline === null ? "UNBOUND" : "BOUND",
    });
    activeReceipt = receipt; status = "APPROVED";
    issued.set(receipt, { active: () => status === "APPROVED" && activeReceipt === receipt, baseline });
    return { ...view(), receipt };
  };
  return { view, edit, decide };
}
