import { z } from "zod";
import { isStaticColorSyntax } from "../extraction/color-syntax.js";
import { createBundleContentFingerprint } from "../utils/content-hash.js";
import { sha256DigestSchema } from "./snapshot.js";
import type { DeepReadonly } from "./evidence-bundle.js";

export const STYLE_PACK_SCHEMA_VERSION = "1.0.0" as const;
export const stylePackDefinitionSchema = z.object({
  schemaVersion: z.literal(STYLE_PACK_SCHEMA_VERSION),
  status: z.literal("OBSERVED"),
  sourceKind: z.literal("AUTHORED_TARGET_POLICY"),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  name: z.string().min(1),
  description: z.string().min(1),
  license: z.literal("MIT"),
  semanticTokens: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/u), z.string().refine(isStaticColorSyntax, "Bundled target colors require bounded static color syntax.")).refine((tokens) => Object.keys(tokens).length > 0),
  roleTargets: z.record(z.enum(["primary.action.background", "primary.action.foreground", "destructive.action.background", "destructive.action.foreground", "surface.card", "border.default"]), z.object({
    utility: z.string(), token: z.string().regex(/^[a-z][a-z0-9-]*$/u), property: z.enum(["background", "foreground", "border"]),
    value: z.string().refine(isStaticColorSyntax),
  }).strict().refine(x => x.utility === `${x.property === "background" ? "bg" : x.property === "foreground" ? "text" : "border"}-${x.token}`, "Target utility must match its property and token.")),
  typographyPolicy: z.object({
    fontFamily: z.string().min(1), baseFontSize: z.string().min(1),
    regularWeight: z.number().int().min(1).max(1000), strongWeight: z.number().int().min(1).max(1000),
  }).strict(),
  radiusPolicy: z.object({ base: z.string().min(1) }).strict(),
  shadowPolicy: z.object({ base: z.string().min(1) }).strict(),
  spacingPolicy: z.object({ baseUnit: z.string().min(1) }).strict().optional(),
}).strict();
export const stylePackSchema = stylePackDefinitionSchema.extend({ contentFingerprint: sha256DigestSchema })
  .superRefine(({ contentFingerprint, ...definition }, context) => {
    if (contentFingerprint !== createBundleContentFingerprint(definition)) context.addIssue({ code: "custom", message: "Style pack fingerprint must match target policy." });
  });
export type StylePack = z.infer<typeof stylePackSchema>;
export type ReadonlyStylePack = DeepReadonly<StylePack>;
