import { z } from "zod";

import { epistemicStatusSchema } from "./epistemic.js";
import {
  evidenceReferenceSchema,
  sourceLocationSchema,
} from "./provenance.js";
import { evidenceSnapshotSchema, sha256DigestSchema } from "./snapshot.js";
import { createBundleContentFingerprint } from "../utils/content-hash.js";
import { createProvenanceGraph } from "../provenance/graph.js";
import { provenanceGraphSchema } from "./provenance-graph.js";

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = "1.0.0" as const;

export const observedEvidenceSchema = z
  .object({
    id: z.string().min(1),
    status: z.literal(epistemicStatusSchema.enum.OBSERVED),
    kind: z.string().min(1),
    value: z.unknown(),
    source: sourceLocationSchema,
    contextEvidenceIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export const inferenceSchema = z
  .object({
    id: z.string().min(1),
    status: z.literal(epistemicStatusSchema.enum.INFERRED),
    kind: z.string().min(1),
    value: z.unknown(),
    rationale: z.string().min(1),
    evidence: z.array(evidenceReferenceSchema).min(1),
  })
  .strict()
  .refine(
    ({ evidence }) =>
      evidence.some(({ relationship }) => relationship === "SUPPORTS"),
    { message: "An inference must cite at least one supporting observation." },
  );

export const unknownSchema = z
  .object({
    id: z.string().min(1),
    status: z.literal(epistemicStatusSchema.enum.UNKNOWN),
    kind: z.string().min(1),
    reasonCode: z.enum([
      "ABSENT",
      "PARSE_FAILED",
      "INVALID_FORMAT",
      "INSUFFICIENT_EVIDENCE",
      "UNSUPPORTED",
    ]),
    reason: z.string().min(1),
    relatedEvidenceIds: z.array(z.string().min(1)).default([]),
    source: sourceLocationSchema.optional(),
    scope: z.string().min(1).optional(),
  })
  .strict()
  .superRefine(({ reasonCode, relatedEvidenceIds, source, scope }, context) => {
    if (source === undefined && scope === undefined && relatedEvidenceIds.length === 0) {
      context.addIssue({
        code: "custom",
        message: "UNKNOWN requires source, scope, or related evidence.",
      });
    }
    if (
      (reasonCode === "PARSE_FAILED" || reasonCode === "INVALID_FORMAT") &&
      source === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: `${reasonCode} requires source provenance.`,
        path: ["source"],
      });
    }
    if (
      (reasonCode === "ABSENT" || reasonCode === "INSUFFICIENT_EVIDENCE") &&
      scope === undefined &&
      relatedEvidenceIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: `${reasonCode} requires a scan scope or related evidence.`,
      });
    }
  });

export const repositoryProfileSchema = z
  .object({
    root: z.literal("."),
    frameworks: z.array(z.string().min(1)),
    stylingSystems: z.array(z.string().min(1)),
    supportStatus: z.enum(["SUPPORTED", "PARTIAL", "UNSUPPORTED"]),
  })
  .strict();

