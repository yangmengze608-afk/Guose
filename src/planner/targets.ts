import type { ReadonlyEvidenceBundle, ReadonlyStylePack } from "../schemas/index.js";
import { isStaticColorSyntax } from "../extraction/color-syntax.js";
import { obviousNonProductionPath } from "../utils/non-production-path.js";
const object = (x: unknown): Record<string, unknown> => typeof x === "object" && x !== null ? x as Record<string, unknown> : {};
export function resolveRoleTarget(role: string, property: string, pack: ReadonlyStylePack, bundle?: ReadonlyEvidenceBundle) {
  const target = Object.entries(pack.roleTargets).find(([key]) => key === role)?.[1];
  if (!target || target.property !== property) return { target: null, targetStatus: "TARGET_UNRESOLVED" as const, targetReason: "ROLE_OR_PROPERTY_NOT_DECLARED", requiresTokenIntroduction: false, targetEvidenceIds: [] as string[] };
  if (!bundle) return { target: target.utility, targetStatus: "TARGET_STYLE_PACK_DEFINED" as const, targetReason: "AUTHORED_POLICY_ONLY_REPOSITORY_NOT_ASSESSED", requiresTokenIntroduction: false, targetEvidenceIds: [] as string[] };
  // Utility spelling alone is not proof of a token definition or generated CSS.
  const definitions = bundle.observations.filter(x => !obviousNonProductionPath(x.source.file) && x.kind === "design_token_declaration" && object(x.value).name === `--color-${target.token}`);
  const existing = definitions.length > 0 && new Set(definitions.map(x => object(x.value).normalizedValue)).size === 1 && definitions.every(x => {
    const data = object(x.value), context = object(data.context);
    return context.atRule === "theme" && Array.isArray(context.conditionalAtRules) && context.conditionalAtRules.length === 0 && typeof data.normalizedValue === "string" && isStaticColorSyntax(data.normalizedValue);
  });
  const possibleExisting = bundle.observations.filter(x => !obviousNonProductionPath(x.source.file) && x.kind === "design_token_declaration" &&
    [`--color-${target.token}`, `--${target.token}`, target.token].includes(String(object(x.value).name)));
  if (!existing && possibleExisting.length) return { target: target.utility, targetStatus: "TARGET_STYLE_PACK_DEFINED" as const,
    targetReason: "EXISTING_BINDINGS_OBSERVED_BUT_VALUE_SCOPE_OR_UTILITY_RESOLUTION_UNVERIFIED", requiresTokenIntroduction: false, targetEvidenceIds: possibleExisting.map(x => x.id).sort() };
  return { target: target.utility, targetStatus: existing ? "TARGET_EXISTING" as const : "TARGET_REQUIRES_INTRODUCTION" as const,
    targetReason: existing ? "OBSERVED_TAILWIND_THEME_TOKEN_NOT_RUNTIME_CSS_PROOF" : "REQUIRES_TOKEN_INTRODUCTION_NOT_OBSERVED_IN_ANALYZED_SCOPE",
    requiresTokenIntroduction: !existing, targetEvidenceIds: existing ? definitions.map(x => x.id).sort() : [] };
}
