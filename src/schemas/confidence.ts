import { z } from "zod";

export const CONFIDENCE_MODEL_VERSION = "ordinal-static-support-0.1.0" as const;
export const confidenceRuleSchema = z.enum([
  "BASE_STATIC_SUPPORT", "CONDITIONAL_POSSIBLE_USAGE_CAP",
  "UTILITY_GENERATION_UNVERIFIED_CAP", "IMPRECISE_SOURCE_CAP",
  "SCOPED_UNRESOLVED", "TRUE_CONFLICT",
]);
const shared = {
  modelVersion: z.literal(CONFIDENCE_MODEL_VERSION),
  kind: z.literal("DETERMINISTIC_HEURISTIC"),
  claim: z.literal("STATIC_EVIDENCE_SUPPORT"),
  explanation: z.string().min(1),
};
const counts = z.object({
  supportingRecords: z.number().int().nonnegative(),
  supportingSites: z.number().int().nonnegative(),
  supportingFiles: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  relatedUnknowns: z.number().int().nonnegative(),
  sameFileUnknowns: z.number().int().nonnegative(),
}).strict();
export const assessedConfidenceSchema = z.object({
  ...shared,
  status: z.literal("ASSESSED"),
  unit: z.literal("ORDINAL_RUBRIC_POINTS"),
  score: z.number().int().min(0).max(3),
  band: z.enum(["LOW", "MEDIUM", "HIGH"]),
  metrics: counts,
  adjustments: z.array(z.object({
    ruleId: confidenceRuleSchema,
    before: z.number().int().min(0).max(3),
    after: z.number().int().min(0).max(3),
    appliedDelta: z.number().int().min(-3).max(3),
    evidenceIds: z.array(z.string().min(1)),
    explanation: z.string().min(1),
  }).strict()).min(1),
}).strict().superRefine((value, context) => {
  const band = value.score >= 3 ? "HIGH" : value.score === 2 ? "MEDIUM" : "LOW";
  if (value.band !== band || value.metrics.supportingRecords === 0) {
    context.addIssue({ code: "custom", message: "Confidence band/support must match rubric score." });
  }
  const { supportingRecords, supportingSites, supportingFiles, conflicts, relatedUnknowns, sameFileUnknowns } = value.metrics;
  if ((conflicts > 0 && value.score > 1) ||
      ((relatedUnknowns + sameFileUnknowns > 0) && value.score > 2) ||
      supportingSites < 1 || supportingFiles < 1 ||
      supportingSites > supportingRecords || supportingFiles > supportingSites) {
    context.addIssue({ code: "custom", message: "Confidence caps and source counts must obey the rubric." });
  }
  let previous = 0;
  for (const [index, entry] of value.adjustments.entries()) {
    if (entry.before !== previous || entry.appliedDelta !== entry.after - entry.before) {
      context.addIssue({ code: "custom", message: "Confidence adjustment ledger must reconcile." });
    }
    if (new Set(entry.evidenceIds).size !== entry.evidenceIds.length || entry.evidenceIds.length === 0 ||
        (index === 0 && (entry.ruleId !== "BASE_STATIC_SUPPORT" || entry.after < 1)) ||
        (index > 0 && (entry.ruleId === "BASE_STATIC_SUPPORT" || entry.appliedDelta > 0))) {
      context.addIssue({ code: "custom", message: "Rubric ledger must have one base, no invented bonuses, and unique evidence ids." });
    }
    const expectedAfter = entry.ruleId === "BASE_STATIC_SUPPORT" ? entry.after
      : entry.ruleId === "TRUE_CONFLICT" ? Math.min(1, Math.max(0, entry.before - 1))
      : entry.ruleId === "SCOPED_UNRESOLVED" ? Math.min(2, Math.max(0, entry.before - 1))
      : Math.min(entry.before, 2);
    if (entry.after !== expectedAfter) {
      context.addIssue({ code: "custom", message: "Ledger rule must apply the exact rubric transformation; only zero is the floor." });
    }
    previous = entry.after;
  }
  const conflictAdjustments = value.adjustments.filter(({ ruleId }) => ruleId === "TRUE_CONFLICT");
  const unknownAdjustments = value.adjustments.filter(({ ruleId }) => ruleId === "SCOPED_UNRESOLVED");
  if (conflictAdjustments.length !== conflicts ||
      conflictAdjustments.some(({ evidenceIds }) => evidenceIds.length !== 1) ||
      unknownAdjustments.length !== (relatedUnknowns + sameFileUnknowns > 0 ? 1 : 0) ||
      (unknownAdjustments[0]?.evidenceIds.length ?? 0) !== relatedUnknowns + sameFileUnknowns) {
    context.addIssue({ code: "custom", message: "Conflict/UNKNOWN adjustment counts must match measured ids." });
  }
  if (previous !== value.score) context.addIssue({ code: "custom", message: "Confidence ledger must end at score." });
});
export const unresolvedConfidenceSchema = z.object({
  ...shared,
  status: z.literal("UNRESOLVED"),
  score: z.null(),
  band: z.literal("UNKNOWN"),
  reasonCode: z.literal("RECOVERY_STATUS_UNKNOWN"),
  conflictingEvidenceIds: z.array(z.string().min(1)),
  relatedUnknownIds: z.array(z.string().min(1)),
}).strict();