export const evidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_BUNDLE_SCHEMA_VERSION),
    contentFingerprint: sha256DigestSchema,
    snapshot: evidenceSnapshotSchema,
    repository: repositoryProfileSchema,
    observations: z.array(observedEvidenceSchema),
    inferences: z.array(inferenceSchema),
    unknowns: z.array(unknownSchema),
    provenance: provenanceGraphSchema,
  })
  .strict()
  .superRefine((bundle, context) => {
    const { contentFingerprint, ...payload } = bundle;
    const expectedFingerprint = createBundleContentFingerprint({
      ...payload,
      snapshot: { ...payload.snapshot, createdAt: "" },
    });
    if (contentFingerprint !== expectedFingerprint) {
      context.addIssue({
        code: "custom",
        message: "contentFingerprint does not match the canonical bundle payload.",
      });
    }

    const records = [
      ...bundle.observations,
      ...bundle.inferences,
      ...bundle.unknowns,
    ];

    const expectedProvenance = createProvenanceGraph(bundle);
    if (JSON.stringify(bundle.provenance) !== JSON.stringify(expectedProvenance)) {
      context.addIssue({
        code: "custom",
        message: "provenance must be the canonical graph derived from evidence records.",
        path: ["provenance"],
      });
    }
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate evidence id: ${record.id}`,
        });
      }
      ids.add(record.id);
    }
    for (const source of bundle.provenance.sources) {
      if (ids.has(source.id)) {
        context.addIssue({
          code: "custom",
          message: `Evidence id collides with provenance source id: ${source.id}`,
        });
      }
    }

    const observationIds = new Set(bundle.observations.map(({ id }) => id));
    for (const observation of bundle.observations) {
      const contextIds = observation.contextEvidenceIds ?? [];
      if (new Set(contextIds).size !== contextIds.length) {
        context.addIssue({
          code: "custom",
          message: `Observation ${observation.id} repeats a context reference.`,
        });
      }
      for (const contextId of contextIds) {
        if (!observationIds.has(contextId) || contextId === observation.id) {
          context.addIssue({
            code: "custom",
            message: `Observation ${observation.id} has invalid context evidence ${contextId}.`,
          });
        }
      }
    }
    for (const inference of bundle.inferences) {
      const relationships = new Map<string, string>();
      for (const reference of inference.evidence) {
        if (!observationIds.has(reference.evidenceId)) {
          context.addIssue({
            code: "custom",
            message: `Inference ${inference.id} references missing observation ${reference.evidenceId}.`,
          });
        }
        const prior = relationships.get(reference.evidenceId);
        if (prior !== undefined) {
          context.addIssue({
            code: "custom",
            message: `Inference ${inference.id} repeats or contradicts ${reference.evidenceId}.`,
          });
        }
        relationships.set(reference.evidenceId, reference.relationship);
      }
    }

    for (const unknown of bundle.unknowns) {
      if (new Set(unknown.relatedEvidenceIds).size !== unknown.relatedEvidenceIds.length) {
        context.addIssue({
          code: "custom",
          message: `Unknown ${unknown.id} repeats related evidence.`,
        });
      }
      if (
        unknown.source === undefined &&
        unknown.scope === undefined &&
        unknown.relatedEvidenceIds.length === 0
      ) {
        context.addIssue({
          code: "custom",
          message: `Unknown ${unknown.id} lacks traceable context.`,
        });
      }
      for (const relatedId of unknown.relatedEvidenceIds) {
        if (!ids.has(relatedId) || relatedId === unknown.id) {
          context.addIssue({
            code: "custom",
            message: `Unknown ${unknown.id} has invalid related evidence ${relatedId}.`,
          });
        }
      }
    }

    const files = new Map(
      bundle.snapshot.files.map((file) => [file.path, file] as const),
    );
    for (const record of records) {
      if (!("source" in record) || record.source === undefined) continue;
      const file = files.get(record.source.file);
      if (file === undefined) {
        context.addIssue({
          code: "custom",
          message: `Source file is absent from snapshot: ${record.source.file}`,
        });
      } else if (
        record.source.type === "SPAN" &&
        (record.source.startLine > file.lineCount ||
          record.source.endLine > file.lineCount)
      ) {
        context.addIssue({
          code: "custom",
          message: `Source span exceeds snapshot line count: ${record.source.file}`,
        });
      }
    }
  });

export type ObservedEvidence = z.infer<typeof observedEvidenceSchema>;
export type Inference = z.infer<typeof inferenceSchema>;
export type UnknownFinding = z.infer<typeof unknownSchema>;
export type RepositoryProfile = z.infer<typeof repositoryProfileSchema>;
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ReadonlyEvidenceBundle = DeepReadonly<EvidenceBundle>;
