import { z } from "zod";
import { relativeFilePathSchema, sourceLocationSchema } from "../schemas/provenance.js";
import { sha256DigestSchema } from "../schemas/snapshot.js";
import { createBundleContentFingerprint } from "../utils/content-hash.js";
import { TRANSFORMATION_TYPES, transformationRules } from "./strategy.js";

export const planningBindingSchema = z.object({
  status: z.literal("CONFIRMED_FOR_T3_PLANNING"), targetConfirmed: z.literal(true), planningAllowed: z.literal(true),
  briefHash: sha256DigestSchema,
  repoIdentity: z.object({ root: z.string().min(1), targetPath: relativeFilePathSchema, identityHash: sha256DigestSchema }).passthrough(),
  pageTarget: z.object({ logicalTarget: z.string().min(1), entry: relativeFilePathSchema, selector: z.string().min(1) }).passthrough(),
  scope: z.object({ allowed: z.array(z.string()), preserved: z.array(z.string()), allowLayoutChange: z.literal(false), protectedPaths: z.array(relativeFilePathSchema) }).passthrough(),
  baseline: z.object({ workingTreeFingerprint: sha256DigestSchema, configHash: sha256DigestSchema, evidenceFingerprint: sha256DigestSchema }).passthrough(),
}).passthrough();
export type PlanningBinding = z.infer<typeof planningBindingSchema>;

const operationSchema = z.object({
  id: z.string().min(1), type: z.enum(TRANSFORMATION_TYPES), targetFile: relativeFilePathSchema,
  target: z.object({ identity: z.string(), role: z.string(), selector: z.string(), source: sourceLocationSchema }).strict(),
  before: z.object({ status: z.enum(["OBSERVED", "UNKNOWN"]), authoredClasses: z.array(z.string()), computedValue: z.null() }).strict(),
  after: z.object({ status: z.literal("INFERRED"), declarations: z.record(z.string(), z.string()) }).strict(),
  briefRequirement: z.array(z.string()).min(1), repoEvidence: z.array(z.string()).min(1), conflictEvidence: z.array(z.string()),
  proposal: z.object({ source: z.literal("STYLE_STRATEGY"), id: z.string(), version: z.string(), strategyHash: sha256DigestSchema, intensity: z.enum(["low", "medium", "high"]) }).strict(),
  scopeEvidence: z.object({ bindingHash: sha256DigestSchema, rootSource: sourceLocationSchema, rootSelector: z.string(), status: z.literal("INFERRED"), method: z.literal("DIGEST_BOUND_AST_REPLAY") }).strict(),
  certainty: z.enum(["STATIC_TEMPLATE_SUPPORTED", "REVIEW_REQUIRED_WITH_UNKNOWN"]), risk: z.enum(["MEDIUM", "HIGH"]),
  approvalStatus: z.literal("REVIEW_REQUIRED"), patchability: z.literal("NOT_AUTHORIZED_REQUIRES_RUNTIME_SCOPE_CHECK"),
  protectedRegionRelation: z.literal("PAGE_OVERRIDE_ONLY_SHARED_SOURCE_UNCHANGED"), unknownIds: z.array(z.string()),
}).strict();
export type TransformationOperation = z.infer<typeof operationSchema>;
export const transformationPlanSchema = z.object({
  schemaVersion: z.literal("P1_TRANSFORMATION_PLAN_1"), status: z.literal("REVIEW_REQUIRED"),
  contentFingerprint: sha256DigestSchema,
  source: z.object({ briefHash: sha256DigestSchema, bindingHash: sha256DigestSchema, evidenceFingerprint: sha256DigestSchema, recoveryFingerprint: sha256DigestSchema, workingTreeFingerprint: sha256DigestSchema, entry: relativeFilePathSchema }).strict(),
  scopeProposal: z.object({ selector: z.string(), attribute: z.literal("data-guose-page"), value: z.string(), targetSource: sourceLocationSchema, status: z.literal("REVIEW_REQUIRED"), uniqueness: z.literal("STATIC_SOURCE_CHECKED_RUNTIME_UNVERIFIED") }).strict(),
  strategy: z.object({ id: z.string(), version: z.string(), source: z.literal("STYLE_STRATEGY"), fingerprint: sha256DigestSchema }).strict(),
  operations: z.array(operationSchema),
  abstentions: z.array(z.object({ status: z.enum(["ABSTAIN", "UNRESOLVED_SCOPE", "REJECTED_PROTECTED_SCOPE"]), identity: z.string(), reason: z.string(), evidenceIds: z.array(z.string()), source: sourceLocationSchema.optional() }).strict()),
  unknownIds: z.array(z.string()), protectedPaths: z.array(relativeFilePathSchema),
  authority: z.literal("PLANNING_AUDIT_CONTENT_ONLY_NOT_EXECUTION_AUTHORITY"), executionAllowed: z.literal(false),
  limitations: z.array(z.string()).min(1),
}).strict().superRefine((plan, ctx) => {
  const { contentFingerprint, ...payload } = plan;
  if (createBundleContentFingerprint(payload) !== contentFingerprint) ctx.addIssue({ code: "custom", message: "Plan hash mismatch" });
  const ids = new Set<string>();
  if (!/^\[data-guose-page="page-[a-f0-9]{12}"\]$/u.test(plan.scopeProposal.selector) || plan.scopeProposal.selector !== `[data-guose-page="${plan.scopeProposal.value}"]`) ctx.addIssue({ code: "custom", message: "Unsupported root marker" });
  for (const op of plan.operations) {
    if (ids.has(op.id)) ctx.addIssue({ code: "custom", message: "Duplicate operation" });
    ids.add(op.id);
    if (op.targetFile !== plan.source.entry || plan.protectedPaths.includes(op.targetFile)) ctx.addIssue({ code: "custom", message: "Protected scope violation" });
    const rooted = op.target.selector === plan.scopeProposal.selector || op.target.selector.startsWith(`${plan.scopeProposal.selector} `);
    if (op.scopeEvidence.rootSelector !== plan.scopeProposal.selector || !rooted || /,|!important|:has\(|\+|~(?!=)/u.test(op.target.selector)) ctx.addIssue({ code: "custom", message: "Unbounded selector" });
    if (Object.values(op.after.declarations).some(v => /!important|[{};]|url\(|@import/u.test(v))) ctx.addIssue({ code: "custom", message: "Unsupported design value" });
    if (op.scopeEvidence.bindingHash !== plan.source.bindingHash) ctx.addIssue({ code: "custom", message: "Binding mismatch" });
    const allowed = new Set([transformationRules.find(r => r.type === op.type)!.property]);
    if (op.type === "SECTION_SPACING") { allowed.delete("padding-block"); allowed.add("padding-top"); allowed.add("padding-bottom"); }
    if (op.type === "PAGE_BACKGROUND" || op.type === "CTA_BACKGROUND") allowed.add("background-image");
    if (op.type === "BUTTON_SHADOW") for (const key of ["focus-visible:box-shadow", "focus-visible:outline", "focus-visible:outline-offset"]) allowed.add(key);
    if (Object.keys(op.after.declarations).length === 0 || Object.keys(op.after.declarations).some(key => !allowed.has(key))) ctx.addIssue({ code: "custom", message: "Unsupported property for rule" });
    if (op.proposal.strategyHash !== plan.strategy.fingerprint || op.proposal.id !== plan.strategy.id || op.proposal.version !== plan.strategy.version) ctx.addIssue({ code: "custom", message: "Strategy identity mismatch" });
  }
});
export type TransformationPlan = z.infer<typeof transformationPlanSchema>;
