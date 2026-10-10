import {
  CONFIDENCE_MODEL_VERSION,
  createRecoveryContentFingerprint,
  currentDesignSystemSchema,
  type RecoveredDesignItem,
  type ReadonlyEvidenceBundle,
  type ReadonlyCurrentDesignSystem,
  confidenceRuleSchema,
} from "../schemas/index.js";
import { deepFreeze } from "../utils/deep-freeze.js";

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function assessRecoveredSystem(
  bundle: ReadonlyEvidenceBundle,
  system: ReadonlyCurrentDesignSystem,
): ReadonlyCurrentDesignSystem {
  if (system.source.evidenceFingerprint !== bundle.contentFingerprint ||
      system.source.workingTreeFingerprint !== bundle.snapshot.workingTreeFingerprint) {
    throw new Error("Confidence requires the recovery's exact source EvidenceBundle.");
  }
  currentDesignSystemSchema.parse(system);
  const byId = new Map(bundle.observations.map((evidence) => [evidence.id, evidence]));
  const excluded = new Set(system.coverage.excludedEvidence.map(({ evidenceId }) => evidenceId));
  const shared = {
    modelVersion: CONFIDENCE_MODEL_VERSION,
    kind: "DETERMINISTIC_HEURISTIC" as const,
    claim: "STATIC_EVIDENCE_SUPPORT" as const,
  };

  function assess(item: ReadonlyCurrentDesignSystem["sections"]["colors"][number]): RecoveredDesignItem {
    const refs = [...item.evidence].sort((left, right) => left.evidenceId < right.evidenceId ? -1 : left.evidenceId > right.evidenceId ? 1 : 0);
    const resolved = refs.map((ref) => {
      const evidence = byId.get(ref.evidenceId);
      if (evidence === undefined || excluded.has(ref.evidenceId)) {
        throw new Error(`Confidence requires non-excluded observation: ${ref.evidenceId}`);
      }
      return { ...ref, evidence };
    });
    const supports = resolved.filter(({ relationship }) => relationship === "SUPPORTS");
    const conflicts = resolved.filter(({ relationship }) => relationship === "CONFLICTS");
    const ids = new Set(refs.map(({ evidenceId }) => evidenceId));
    const files = new Set(supports.map(({ evidence }) => evidence.source.file));
    const relatedUnknowns = bundle.unknowns.filter((unknown) =>
      !excluded.has(unknown.id) && unknown.relatedEvidenceIds.some((id) => ids.has(id)),
    );
    const sameFileUnknowns = bundle.unknowns.filter((unknown) =>
      !excluded.has(unknown.id) && unknown.source !== undefined && files.has(unknown.source.file) &&
      !relatedUnknowns.some(({ id }) => id === unknown.id),
    );
    const itemBase = { ...item, values: [...item.values], components: [...item.components], evidence: refs,
      applicationEvidence: item.applicationEvidence === undefined ? undefined : { ...item.applicationEvidence, classes: [...item.applicationEvidence.classes], usageIds: [...item.applicationEvidence.usageIds], conflictUsageIds: [...item.applicationEvidence.conflictUsageIds], negativeSignals: [...item.applicationEvidence.negativeSignals] },
      structuralEvidence: item.structuralEvidence === undefined ? undefined : { ...item.structuralEvidence, conflictKinds: [...item.structuralEvidence.conflictKinds] },
    };
    if (item.status === "UNKNOWN") return {
      ...itemBase,
      confidence: { ...shared, status: "UNRESOLVED", score: null, band: "UNKNOWN",
        reasonCode: "RECOVERY_STATUS_UNKNOWN",
        conflictingEvidenceIds: sorted(conflicts.map(({ evidenceId }) => evidenceId)),
        relatedUnknownIds: sorted([...relatedUnknowns, ...sameFileUnknowns].map(({ id }) => id)),
        explanation: "The recovery claim is unresolved. Observed alternatives are not replaced by a low numeric score.",
      },
    };
    if (supports.length === 0) throw new Error("Assessed confidence requires supporting observations.");
    let points = 0;
    const adjustments: { ruleId: typeof confidenceRuleSchema.enum[keyof typeof confidenceRuleSchema.enum]; before: number; after: number; appliedDelta: number; evidenceIds: string[]; explanation: string }[] = [];
    function adjust(ruleId: typeof confidenceRuleSchema.enum[keyof typeof confidenceRuleSchema.enum], after: number, evidenceIds: string[], explanation: string): void {
      adjustments.push({ ruleId, before: points, after, appliedDelta: after - points, evidenceIds: sorted(evidenceIds), explanation });
      points = after;
    }
    const supportingIds = supports.map(({ evidenceId }) => evidenceId);
    const candidates = supports.filter(({ evidence }) => String(record(evidence.value).tokenType).includes("candidate"));
    const base = candidates.length > 0 ? 1 : item.status === "INFERRED" ? 2 : 3;
    adjust("BASE_STATIC_SUPPORT", base, supportingIds,
      "Ordinal rubric: explicit bounded static claim 3; name-based inference 2; unresolved utility candidate 1. Weakest relevant evidence family limits the whole item.");
    const conditional = supports.filter(({ evidence }) => {
      const context = record(record(evidence.value).context);
      return context.usageMode === "CONDITIONAL" || context.possibleVariantClasses === true;
    });
    if (conditional.length > 0) adjust("CONDITIONAL_POSSIBLE_USAGE_CAP", Math.min(points, 2), conditional.map(({ evidenceId }) => evidenceId), "Possible variants/conditional expressions are not proven rendered selections.");
    const utilities = supports.filter(({ evidence }) => evidence.id.startsWith("tailwind-class:"));
    if (utilities.length > 0) adjust("UTILITY_GENERATION_UNVERIFIED_CAP", Math.min(points, 2), utilities.map(({ evidenceId }) => evidenceId), "Static utility literals do not prove generated CSS or runtime application.");
    const unreliable = supports.filter(({ evidence }) => evidence.source.type !== "SPAN" || record(record(evidence.value).context).tokenSpanReliable === false);
    if (unreliable.length > 0) adjust("IMPRECISE_SOURCE_CAP", Math.min(points, 2), unreliable.map(({ evidenceId }) => evidenceId), "File-level/escaped-literal provenance cannot establish an exact class token span.");
    if (relatedUnknowns.length > 0 || sameFileUnknowns.length > 0) {
      adjust("SCOPED_UNRESOLVED", Math.min(2, Math.max(0, points - 1)), [...relatedUnknowns, ...sameFileUnknowns].map(({ id }) => id), "Directly related or conservatively same-file unresolved evidence; same-file association does not prove this exact item is affected.");
    }
    for (const conflict of conflicts) adjust("TRUE_CONFLICT", Math.min(1, Math.max(0, points - 1)), [conflict.evidenceId], points === 0 ? "Already at rubric floor; no additional numeric decrease claimed." : "Counterevidence to this exact claim reduces support and prohibits HIGH.");
    return { ...itemBase, confidence: {
      ...shared, status: "ASSESSED", unit: "ORDINAL_RUBRIC_POINTS", score: points,
      band: points >= 3 ? "HIGH" : points === 2 ? "MEDIUM" : "LOW",
      metrics: {
        supportingRecords: supports.length,
        supportingSites: new Set(supports.map(({ evidence }) => JSON.stringify(evidence.source))).size,
        supportingFiles: files.size, conflicts: conflicts.length,
        relatedUnknowns: relatedUnknowns.length, sameFileUnknowns: sameFileUnknowns.length,
      }, adjustments,
      explanation: "Subjective versioned ordinal static-support rubric, not empirically calibrated; record/site/file counts add zero points and are not runtime usage or independent samples.",
    } };
  }
  const sections = {
    colors: system.sections.colors.map(assess), typography: system.sections.typography.map(assess),
    spacing: system.sections.spacing.map(assess), radius: system.sections.radius.map(assess),
    shadow: system.sections.shadow.map(assess), semanticTokens: system.sections.semanticTokens.map(assess),
    components: system.sections.components.map(assess),
  };
  const result = {
    schemaVersion: system.schemaVersion, source: system.source, sections,
    unresolvedEvidenceIds: system.unresolvedEvidenceIds, coverage: system.coverage,
  };
  return deepFreeze(currentDesignSystemSchema.parse({ ...result, contentFingerprint: createRecoveryContentFingerprint(result) }));
}
