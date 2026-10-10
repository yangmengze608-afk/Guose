import { z } from "zod";
import { createBundleContentFingerprint } from "../utils/content-hash.js";
import { sha256DigestSchema, gitObjectIdSchema } from "./snapshot.js";

export const verificationStatusSchema = z.enum(["STATICALLY_VERIFIED", "PARTIALLY_VERIFIED", "UNVERIFIED", "FAILED", "RUNTIME_VERIFIED"]);
export const verificationCheckSchema = z.object({ id: z.string().min(1), status: z.enum(["PASS", "FAIL", "UNVERIFIED"]), reason: z.string().min(1) }).strict();
export const coreVerificationChecks = ["baseline", "planned-vs-actual", "exact-apply-and-reverse", "syntax-and-change-boundary", "target-and-provenance", "post-verification-freshness"] as const;
export const verificationContrastPairs = ["foreground/background", "primary-foreground/primary", "secondary-foreground/secondary", "destructive-foreground/destructive"] as const;
export function deriveStaticVerificationStatus(value: { checks: readonly { id: string; status: string }[]; freshness: string; plannedOperationIds: readonly string[]; verifiedOperations: readonly string[]; failedOperations: readonly string[]; isolation: { copiedFiles: number; cleanup: string } }) {
  return value.checks.some(({ status }) => status === "FAIL") ? "FAILED" : value.freshness !== "FRESH" || value.plannedOperationIds.length === 0 ? "UNVERIFIED"
    : !coreVerificationChecks.every((id) => value.checks.some((check) => check.id === id && check.status === "PASS")) ||
      !["static-coverage", ...verificationContrastPairs.map((pair) => `contrast:${pair}`)].every((id) => value.checks.some((check) => check.id === id)) ||
      value.failedOperations.length > 0 || value.verifiedOperations.length !== value.plannedOperationIds.length ||
      !value.plannedOperationIds.every((id) => value.verifiedOperations.includes(id)) || value.isolation.copiedFiles === 0 ||
      value.isolation.cleanup === "NOT_CREATED" || (value.isolation.cleanup === "RETAINED_FOR_SAFETY" &&
        !value.checks.some(({ id, status }) => id === "cleanup" && status === "UNVERIFIED")) ? "UNVERIFIED"
    : value.checks.some(({ status }) => status === "UNVERIFIED") ? "PARTIALLY_VERIFIED" : "STATICALLY_VERIFIED";
}
export const verificationResultSchema = z.object({
  schemaVersion: z.literal("1.0.0"), status: z.literal("OBSERVED"), backend: z.literal("StaticVerificationBackend"),
  result: verificationStatusSchema, freshness: z.enum(["FRESH", "STALE", "UNKNOWN"]),
  contentFingerprint: sha256DigestSchema, timestamp: z.string().datetime(),
  baseline: z.object({ gitHead: gitObjectIdSchema.nullable(), workingTreeFingerprint: sha256DigestSchema,
    evidenceFingerprint: sha256DigestSchema, configHash: sha256DigestSchema, guoseVersion: z.string(),
    planHash: sha256DigestSchema, patchHash: sha256DigestSchema,
    stylePack: z.object({ id: z.literal("neutral-modern"), version: z.string(), contentFingerprint: sha256DigestSchema }).strict(),
  }).strict(),
  checks: z.array(verificationCheckSchema),
  plannedOperationIds: z.array(z.string()), verifiedOperations: z.array(z.string()), failedOperations: z.array(z.string()),
  unverifiedChecks: z.array(z.string()),
  runtime: z.array(z.object({ name: z.enum(["test", "typecheck", "lint", "build"]),
    discovery: z.enum(["DISCOVERED", "ABSENT", "UNKNOWN"]), command: z.string().nullable(), status: z.literal("UNVERIFIED"), reason: z.string() }).strict()).length(4),
  executionCount: z.literal(0),
  isolation: z.object({ copiedFiles: z.number().int().nonnegative(), excludedFiles: z.array(z.string()),
    scope: z.literal("ANALYSIS_FILES_ONLY"), cleanup: z.enum(["REMOVED", "NOT_CREATED", "RETAINED_FOR_SAFETY"]) }).strict(),
  contrast: z.array(z.object({ pair: z.string(), status: z.enum(["PASS", "FAIL", "UNVERIFIED"]),
    beforeRatio: z.number().nullable(), afterRatio: z.number().nullable(), reason: z.string() }).strict()),
  limitations: z.array(z.string()).min(1),
}).strict().superRefine(({ contentFingerprint, ...value }, context) => {
  if (contentFingerprint !== createBundleContentFingerprint(value)) context.addIssue({ code: "custom", message: "Verification fingerprint mismatch." });
  if (value.result === "RUNTIME_VERIFIED") context.addIssue({ code: "custom", message: "v0.1 never returns runtime verification." });
  if (value.result !== deriveStaticVerificationStatus(value) || JSON.stringify(value.runtime.map(({ name }) => name)) !== JSON.stringify(["test", "typecheck", "lint", "build"])) context.addIssue({ code: "custom", message: "Result and runtime ledger must match deterministic static policy." });
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (![value.plannedOperationIds, value.verifiedOperations, value.failedOperations, value.checks.map(({ id }) => id)].every(unique) ||
      value.verifiedOperations.some((id) => !value.plannedOperationIds.includes(id) || value.failedOperations.includes(id)) ||
      value.failedOperations.some((id) => !value.plannedOperationIds.includes(id))) context.addIssue({ code: "custom", message: "Operation ledgers must be unique and bound to planned operations." });
  if (JSON.stringify(value.unverifiedChecks) !== JSON.stringify([...value.checks.filter(({ status }) => status === "UNVERIFIED").map(({ id }) => id), ...value.runtime.map(({ name }) => `runtime:${name}`)])) context.addIssue({ code: "custom", message: "Unverified checks must reconcile." });
  if (value.result === "STATICALLY_VERIFIED" && (value.freshness !== "FRESH" || value.checks.some(({ status }) => status !== "PASS") || value.verifiedOperations.length !== value.plannedOperationIds.length)) context.addIssue({ code: "custom", message: "Static success requires complete static checks, not runtime evidence." });
  const positive = value.result === "STATICALLY_VERIFIED" || value.result === "PARTIALLY_VERIFIED";
  if ((positive && (value.contrast.length !== verificationContrastPairs.length || !verificationContrastPairs.every((pair) => value.contrast.some((row) => row.pair === pair)))) ||
      !unique(value.contrast.map(({ pair }) => pair)) || value.contrast.some((row) => {
        const check = value.checks.find(({ id }) => id === `contrast:${row.pair}`);
        const status = row.afterRatio === null ? "UNVERIFIED" : row.afterRatio < 4.5 ? "FAIL" : "PASS";
        return !verificationContrastPairs.some((pair) => pair === row.pair) || !check || check.status !== row.status || check.reason !== row.reason || row.status !== status;
      }) || value.checks.some(({ id }) => id.startsWith("contrast:") && !value.contrast.some(({ pair }) => id === `contrast:${pair}`))) {
    context.addIssue({ code: "custom", message: "Contrast domains, rows, checks and threshold decisions must reconcile." });
  }
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;
