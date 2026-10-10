import { z } from "zod";

export const relativeFilePathSchema = z.string().min(1).max(4096).refine(
  (value) =>
    value.length <= 4096 && !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("%") &&
    !/^[a-zA-Z]:/u.test(value) &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    }) &&
    !value.split("/").some((segment) => !segment || segment === ".." || segment === "."),
  { message: "Source paths must be safe, repository-relative paths." },
);

export const sourceSpanSchema = z
  .object({
    type: z.literal("SPAN"),
    file: relativeFilePathSchema,
    startLine: z.number().int().positive(),
    startColumn: z.number().int().nonnegative(),
    endLine: z.number().int().positive(),
    endColumn: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    ({ startLine, startColumn, endLine, endColumn }) =>
      endLine > startLine ||
      (endLine === startLine && endColumn >= startColumn),
    { message: "Source span must end at or after its start." },
  );

export const fileSourceSchema = z
  .object({
    type: z.literal("FILE"),
    file: relativeFilePathSchema,
  })
  .strict();

export const sourceLocationSchema = z.discriminatedUnion("type", [
  sourceSpanSchema,
  fileSourceSchema,
]);

export const evidenceReferenceSchema = z
  .object({
    evidenceId: z.string().min(1),
    relationship: z.enum(["SUPPORTS", "CONFLICTS"]),
  })
  .strict();

export type SourceSpan = z.infer<typeof sourceSpanSchema>;
export type SourceLocation = z.infer<typeof sourceLocationSchema>;
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
