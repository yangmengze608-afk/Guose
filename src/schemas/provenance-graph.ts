import { z } from "zod";

import { sourceLocationSchema } from "./provenance.js";

export const provenanceRelationshipSchema = z.enum([
  "LOCATED_AT",
  "SUPPORTS",
  "CONFLICTS",
  "RELATED_TO",
  "CONTEXTUALIZES",
]);

export const provenanceSourceNodeSchema = z
  .object({
    id: z.string().regex(/^source:sha256:[0-9a-f]{64}$/u),
    location: sourceLocationSchema,
  })
  .strict();

export const provenanceEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    relationship: provenanceRelationshipSchema,
  })
  .strict();

export const provenanceGraphSchema = z
  .object({
    sources: z.array(provenanceSourceNodeSchema),
    edges: z.array(provenanceEdgeSchema),
  })
  .strict();

export type ProvenanceRelationship = z.infer<
  typeof provenanceRelationshipSchema
>;
export type ProvenanceSourceNode = z.infer<typeof provenanceSourceNodeSchema>;
export type ProvenanceEdge = z.infer<typeof provenanceEdgeSchema>;
export type ProvenanceGraph = z.infer<typeof provenanceGraphSchema>;
