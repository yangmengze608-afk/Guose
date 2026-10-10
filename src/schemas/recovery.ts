import { z } from "zod";

import { createBundleContentFingerprint } from "../utils/content-hash.js";
import type { DeepReadonly } from "./evidence-bundle.js";
import { epistemicStatusSchema } from "./epistemic.js";
import { evidenceReferenceSchema } from "./provenance.js";
import { sha256DigestSchema } from "./snapshot.js";
import { assessedConfidenceSchema, unresolvedConfidenceSchema } from "./confidence.js";

export const CURRENT_DESIGN_SYSTEM_SCHEMA_VERSION = "1.0.0" as const;

export const recoveryCategorySchema = z.enum([
  "colors",
  "typography",
  "spacing",
  "radius",
  "shadow",
  "semanticTokens",
  "components",
]);

export const unscoredConfidenceSchema = z
  .object({
    status: z.literal("UNSCORED"),
    reasonCode: z.literal("PENDING_CONFIDENCE_MODEL"),
    explanation: z.string().min(1),
  })
  .strict();

export const recoveredDesignItemSchema = z
  .object({
    id: z.string().min(1),
    status: epistemicStatusSchema,
    category: recoveryCategorySchema,
    key: z.string().min(1),
    values: z.array(z.string()),
    evidenceCount: z.number().int().positive(),
    components: z.array(z.string().min(1)),
    structuralEvidence: z.object({
      component: z.enum(["Button", "Card"]),
      variantName: z.string(), variantValue: z.string(), defaultVariant: z.string().nullable(),
      property: z.enum(["background", "foreground", "border"]), rawClass: z.string(),
      role: z.enum(["primary.action.background", "primary.action.foreground", "destructive.action.background", "destructive.action.foreground", "surface.card", "border.default"]),
      conflictKinds: z.array(z.enum(["TRUE_SEMANTIC_CONFLICT", "SHARED_IMPLEMENTATION_VALUE", "EXISTING_SEMANTIC_TOKEN_ALIAS", "COMPONENT_CONTEXT_COLLISION", "APPLICATION_CONFLICT"])),
      source: z.enum(["cva.variant", "static.component"]),
    }).strict().optional(),
    applicationEvidence: z.object({
      strength: z.enum(["DECLARATION_ONLY", "APPLICATION_SUPPORTED", "CROSS_CONTEXT_SUPPORTED"]),
      classes: z.array(z.enum(["DECLARATION_EVIDENCE", "APPLICATION_EVIDENCE", "CROSS_CONTEXT_EVIDENCE"])),
      usageIds: z.array(z.string()), conflictUsageIds: z.array(z.string()),
      negativeSignals: z.array(z.enum(["UNUSED_VARIANT", "APPLICATION_CONFLICT"])),
      coverageStatement: z.string(),
    }).strict().optional(),
    evidence: z.array(evidenceReferenceSchema).min(1),
    rationale: z.string().min(1),
    confidence: z.union([unscoredConfidenceSchema, assessedConfidenceSchema, unresolvedConfidenceSchema]),
  })
  .strict()
  .superRefine(({ status, values, evidence, evidenceCount, confidence, structuralEvidence, applicationEvidence, category, components }, context) => {
    if (applicationEvidence !== undefined) {
      const positive = evidence.filter(x => x.relationship === "SUPPORTS").map(x => x.evidenceId), negative = evidence.filter(x => x.relationship === "CONFLICTS").map(x => x.evidenceId);
      if (!structuralEvidence || applicationEvidence.usageIds.some(id => !positive.includes(id)) || applicationEvidence.conflictUsageIds.some(id => !negative.includes(id)) ||
          (applicationEvidence.strength === "DECLARATION_ONLY") !== (applicationEvidence.usageIds.length === 0) ||
          (applicationEvidence.strength === "DECLARATION_ONLY" && confidence.status === "ASSESSED" && confidence.score > 1)) context.addIssue({ code: "custom", message: "Application evidence must reconcile with provenance and declaration-only LOW cap." });
    }
    if (structuralEvidence !== undefined && (category !== "semanticTokens" ||
        !values.includes(structuralEvidence.rawClass) || !components.includes(structuralEvidence.component) ||
        (structuralEvidence.conflictKinds.some(x => x === "TRUE_SEMANTIC_CONFLICT" || x === "APPLICATION_CONFLICT") && status !== "UNKNOWN"))) {
      context.addIssue({ code: "custom", message: "Structural mappings require matching semantic evidence; true conflicts cannot be accepted." });
    }
    if (evidenceCount !== evidence.length) context.addIssue({ code: "custom", message: "evidenceCount must match unique evidence references." });
    if ((status === "UNKNOWN" && confidence.status === "ASSESSED") ||
        (status !== "UNKNOWN" && confidence.status === "UNRESOLVED")) {
      context.addIssue({ code: "custom", message: "UNKNOWN recovery and unresolved confidence must agree." });
    }
    if (confidence.status === "ASSESSED") {
      const supports = evidence.filter(({ relationship }) => relationship === "SUPPORTS").map(({ evidenceId }) => evidenceId).sort();
      const conflicts = evidence.filter(({ relationship }) => relationship === "CONFLICTS").map(({ evidenceId }) => evidenceId).sort();
      const baseIds = [...(confidence.adjustments[0]?.evidenceIds ?? [])].sort();
      const conflictIds = confidence.adjustments.filter(({ ruleId }) => ruleId === "TRUE_CONFLICT").flatMap(({ evidenceIds }) => evidenceIds).sort();
      if (confidence.metrics.supportingRecords !== supports.length ||
          confidence.metrics.conflicts !== conflicts.length ||
          (status === "INFERRED" && confidence.score > 2) ||
          JSON.stringify(baseIds) !== JSON.stringify(supports) ||
          JSON.stringify(conflictIds) !== JSON.stringify(conflicts)) {
        context.addIssue({ code: "custom", message: "Assessed counts, inference cap and ledger references must match item evidence." });
      }
    }
    if (confidence.status === "UNRESOLVED") {
      const conflicts = evidence.filter(({ relationship }) => relationship === "CONFLICTS").map(({ evidenceId }) => evidenceId).sort();
      if (JSON.stringify([...confidence.conflictingEvidenceIds].sort()) !== JSON.stringify(conflicts)) {
        context.addIssue({ code: "custom", message: "Unresolved confidence must retain exact conflict ids." });
      }
    }
    if (
      (status === "OBSERVED" || status === "INFERRED") &&
      values.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: `${status} recovery items require at least one value.`,
        path: ["values"],
      });
    }
    if (
      status === "INFERRED" &&
      !evidence.some(({ relationship }) => relationship === "SUPPORTS")
    ) {
      context.addIssue({
        code: "custom",
        message: "INFERRED recovery items require supporting evidence.",
        path: ["evidence"],
      });
    }
  });

