import { assessRecoveredSystem } from "../confidence/index.js";
import { recoverDesignSystem } from "../recovery/index.js";
import {
  MIGRATION_POLICY_VERSION, createRecoveryContentFingerprint, migrationPlanSchema,
  stylePackSchema, type MigrationItem, type ReadonlyEvidenceBundle, type ReadonlyMigrationPlan,
  type ReadonlyStylePack, type ReadonlyCurrentDesignSystem, type RecoveredDesignItem,
} from "../schemas/index.js";
import { createBundleContentFingerprint, hashContent } from "../utils/content-hash.js";
import { deepFreeze } from "../utils/deep-freeze.js";
import { isStaticColorSyntax } from "../extraction/color-syntax.js";
import { resolveRoleTarget } from "./targets.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const SUPPORTED_PROPERTIES = new Set(["color", "background-color", "border-color"]);
const unscored = { status: "UNSCORED", reasonCode: "PENDING_CONFIDENCE_MODEL", explanation: "Planning claim awaiting deterministic assessment." } as const;

export function planMigration(bundle: ReadonlyEvidenceBundle, pack: ReadonlyStylePack): ReadonlyMigrationPlan {
  stylePackSchema.parse(pack);
  if (pack.id !== "neutral-modern") throw new Error("v0.1 supports only neutral-modern.");
  const recovered = recoverDesignSystem(bundle);
  const excluded = new Set(recovered.coverage.excludedEvidence.map(({ evidenceId }) => evidenceId));
  const observations = new Map(bundle.observations.map((evidence) => [evidence.id, evidence]));
  const items: MigrationItem[] = [];
  const semanticRoles = new Set([...Object.keys(pack.semanticTokens), ...Object.values(pack.roleTargets).map(x => x.token), ...recovered.sections.semanticTokens
    .filter(({ status, key }) => status === "INFERRED" && key.startsWith("role:"))
    .map(({ key }) => key.slice(5))]);
  function roleFor(name: string): string | null {
    const role = name.replace(/^--(?:color-)?/u, "");
    return semanticRoles.has(role) ? role : null;
  }
  const declarations = bundle.observations.filter(({ id, kind, value }) =>
    !excluded.has(id) && kind === "design_token_declaration" && record(value).tokenType === "css_custom_property",
  );
  const declarationsByName = new Map<string, typeof declarations>();
  for (const evidence of declarations) {
    const name = string(record(evidence.value).name);
    if (name !== null) declarationsByName.set(name, [...(declarationsByName.get(name) ?? []), evidence]);
  }
  const productionUnknowns = bundle.unknowns.filter(({ id }) => !excluded.has(id));
  const globalCssParseUnknowns = productionUnknowns.filter(({ kind }) => kind === "css_parse" || kind === "css_dependency" || kind === "security_exclusion");

  function eligibleToken(name: string): boolean {
    const definitions = declarationsByName.get(name) ?? [];
    const values = new Set(definitions.map(({ value }) => string(record(value).normalizedValue)));
    return definitions.length > 0 && values.size === 1 && definitions.every(({ value }) => {
      const data = record(value), context = record(data.context);
      return isStaticColorSyntax(string(data.normalizedValue) ?? "") &&
        Array.isArray(context.conditionalAtRules) && context.conditionalAtRules.length === 0 &&
        (context.atRule === "theme" || string(context.selector)?.split(",").some((selector) => selector.trim() === ":root") === true);
    });
  }
  function add(input: {
    kind: MigrationItem["kind"]; status: MigrationItem["status"]; current: string[];
    role: string | null; target: string | null; candidates?: string[];
    decision: MigrationItem["decision"]; risk: MigrationItem["risk"];
    reasonCodes: string[]; rationale: string; ids: string[]; files: string[]; unknowns?: string[];
    mapping?: ReadonlyCurrentDesignSystem["sections"]["semanticTokens"][number]; resolution?: ReturnType<typeof resolveRoleTarget>;
  }): void {
    const ids = sorted(input.ids);
    const id = `plan:${hashContent(JSON.stringify([input.kind, ids, input.role])).slice(7)}`;
    items.push({
      id, status: input.status, category: "semanticTokens", key: id,
      values: sorted([...input.current, ...(input.target === null ? [] : [input.target])]),
      evidenceCount: ids.length, components: [...(input.mapping?.components ?? [])], evidence: ids.map((evidenceId) => ({ evidenceId, relationship: "SUPPORTS" })),
      ...(input.mapping ? { structuralEvidence: input.mapping.structuralEvidence === undefined ? undefined : { ...input.mapping.structuralEvidence, conflictKinds: [...input.mapping.structuralEvidence.conflictKinds] },
        applicationEvidence: input.mapping.applicationEvidence === undefined ? undefined : { ...input.mapping.applicationEvidence, classes: [...input.mapping.applicationEvidence.classes], usageIds: [...input.mapping.applicationEvidence.usageIds], conflictUsageIds: [...input.mapping.applicationEvidence.conflictUsageIds], negativeSignals: [...input.mapping.applicationEvidence.negativeSignals] } } : {}),
      ...(input.resolution ? { ...input.resolution, patchBlockers: ["NO_APPROVED_PATCH_LANE", ...(input.resolution.requiresTokenIntroduction ? ["REQUIRES_TOKEN_INTRODUCTION"] : []),
        ...(input.resolution.targetStatus === "TARGET_STYLE_PACK_DEFINED" ? ["TARGET_REPRESENTATION_UNVERIFIED"] : []), "INFERRED_MAPPING_REQUIRES_HUMAN_REVIEW"] } : {}),
      confidence: unscored, rationale: input.rationale, kind: input.kind,
      current: input.current, role: input.role, target: input.target, candidateTokens: sorted(input.candidates ?? []),
      decision: input.decision, risk: input.risk, reasonCodes: input.reasonCodes,
      filesAffected: sorted(input.files), blockingUnknownIds: sorted(input.unknowns ?? []),
      provenance: ids.map((evidenceId) => {
        const evidence = observations.get(evidenceId);
        if (evidence === undefined) throw new Error(`Missing planner observation: ${evidenceId}`);
        return { evidenceId, source: evidence.source };
      }),
    });
  }

  // Token policy changes are separate from literal substitutions. Never infer
  // that a style pack should replace a repository's scoped/theme-specific values.
  for (const mapping of recovered.sections.semanticTokens) {
    const structure = mapping.structuralEvidence;
    if (mapping.status !== "INFERRED" || structure === undefined || structure.conflictKinds.includes("TRUE_SEMANTIC_CONFLICT")) continue;
    const resolution = resolveRoleTarget(structure.role, structure.property, pack, bundle);
    add({ kind: "STRUCTURAL_SEMANTIC_REVIEW", status: "INFERRED", current: [...mapping.values], role: structure.role, target: resolution.target, mapping, resolution,
      decision: "REVIEW_REQUIRED", risk: "MEDIUM", reasonCodes: ["STRUCTURAL_MAPPING_REQUIRES_REVIEW", "NO_APPROVED_PATCH_LANE"],
      rationale: "Concrete authored style-pack target is not repository evidence or mutation permission. Existing patch safety is independent.",
      ids: mapping.evidence.filter(x => x.relationship === "SUPPORTS").map(x => x.evidenceId),
      files: mapping.evidence.flatMap(x => observations.get(x.evidenceId)?.source.file ?? []),
    });
  }
  for (const [name, definitions] of declarationsByName) {
    const role = roleFor(name);
    if (role === null) continue;
    const current = sorted(definitions.map(({ value }) => string(record(value).normalizedValue) ?? ""));
    const target = pack.semanticTokens[role];
    if (target === undefined) continue;
    const unchanged = current.length === 1 && current[0] === target;
    const blocking = sorted([...globalCssParseUnknowns, ...productionUnknowns.filter(({ source, relatedEvidenceIds }) =>
      definitions.some((definition) => source?.file === definition.source.file || relatedEvidenceIds.includes(definition.id)),
    )].map(({ id }) => id));
    const eligible = eligibleToken(name) && blocking.length === 0;
    add({ kind: "TOKEN_POLICY_CHANGE", status: eligible ? "INFERRED" : "UNKNOWN", current,
      role: eligible ? role : null, target: eligible ? target : null,
      decision: unchanged || !eligible ? "DO_NOT_TOUCH" : "REVIEW_REQUIRED",
      risk: unchanged ? "LOW" : "HIGH", reasonCodes: [unchanged ? "ALREADY_TARGET_POLICY" : eligible ? "AUTHORED_POLICY_REQUIRES_REVIEW" : "TOKEN_SCOPE_OR_VALUE_UNRESOLVED"],
      rationale: "An authored pack is not repository evidence. Global theme changes require human review and are never combined with literal substitutions.",
      ids: definitions.map(({ id }) => id), files: definitions.map(({ source }) => source.file),
      unknowns: blocking,
    });
  }

  for (const evidence of bundle.observations) {
    if (excluded.has(evidence.id)) continue;
    const data = record(evidence.value), context = record(data.context);
    const raw = string(data.normalizedValue), tokenType = string(data.tokenType);
    if (evidence.kind === "design_token_usage" && raw !== null) {
      const role = roleFor(raw);
      add({ kind: role === null ? "UNCHANGED_VARIABLE_REFERENCE" : "UNCHANGED_SEMANTIC_USAGE", status: "OBSERVED", current: [raw], role, target: null,
        decision: "DO_NOT_TOUCH", risk: "LOW", reasonCodes: ["EXISTING_VARIABLE_USAGE"],
        rationale: "An existing CSS variable reference does not need a raw-literal substitution. This does not prove runtime variable resolution.", ids: [evidence.id], files: [] });
      continue;
    }
    if (evidence.kind !== "design_value_usage" || raw === null || tokenType === null) continue;
    if (evidence.id.startsWith("tailwind-class:")) {
      const base = raw.split(":").at(-1)?.replace(/^!/u, "") ?? raw;
      const role = [...semanticRoles].find((name) => new RegExp(`^(?:bg|text|border|ring|outline)-${name}(?:/.+)?$`, "u").test(base)) ?? null;
      add({ kind: role === null ? "UNSUPPORTED_EVIDENCE" : "UNCHANGED_SEMANTIC_USAGE",
        status: role === null ? "UNKNOWN" : "OBSERVED", current: [raw], role, target: null,
        decision: "DO_NOT_TOUCH", risk: role === null ? "HIGH" : "LOW",
        reasonCodes: [role === null ? "TAILWIND_REWRITES_UNSUPPORTED" : "EXISTING_SEMANTIC_UTILITY_LITERAL"],
        rationale: "v0.1 does not rewrite Tailwind classes. An observed semantic utility spelling is not proof that generated CSS exists.", ids: [evidence.id], files: [] });
      continue;
    }
    if (tokenType !== "color") continue;
    const property = string(context.property) ?? "";
    if (property.startsWith("--")) continue; // separate token policy item
    const candidates = [...declarationsByName].filter(([name, definitions]) =>
      roleFor(name) !== null && definitions.some(({ value }) => string(record(value).normalizedValue) === raw),
    ).map(([name]) => name).sort();
    const relatedUnknowns = productionUnknowns.filter(({ relatedEvidenceIds, source }) =>
      relatedEvidenceIds.includes(evidence.id) || source?.file === evidence.source.file,
    );
    const blocking = sorted([...globalCssParseUnknowns, ...relatedUnknowns].map(({ id }) => id));
    const mechanicallyBounded = SUPPORTED_PROPERTIES.has(property) &&
      string(data.rawValue)?.trim() === raw && evidence.source.type === "SPAN" &&
      Array.isArray(context.conditionalAtRules) && context.conditionalAtRules.length === 0;
    const name = candidates.length === 1 ? candidates[0] : undefined;
    const tokenIds = candidates.flatMap((candidate) => (declarationsByName.get(candidate) ?? []).map(({ id }) => id));
    const anchorIds = name === undefined ? [] : bundle.observations.filter(({ id, kind, value }) => {
      const anchor = record(value), anchorContext = record(anchor.context);
      return !excluded.has(id) && kind === "design_token_usage" && anchor.name === name &&
        anchorContext.selector === context.selector && anchorContext.property === property &&
        Array.isArray(anchorContext.conditionalAtRules) && anchorContext.conditionalAtRules.length === 0;
    }).map(({ id }) => id);
    const eligible = name !== undefined && eligibleToken(name);
    const blocked = !mechanicallyBounded || blocking.length > 0 || (name !== undefined && !eligible);
    const selected = !blocked && eligible && anchorIds.length > 0;
    add({ kind: "RAW_LITERAL_REPLACEMENT", status: selected ? "INFERRED" : "UNKNOWN", current: [raw],
      role: selected && name !== undefined ? roleFor(name) : null,
      target: selected ? `var(${name ?? ""})` : null, candidates,
      decision: blocked || candidates.length === 0 ? "DO_NOT_TOUCH" : "REVIEW_REQUIRED", risk: blocked ? "HIGH" : "MEDIUM",
      reasonCodes: [blocked ? "UNSUPPORTED_OR_UNRESOLVED_SOURCE" : candidates.length > 1 ? "MULTIPLE_SAME_VALUE_TOKENS" : selected ? "STATIC_ANCHOR_NOT_BEHAVIOR_EQUIVALENCE" : candidates.length === 0 ? "NO_EXISTING_SEMANTIC_TOKEN" : "SEMANTIC_MAPPING_UNRESOLVED"],
      rationale: "Value equality and a static selector/property anchor only propose a review hypothesis. Inline/custom-property mutation and cascade behavior remain unproven; this is never AUTO_SAFE.",
      ids: [evidence.id, ...tokenIds, ...anchorIds], files: [evidence.source.file], unknowns: blocking });
  }

  // Assess the bounded planning claims jointly against the one factual bundle.
  const assessmentPayload = {
    schemaVersion: recovered.schemaVersion, source: recovered.source,
    sections: { colors: [], typography: [], spacing: [], radius: [], shadow: [], components: [], semanticTokens: items.map((item): RecoveredDesignItem => ({
      id: item.id, status: item.status, category: item.category, key: item.key,
      values: item.values, evidenceCount: item.evidenceCount, components: item.components,
      evidence: item.evidence, rationale: item.rationale, confidence: item.confidence,
    })) },
    unresolvedEvidenceIds: recovered.unresolvedEvidenceIds, coverage: recovered.coverage,
  };
  const assessed = assessRecoveredSystem(bundle, { ...assessmentPayload, contentFingerprint: createRecoveryContentFingerprint(assessmentPayload) });
  const confidenceById = new Map(assessed.sections.semanticTokens.map(({ id, confidence }) => [id, confidence]));
  const finalItems = items.map((item) => {
    const confidence = confidenceById.get(item.id);
    if (confidence === undefined) throw new Error("Missing planning assessment.");
    return { ...item, confidence };
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const counts = {
    autoSafe: 0, reviewRequired: finalItems.filter(({ decision }) => decision === "REVIEW_REQUIRED").length,
    doNotTouch: finalItems.filter(({ decision }) => decision === "DO_NOT_TOUCH").length,
    rawLiteralReviewCandidates: finalItems.filter(({ kind, decision }) => kind === "RAW_LITERAL_REPLACEMENT" && decision === "REVIEW_REQUIRED").length,
    tokenPolicyReviewChanges: finalItems.filter(({ kind, decision }) => kind === "TOKEN_POLICY_CHANGE" && decision === "REVIEW_REQUIRED").length,
    existingSemanticUsages: finalItems.filter(({ kind }) => kind === "UNCHANGED_SEMANTIC_USAGE").length,
    existingVariableReferences: finalItems.filter(({ kind }) => kind === "UNCHANGED_VARIABLE_REFERENCE").length,
  };
  const payload = {
    schemaVersion: "1.0.0" as const, status: "OBSERVED" as const, policyVersion: MIGRATION_POLICY_VERSION, dryRunOnly: true as const,
    source: { evidenceFingerprint: bundle.contentFingerprint, recoveryFingerprint: recovered.contentFingerprint,
      workingTreeFingerprint: bundle.snapshot.workingTreeFingerprint,
      stylePack: { id: "neutral-modern" as const, version: pack.version, contentFingerprint: pack.contentFingerprint } },
    items: finalItems, summary: { ...counts, statement: counts.rawLiteralReviewCandidates === 0
      ? "No raw-literal migration proposed within supported static evidence; this is not a completeness guarantee."
      : "Review candidates exist; no inferred substitution is automatically safe." },
    limitations: [
      "AUTO_SAFE is reserved but zero in v0.1: no explicit developer mapping contract exists.",
      "Only whole-value color/background-color/border-color CSS literals are review candidates; materialization must reparse and hash-verify source.",
      "Tailwind, class helpers, aliases, scoped themes and dynamic structures are never automatically rewritten.",
      "Inline/runtime custom-property overrides and complete cascade semantics are not established by scan.",
      "Style-pack typography, radius, shadow and spacing policies are recorded targets, not implemented migrations in v0.1.",
      "No proposed large-scale migration does not prove the entire runtime design system is understood.",
    ],
  };
  return deepFreeze(migrationPlanSchema.parse({ ...payload, contentFingerprint: createBundleContentFingerprint(payload) }));
}
