import { z } from "zod";

import { relativeFilePathSchema } from "./provenance.js";

export const sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const gitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/u);

export const snapshotFileSchema = z
  .object({
    path: relativeFilePathSchema,
    digest: sha256DigestSchema,
    lineCount: z.number().int().positive(),
  })
  .strict();

export const stylePackIdentitySchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    hash: sha256DigestSchema,
  })
  .strict();

export const evidenceSnapshotSchema = z
  .object({
    gitHead: gitObjectIdSchema.nullable(),
    gitDirty: z.boolean().nullable(),
    gitStateReason: z
      .enum(["NOT_GIT_REPOSITORY", "GIT_UNAVAILABLE", "UNBORN_HEAD"])
      .nullable(),
    workingTreeFingerprint: sha256DigestSchema,
    configHash: sha256DigestSchema,
    files: z.array(snapshotFileSchema),
    stylePack: stylePackIdentitySchema.nullable(),
    guoseVersion: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine(({ files, gitDirty, gitHead, gitStateReason }, context) => {
    const paths = new Set<string>();
    for (const file of files) {
      if (paths.has(file.path)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate snapshot file path: ${file.path}`,
        });
      }
      paths.add(file.path);
    }

    const validGitTuple =
      (gitStateReason === null && gitHead !== null && gitDirty !== null) ||
      (gitStateReason === "UNBORN_HEAD" && gitHead === null && gitDirty !== null) ||
      ((gitStateReason === "NOT_GIT_REPOSITORY" ||
        gitStateReason === "GIT_UNAVAILABLE") &&
        gitHead === null &&
        gitDirty === null);
    if (!validGitTuple) {
      context.addIssue({ code: "custom", message: "Inconsistent Git snapshot state." });
    }
  });

export type EvidenceSnapshot = z.infer<typeof evidenceSnapshotSchema>;
