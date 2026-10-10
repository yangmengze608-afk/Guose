import { z } from "zod";
import { recoveredDesignItemSchema } from "./recovery.js";
import { relativeFilePathSchema, sourceLocationSchema } from "./provenance.js";
import { sha256DigestSchema } from "./snapshot.js";
import { createBundleContentFingerprint } from "../utils/content-hash.js";
import type { DeepReadonly } from "./evidence-bundle.js";

export const MIGRATION_POLICY_VERSION = "css-existing-token-review-0.1.0" as const;
export const migrationDecisionSchema = z.enum(["AUTO_SAFE", "REVIEW_REQUIRED", "DO_NOT_TOUCH"]);
export const migrationItemSchema = recoveredDesignItemSchema.safeExtend({
  kind: z.enum(["RAW_LITERAL_REPLACEMENT", "TOKEN_POLICY_CHANGE", "UNCHANGED_SEMANTIC_USAGE", "UNCHANGED_VARIABLE_REFERENCE", "UNSUPPORTED_EVIDENCE", "STRUCTURAL_SEMANTIC_REVIEW"]),
  current: z.array(z.string()),
  role: z.string().min(1).nullable(),
  target: z.string().min(1).nullable(),
  targetStatus: z.enum(["TARGET_EXISTING", "TARGET_STYLE_PACK_DEFINED", "TARGET_REQUIRES_INTRODUCTION", "TARGET_UNRESOLVED"]).optional(),
  targetReason: z.string().optional(), requiresTokenIntroduction: z.boolean().optional(), targetEvidenceIds: z.array(z.string()).optional(),
  patchBlockers: z.array(z.string()).optional(),
  candidateTokens: z.array(z.string().min(1)),
  decision: migrationDecisionSchema,
  risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
  reasonCodes: z.array(z.string().min(1)).min(1),
  filesAffected: z.array(relativeFilePathSchema),
  provenance: z.array(z.object({ evidenceId: z.string().min(1), source: sourceLocationSchema }).strict()).min(1),
  blockingUnknownIds: z.array(z.string().min(1)),
}).superRefine((item, context) => {
  if (item.kind === "STRUCTURAL_SEMANTIC_REVIEW" && item.target !== null) {
    const targets: Record<string, string> = { "primary.action.background": "bg-primary", "primary.action.foreground": "text-primary-foreground", "destructive.action.background": "bg-destructive", "destructive.action.foreground": "text-destructive-foreground", "surface.card": "bg-card", "border.default": "border-border" };
    if (item.target !== targets[item.role ?? ""] || item.structuralEvidence?.role !== item.role ||
        (item.targetStatus === "TARGET_REQUIRES_INTRODUCTION") !== item.requiresTokenIntroduction) context.addIssue({ code: "custom", message: "Structural target must match the six-role policy and introduction status." });
  }
  if (item.kind === "STRUCTURAL_SEMANTIC_REVIEW" &&
      (item.status !== "INFERRED" || item.decision !== "REVIEW_REQUIRED" || item.role === null || item.targetStatus === undefined ||
       (item.targetStatus === "TARGET_UNRESOLVED") !== (item.target === null) || !item.patchBlockers?.includes("NO_APPROVED_PATCH_LANE"))) {
    context.addIssue({ code: "custom", message: "Structural targets require explicit resolution and remain inferred review-only, without an approved patch lane." });
  }
  if (item.decision === "AUTO_SAFE") context.addIssue({ code: "custom", message: "v0.1 has no explicit developer mapping; inferred mappings cannot be AUTO_SAFE." });
  if (item.status === "UNKNOWN" && item.confidence.status !== "UNRESOLVED") context.addIssue({ code: "custom", message: "Unknown plan items require unresolved confidence." });
  const refs = item.evidence.map(({ evidenceId }) => evidenceId).sort();
  const provenance = item.provenance.map(({ evidenceId }) => evidenceId).sort();
  if (JSON.stringify(refs) !== JSON.stringify(provenance) ||
      new Set(refs).size !== refs.length || new Set(item.filesAffected).size !== item.filesAffected.length) {
    context.addIssue({ code: "custom", message: "Plan provenance must match unique evidence references and affected paths." });
  }
  if ((item.decision === "REVIEW_REQUIRED" && item.risk === "LOW") ||
      (item.kind === "RAW_LITERAL_REPLACEMENT" && item.candidateTokens.length > 1 && item.target !== null)) {
    context.addIssue({ code: "custom", message: "Review mappings are not low risk and ambiguous tokens cannot select a default." });
  }
});
export const migrationPlanSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  status: z.literal("OBSERVED"),
  policyVersion: z.literal(MIGRATION_POLICY_VERSION),
  dryRunOnly: z.literal(true),
  contentFingerprint: sha256DigestSchema,
  source: z.object({
    evidenceFingerprint: sha256DigestSchema, recoveryFingerprint: sha256DigestSchema,
    workingTreeFingerprint: sha256DigestSchema,
    stylePack: z.object({ id: z.literal("neutral-modern"), version: z.string().min(1), contentFingerprint: sha256DigestSchema }).strict(),
  }).strict(),
  items: z.array(migrationItemSchema),
  summary: z.object({
    autoSafe: z.number().int().nonnegative(), reviewRequired: z.number().int().nonnegative(),
    doNotTouch: z.number().int().nonnegative(), rawLiteralReviewCandidates: z.number().int().nonnegative(),
    tokenPolicyReviewChanges: z.number().int().nonnegative(), existingSemanticUsages: z.number().int().nonnegative(),
    existingVariableReferences: z.number().int().nonnegative(),
    statement: z.string().min(1),
  }).strict(),
  limitations: z.array(z.string().min(1)).min(1),
}).strict().superRefine(({ contentFingerprint, ...plan }, context) => {
  if (contentFingerprint !== createBundleContentFingerprint(plan)) context.addIssue({ code: "custom", message: "Plan fingerprint must match payload." });
  if (new Set(plan.items.map(({ id }) => id)).size !== plan.items.length) context.addIssue({ code: "custom", message: "Plan item IDs must be unique." });
  const counts = {
    autoSafe: plan.items.filter(({ decision }) => decision === "AUTO_SAFE").length,
    reviewRequired: plan.items.filter(({ decision }) => decision === "REVIEW_REQUIRED").length,
    doNotTouch: plan.items.filter(({ decision }) => decision === "DO_NOT_TOUCH").length,
    rawLiteralReviewCandidates: plan.items.filter(({ decision, kind }) => decision === "REVIEW_REQUIRED" && kind === "RAW_LITERAL_REPLACEMENT").length,
    tokenPolicyReviewChanges: plan.items.filter(({ decision, kind }) => decision === "REVIEW_REQUIRED" && kind === "TOKEN_POLICY_CHANGE").length,
    existingSemanticUsages: plan.items.filter(({ kind }) => kind === "UNCHANGED_SEMANTIC_USAGE").length,
    existingVariableReferences: plan.items.filter(({ kind }) => kind === "UNCHANGED_VARIABLE_REFERENCE").length,
  };
  if (Object.entries(counts).some(([key, value]) => plan.summary[key as keyof typeof counts] !== value)) context.addIssue({ code: "custom", message: "Plan summary must match decisions." });
});
export type MigrationItem = z.infer<typeof migrationItemSchema>;
export type MigrationPlan = z.infer<typeof migrationPlanSchema>;
export type ReadonlyMigrationPlan = DeepReadonly<MigrationPlan>;
