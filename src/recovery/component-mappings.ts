import type { ReadonlyEvidenceBundle, RecoveredDesignItem } from "../schemas/index.js";
import { hashContent } from "../utils/content-hash.js";

const object = (x: unknown): Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x) ? x as Record<string, unknown> : {};
const rawColor = /^(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950))$/u;

/** Narrow structure-led hypotheses. Palette names never determine a role. */
export function componentMappings(bundle: ReadonlyEvidenceBundle, excluded: ReadonlySet<string>): RecoveredDesignItem[] {
  const observations = bundle.observations.filter(x => !excluded.has(x.id));
  const components = new Map(observations.filter(x => x.kind === "component_declaration").map(x => [x.id, object(x.value).normalizedValue]));
  const refs = observations.filter(x => object(x.value).tokenType === "cva_reference");
  const result: RecoveredDesignItem[] = [];
  for (const evidence of observations) {
    const value = object(evidence.value), context = object(value.context), raw = value.normalizedValue;
    if (typeof raw !== "string" || context.tokenSpanReliable !== true || evidence.source.type !== "SPAN") continue;
    const match = /^(bg|text|border)-(.+)$/u.exec(raw);
    if (!match || !rawColor.test(match[2] ?? "")) continue;
    const property = match[1] === "bg" ? "background" : match[1] === "text" ? "foreground" : "border";
    const matchingRefs = refs.filter(ref => object(ref.value).normalizedValue === context.cvaDefinition &&
      ref.source.file === evidence.source.file && (ref.contextEvidenceIds ?? []).includes(evidence.id));
    const identities = [...new Set([...((evidence.contextEvidenceIds ?? []).map(id => components.get(id))),
      ...matchingRefs.flatMap(ref => (ref.contextEvidenceIds ?? []).map(id => components.get(id)))].filter(x => typeof x === "string"))];
    if (identities.length !== 1 || (identities[0] !== "Button" && identities[0] !== "Card")) continue;
    const component = identities[0];
    const variantName = typeof context.variantName === "string" ? context.variantName : "base";
    const variantValue = typeof context.variantValue === "string" ? context.variantValue : "base";
    const isVariant = context.cvaDefinition !== undefined && variantName === "variant";
    if (component === "Button" && (!isVariant || !["default", "destructive"].includes(variantValue) || property === "border")) continue;
    if (component === "Card" && (context.usageMode !== "STATIC" || context.cvaDefinition !== undefined || property === "foreground")) continue;
    // A CVA mapping claims declared recipe structure, never the effective runtime class.
    const ambiguousDefinition = isVariant && observations.some(other => {
      const otherValue = object(other.value), otherContext = object(otherValue.context);
      return other.source.file === evidence.source.file && otherContext.cvaDefinition === context.cvaDefinition &&
        typeof otherValue.tokenType === "string" && otherValue.tokenType.includes("color") &&
        typeof otherValue.normalizedValue === "string" && otherValue.normalizedValue.startsWith(`${match[1]}-`) &&
        otherContext.variantName !== "variant";
    });
    const definitionSource = object(context.cvaDefinitionSource);
    const unknown = ambiguousDefinition || bundle.unknowns.some(x => {
      if (excluded.has(x.id) || x.source?.file !== evidence.source.file) return false;
      if (isVariant && x.kind === "tailwind_class_semantics" && x.relatedEvidenceIds.length > 0) {
        return x.relatedEvidenceIds.some(id => {
          const related = observations.find(record => record.id === id);
          const data = object(related?.value), scope = object(data.context);
          if (scope.variantName === "variant" && scope.variantValue !== variantValue) return false;
          return typeof data.normalizedValue !== "string" || new RegExp(`(?:^|:)${match[1]}-`, "u").test(data.normalizedValue);
        });
      }
      if (!isVariant || x.source.type !== "SPAN" || definitionSource.type !== "SPAN") return true;
      const start = Number(definitionSource.startLine), end = Number(definitionSource.endLine);
      return x.source.startLine <= end && x.source.endLine >= start;
    });
    const role = component === "Card" ? property === "background" ? "surface.card" : "border.default" :
      `${variantValue === "default" ? "primary" : "destructive"}.action.${property}` as "primary.action.background" | "primary.action.foreground" | "destructive.action.background" | "destructive.action.foreground";
    const support = [...new Set([evidence.id, ...(evidence.contextEvidenceIds ?? []), ...matchingRefs.map(x => x.id),
      ...matchingRefs.flatMap(x => (x.contextEvidenceIds ?? []).filter(id => components.has(id)))])].filter(id => observations.some(x => x.id === id)).sort();
    const key = `mapping:${role}:${evidence.id}`;
    result.push({ id: `recovered:semanticTokens:${hashContent(key).slice(7)}`, status: unknown ? "UNKNOWN" : "INFERRED", category: "semanticTokens", key,
      values: [raw], evidenceCount: support.length, components: [component], evidence: support.map(evidenceId => ({ evidenceId, relationship: "SUPPORTS" })),
      confidence: { status: "UNSCORED", reasonCode: "PENDING_CONFIDENCE_MODEL", explanation: "Existing deterministic model assesses structural evidence." },
      rationale: unknown ? "Static structure retained but unresolved recipe/component evidence prevents acceptance." : "Exact component identity, declared static variant and property support a role hypothesis, not effective runtime styles; human review required, no mutation permission.",
      structuralEvidence: { component, variantName, variantValue, defaultVariant: typeof context.defaultVariant === "string" ? context.defaultVariant : null,
        property, rawClass: raw, role, conflictKinds: [], source: isVariant ? "cva.variant" : "static.component" },
    });
  }
  const originalReferences = new Map(result.map(item => [item.id, item.evidence.map(ref => ({ ...ref }))]));
  for (const item of result) {
    const structure = item.structuralEvidence!;
    const opposite = result.filter(other => other.values[0] === item.values[0] &&
      ((other.structuralEvidence!.role.startsWith("primary.") && structure.role.startsWith("destructive.")) ||
       (other.structuralEvidence!.role.startsWith("destructive.") && structure.role.startsWith("primary."))));
    if (opposite.length) {
      item.status = "UNKNOWN"; structure.conflictKinds.push("TRUE_SEMANTIC_CONFLICT");
      const ids = new Set(item.evidence.map(x => x.evidenceId));
      for (const other of opposite) for (const ref of originalReferences.get(other.id) ?? []) if (!ids.has(ref.evidenceId)) { ids.add(ref.evidenceId); item.evidence.push({ ...ref, relationship: "CONFLICTS" }); }
      item.evidenceCount = item.evidence.length; item.rationale = "Same raw class supports incompatible primary/destructive action roles; abstain.";
    } else if (result.some(other => other !== item && other.values[0] === item.values[0])) structure.conflictKinds.push("SHARED_IMPLEMENTATION_VALUE");
    if (observations.some(x => object(x.value).normalizedValue === item.values[0] && !item.evidence.some(r => r.evidenceId === x.id))) structure.conflictKinds.push("COMPONENT_CONTEXT_COLLISION");
    if (result.some(other => other !== item && other.structuralEvidence?.role === structure.role &&
        other.structuralEvidence.variantName === structure.variantName && other.structuralEvidence.variantValue === structure.variantValue &&
        other.evidence.some(ref => item.evidence.some(own => own.evidenceId === ref.evidenceId)) && other.values[0] !== item.values[0])) {
      item.status = "UNKNOWN"; item.rationale = "Multiple competing static values for one structural role cannot establish a unique class direction; abstain.";
    }
    const definitionIds = item.evidence.map(x => x.evidenceId).filter(id => components.has(id));
    const usages = observations.filter(x => {
      const data = object(x.value);
      return x.kind === "component_application_usage" && data.independent === true && data.resolution === "RESOLVED" && data.usageMode === "STATIC" &&
        definitionIds.includes(String(data.definitionId)) && (structure.component === "Card" || data.explicitVariant === structure.variantValue);
    });
    const conflicts = usages.filter(x => {
      const classes = object(object(x.value).staticProps).className;
      if (typeof classes !== "string") return false;
      const prefix = structure.property === "background" ? "bg" : structure.property === "foreground" ? "text" : "border";
      return classes.split(/\s+/u).some(token => token.startsWith(`${prefix}-`) && rawColor.test(token.slice(prefix.length + 1)) && token !== structure.rawClass);
    });
    const positive = usages.filter(x => !conflicts.includes(x));
    for (const usage of usages) if (!item.evidence.some(x => x.evidenceId === usage.id)) item.evidence.push({ evidenceId: usage.id, relationship: conflicts.includes(usage) ? "CONFLICTS" : "SUPPORTS" });
    const cross = new Set(positive.map(x => x.source.file)).size > 1;
    item.applicationEvidence = { strength: positive.length === 0 ? "DECLARATION_ONLY" : cross ? "CROSS_CONTEXT_SUPPORTED" : "APPLICATION_SUPPORTED",
      classes: ["DECLARATION_EVIDENCE", ...(positive.length ? ["APPLICATION_EVIDENCE" as const] : []), ...(cross ? ["CROSS_CONTEXT_EVIDENCE" as const] : [])],
      usageIds: positive.map(x => x.id).sort(), conflictUsageIds: conflicts.map(x => x.id).sort(),
      negativeSignals: [...(usages.length === 0 && structure.component === "Button" ? ["UNUSED_VARIANT" as const] : []), ...(conflicts.length ? ["APPLICATION_CONFLICT" as const] : [])],
      coverageStatement: "Only resolved static imports and explicit variants inside analyzed files; absence is not proof of runtime non-use. Definition, registry/example, test, vendor and generated sites are not independent application support." };
    if (conflicts.length) { item.status = "UNKNOWN"; structure.conflictKinds.push("APPLICATION_CONFLICT"); item.rationale = "Static application class overrides conflict with the declared property; abstain, not a runtime cascade assertion."; }
    item.evidenceCount = item.evidence.length;
  }
  return result;
}