const recoverySectionsSchema = z
  .object({
    colors: z.array(recoveredDesignItemSchema),
    typography: z.array(recoveredDesignItemSchema),
    spacing: z.array(recoveredDesignItemSchema),
    radius: z.array(recoveredDesignItemSchema),
    shadow: z.array(recoveredDesignItemSchema),
    semanticTokens: z.array(recoveredDesignItemSchema),
    components: z.array(recoveredDesignItemSchema),
  })
  .strict();

export const currentDesignSystemSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_DESIGN_SYSTEM_SCHEMA_VERSION),
    contentFingerprint: sha256DigestSchema,
    source: z
      .object({
        evidenceFingerprint: sha256DigestSchema,
        workingTreeFingerprint: sha256DigestSchema,
      })
      .strict(),
    sections: recoverySectionsSchema,
    unresolvedEvidenceIds: z.array(z.string().min(1)),
    coverage: z
      .object({
        includedEvidenceIds: z.array(z.string().min(1)),
        excludedEvidence: z.array(
          z
            .object({
              evidenceId: z.string().min(1),
              reasonCode: z.enum([
                "NON_PRODUCTION_TEST",
                "NON_PRODUCTION_STORY",
                "GENERATED_SOURCE",
                "VENDORED_SOURCE",
              ]),
            })
            .strict(),
        ),
        limitations: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict()
  .superRefine((system, context) => {
    const { contentFingerprint, ...payload } = system;
    const expected = createRecoveryContentFingerprint(payload);
    if (contentFingerprint !== expected) {
      context.addIssue({
        code: "custom",
        message: "contentFingerprint does not match the recovered system payload.",
      });
    }

    const ids = Object.values(system.sections)
      .flat()
      .map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Recovery item ids must be unique." });
    }
    if (
      new Set(system.unresolvedEvidenceIds).size !==
      system.unresolvedEvidenceIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Unresolved evidence ids must be unique.",
      });
    }
    if (
      new Set(system.coverage.includedEvidenceIds).size !==
      system.coverage.includedEvidenceIds.length
    ) {
      context.addIssue({ code: "custom", message: "Included evidence ids must be unique." });
    }
    const excludedIds = system.coverage.excludedEvidence.map(
      ({ evidenceId }) => evidenceId,
    );
    if (new Set(excludedIds).size !== excludedIds.length) {
      context.addIssue({ code: "custom", message: "Excluded evidence ids must be unique." });
    }
    const includedIds = new Set(system.coverage.includedEvidenceIds);
    if (excludedIds.some((id) => includedIds.has(id))) {
      context.addIssue({
        code: "custom",
        message: "Evidence cannot be both included and excluded from recovery.",
      });
    }
    for (const [category, items] of Object.entries(system.sections)) {
      for (const item of items) {
        if (item.category !== category) {
          context.addIssue({
            code: "custom",
            message: `Recovery item ${item.id} is stored in the wrong section.`,
          });
        }
        const references = new Set<string>();
        for (const reference of item.evidence) {
          if (references.has(reference.evidenceId)) {
            context.addIssue({
              code: "custom",
              message: `Recovery item ${item.id} repeats or contradicts evidence ${reference.evidenceId}.`,
            });
          }
          references.add(reference.evidenceId);
        }
      }
    }
  });

export function createRecoveryContentFingerprint(payload: unknown): string {
  return createBundleContentFingerprint(payload);
}

export type RecoveryCategory = z.infer<typeof recoveryCategorySchema>;
export type RecoveredDesignItem = z.infer<typeof recoveredDesignItemSchema>;
export type CurrentDesignSystem = z.infer<typeof currentDesignSystemSchema>;
export type ReadonlyCurrentDesignSystem = DeepReadonly<CurrentDesignSystem>;
