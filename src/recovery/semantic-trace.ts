import { recoverDesignSystem } from "./recover.js";
import { isStaticColorSyntax } from "../extraction/color-syntax.js";
import type { ReadonlyEvidenceBundle } from "../schemas/index.js";

type Observation = ReadonlyEvidenceBundle["observations"][number];
type Decision = "ACCEPTED" | "ABSTAIN_NO_CANDIDATE_RULE" | "ABSTAIN_INSUFFICIENT_EVIDENCE" | "ABSTAIN_CONFLICT" | "ABSTAIN_DYNAMIC" | "ABSTAIN_UNSUPPORTED";
export interface SemanticTraceRecord {
  candidate_id: string;
  record_type: "GENERATED_ROLE_CANDIDATE" | "POTENTIAL_INPUT_PROBE" | "UNKNOWN_INPUT_PROBE";
  source_values: string[];
  property_types: string[];
  candidate_semantic_role: string | null;
  contexts: unknown[];
  provenance: { evidence_id: string; source: Observation["source"] }[];
  positive_evidence: string[];
  negative_evidence: { evidence_id: string; reason: string }[];
  conflicting_evidence: string[];
  confidence_inputs: unknown;
  confidence_result: unknown;
  decision: Decision;
  decision_reason: string;
  structural_evidence?: unknown;
  conflict_kinds?: readonly string[];
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function strings(values: unknown[]): string[] { return [...new Set(values.filter((x): x is string => typeof x === "string"))].sort(); }

/** Opt-in diagnostics only: reads actual recovery decisions, never adds rules or changes output. */
export function traceSemanticRecovery(bundle: ReadonlyEvidenceBundle) {
  const recovered = recoverDesignSystem(bundle);
  const observations = new Map(bundle.observations.map(x => [x.id, x]));
  const excluded = new Map(recovered.coverage.excludedEvidence.map(x => [x.evidenceId, x.reasonCode]));
  const traces: SemanticTraceRecord[] = [];
  const covered = new Set<string>();
  const shadcn = bundle.repository.stylingSystems.includes("shadcn");
  for (const item of recovered.sections.semanticTokens.filter(x => x.key.startsWith("role:"))) {
    const refs = item.evidence.map(x => ({ ref: x, observation: observations.get(x.evidenceId) }));
    const negative: SemanticTraceRecord["negative_evidence"] = [];
    for (const { observation } of refs) {
      if (!observation) continue;
      covered.add(observation.id);
      const data = record(observation.value), context = record(data.context);
      const value = typeof data.normalizedValue === "string" ? data.normalizedValue : "";
      const selector = typeof context.selector === "string" ? context.selector : "";
      const global = Array.isArray(context.conditionalAtRules) && context.conditionalAtRules.length === 0 &&
        (context.atRule === "theme" || selector.split(",").some(x => x.trim() === ":root"));
      if (!global) negative.push({ evidence_id: observation.id, reason: "Not an unconditional root/theme declaration; no unique repository-wide role claim." });
      if (!isStaticColorSyntax(value) && !(shadcn && isStaticColorSyntax(`hsl(${value})`))) negative.push({ evidence_id: observation.id, reason: "Existing role rule does not support this value syntax." });
    }
    const conflict = item.evidence.filter(x => x.relationship === "CONFLICTS").map(x => x.evidenceId);
    const decision: Decision = item.status === "INFERRED" ? "ACCEPTED" : conflict.length ? "ABSTAIN_CONFLICT" : negative.some(x => x.reason.includes("syntax")) ? "ABSTAIN_UNSUPPORTED" : "ABSTAIN_INSUFFICIENT_EVIDENCE";
    traces.push({ candidate_id: item.id, record_type: "GENERATED_ROLE_CANDIDATE", source_values: [...item.values],
      property_types: strings(refs.map(x => record(record(x.observation?.value).context).property)), candidate_semantic_role: item.key.slice(5),
      contexts: refs.map(x => record(x.observation?.value).context ?? null),
      provenance: refs.flatMap(x => x.observation ? [{ evidence_id: x.observation.id, source: x.observation.source }] : []),
      positive_evidence: item.evidence.filter(x => x.relationship === "SUPPORTS").map(x => x.evidenceId),
      negative_evidence: negative, conflicting_evidence: conflict,
      confidence_inputs: { status_before_assessment: item.status, evidence: item.evidence, threshold_used: false,
        metrics: record(item.confidence).metrics ?? null, related_unknown_ids: record(item.confidence).relatedUnknownIds ?? [] },
      confidence_result: item.confidence, decision, decision_reason: item.rationale,
      conflict_kinds: conflict.length ? ["GLOBAL_VALUE_DIVERGENCE"] : [], });
  }
  for (const item of recovered.sections.semanticTokens.filter(x => x.structuralEvidence !== undefined)) {
    const structure = item.structuralEvidence!;
    const refs = item.evidence.flatMap(ref => {
      const observation = observations.get(ref.evidenceId);
      return observation ? [{ ref, observation }] : [];
    });
    for (const { observation } of refs) covered.add(observation.id);
    const conflicts = item.evidence.filter(x => x.relationship === "CONFLICTS").map(x => x.evidenceId);
    const collisionRecords = structure.conflictKinds.includes("COMPONENT_CONTEXT_COLLISION") ? bundle.observations.filter(x =>
      !excluded.has(x.id) && record(x.value).normalizedValue === structure.rawClass && !item.evidence.some(ref => ref.evidenceId === x.id)) : [];
    const confidence = record(item.confidence);
    const relatedUnknownIds = strings([
      ...(Array.isArray(confidence.relatedUnknownIds) ? confidence.relatedUnknownIds as unknown[] : []),
      ...(Array.isArray(confidence.adjustments) ? confidence.adjustments.flatMap(adjustment =>
        record(adjustment).ruleId === "SCOPED_UNRESOLVED" && Array.isArray(record(adjustment).evidenceIds) ? record(adjustment).evidenceIds as unknown[] : []) : []),
    ]);
    const unknownRecords = bundle.unknowns.filter(x => relatedUnknownIds.includes(x.id));
    traces.push({ candidate_id: item.id, record_type: "GENERATED_ROLE_CANDIDATE", source_values: [...item.values], property_types: [structure.property],
      candidate_semantic_role: structure.role, contexts: [{ component: structure.component, variantName: structure.variantName, variantValue: structure.variantValue }],
      provenance: [...refs.map(({ observation }) => ({ evidence_id: observation.id, source: observation.source })),
        ...collisionRecords.map(x => ({ evidence_id: x.id, source: x.source })),
        ...unknownRecords.flatMap(x => x.source ? [{ evidence_id: x.id, source: x.source }] : [])],
      positive_evidence: item.evidence.filter(x => x.relationship === "SUPPORTS").map(x => x.evidenceId),
      negative_evidence: [...(item.status === "UNKNOWN" ? [{ evidence_id: refs[0]!.observation.id, reason: item.rationale }] : []),
        ...collisionRecords.map(x => ({ evidence_id: x.id, reason: "Same raw class in another context limits global raw-to-role generalization; not a contradiction of this local declared recipe." })),
        ...unknownRecords.map(x => ({ evidence_id: x.id, reason: `Existing confidence counterevidence (${x.kind}); does not establish effective runtime styles.` }))],
      conflicting_evidence: conflicts, confidence_inputs: { status_before_assessment: item.status, threshold_used: false, evidence: item.evidence },
      confidence_result: item.confidence, decision: item.status === "INFERRED" ? "ACCEPTED" : conflicts.length ? "ABSTAIN_CONFLICT" : "ABSTAIN_INSUFFICIENT_EVIDENCE",
      decision_reason: item.rationale, structural_evidence: structure, conflict_kinds: structure.conflictKinds });
  }
  for (const observation of bundle.observations) {
    if (covered.has(observation.id)) continue;
    const data = record(observation.value), context = record(data.context);
    if (!["design_token_declaration", "design_value_usage", "component_declaration", "component_style_usage"].includes(observation.kind)) continue;
    const token = typeof data.tokenType === "string" ? data.tokenType : "";
    if (!token.includes("color") && token !== "css_custom_property" && !observation.kind.startsWith("component_")) continue;
    const exclusion = excluded.get(observation.id);
    const existingAlias = typeof data.normalizedValue === "string" && /^(?:bg|text|border|ring)-(?:primary(?:-foreground)?|secondary(?:-foreground)?|destructive(?:-foreground)?|card(?:-foreground)?|popover(?:-foreground)?|muted(?:-foreground)?|accent(?:-foreground)?|background|foreground|input|border|ring)$/u.test(data.normalizedValue);
    traces.push({ candidate_id: `probe:${observation.id}`, record_type: "POTENTIAL_INPUT_PROBE",
      source_values: strings([data.rawValue, data.normalizedValue, data.name]), property_types: strings([context.property, token]),
      candidate_semantic_role: null, contexts: [context], provenance: [{ evidence_id: observation.id, source: observation.source }],
      positive_evidence: [observation.id], negative_evidence: exclusion ? [{ evidence_id: observation.id, reason: exclusion }] : [], conflicting_evidence: [],
      confidence_inputs: { assessed: false, observed_semantic_relation: existingAlias, reason: "No generated semantic role claim to assess; context presence is not a candidate rule." }, confidence_result: null,
      decision: exclusion ? "ABSTAIN_UNSUPPORTED" : "ABSTAIN_NO_CANDIDATE_RULE",
      decision_reason: exclusion ? `Recovery excludes ${exclusion}.` : existingAlias ? "Already observed semantic utility relation; no duplicate INFERRED mapping is generated." : "No supported narrow structural or exact-name rule matches this input.",
      conflict_kinds: existingAlias && !exclusion ? ["EXISTING_SEMANTIC_TOKEN_ALIAS"] : [], });
  }
  for (const finding of bundle.unknowns) {
    traces.push({ candidate_id: `probe:${finding.id}`, record_type: "UNKNOWN_INPUT_PROBE", source_values: [], property_types: [], candidate_semantic_role: null,
      contexts: [], provenance: finding.source ? [{ evidence_id: finding.id, source: finding.source }] : [],
      positive_evidence: [], negative_evidence: [{ evidence_id: finding.id, reason: finding.reason }], conflicting_evidence: [],
      confidence_inputs: { assessed: false, scope: finding.scope ?? null, related_evidence_ids: finding.relatedEvidenceIds }, confidence_result: null,
      decision: finding.kind === "dynamic_tailwind_class" ? "ABSTAIN_DYNAMIC" : "ABSTAIN_UNSUPPORTED", decision_reason: finding.reason });
  }
  const generated = traces.filter(x => x.record_type === "GENERATED_ROLE_CANDIDATE");
  const counts = (items: SemanticTraceRecord[]) => Object.fromEntries([...new Set(items.map(x => x.decision))].sort().map(d => [d, items.filter(x => x.decision === d).length]));
  return { schemaVersion: "diagnostic-1.0.0", evidenceFingerprint: bundle.contentFingerprint, recoveryFingerprint: recovered.contentFingerprint,
    summary: { observedSemanticFacts: recovered.sections.semanticTokens.filter(x => x.status === "OBSERVED").length,
      potentialInputProbes: traces.length - generated.length, candidatesGenerated: generated.length, acceptedInferredMappings: generated.filter(x => x.decision === "ACCEPTED").length,
      generatedCandidateDecisions: counts(generated), inputProbeDecisions: counts(traces.filter(x => x.record_type !== "GENERATED_ROLE_CANDIDATE")),
      thresholdStage: "MISSING: confidence annotates an already decided status; no numeric acceptance threshold", componentToRoleGenerator: "NARROW_STATIC_BUTTON_CARD" },
    traces: traces.map(item => ({ ...item, component_names: strings(item.contexts.map(x => record(x).component)),
      variant: record(item.structural_evidence).variantValue ?? null, variant_information: item.structural_evidence ? "Static structural context retained; see structural_evidence and observation provenance." : item.contexts.some(x => record(x).usageMode === "CONDITIONAL" || record(x).possibleVariantClasses === true)
        ? "Only possible/conditional classes retained; variant axis/choice/default selection not retained." : "No variant identity in this record." })) };
}
