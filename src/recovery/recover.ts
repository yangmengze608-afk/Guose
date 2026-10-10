import {
  CURRENT_DESIGN_SYSTEM_SCHEMA_VERSION,
  createRecoveryContentFingerprint,
  currentDesignSystemSchema,
  type ReadonlyCurrentDesignSystem,
  type ReadonlyEvidenceBundle,
  type RecoveredDesignItem,
  type RecoveryCategory,
} from "../schemas/index.js";
import { deepFreeze } from "../utils/deep-freeze.js";
import { hashContent } from "../utils/content-hash.js";
import { isStaticColorSyntax } from "../extraction/color-syntax.js";
import { assessRecoveredSystem } from "../confidence/index.js";
import { obviousNonProductionPath } from "../utils/non-production-path.js";
import { componentMappings } from "./component-mappings.js";

const UNSCORED = {
  status: "UNSCORED",
  reasonCode: "PENDING_CONFIDENCE_MODEL",
  explanation:
    "Phase F has not assigned a reviewed deterministic confidence heuristic.",
} as const;

interface ItemAccumulator {
  status: "OBSERVED" | "INFERRED" | "UNKNOWN";
  category: RecoveryCategory;
  key: string;
  values: Set<string>;
  evidenceIds: Set<string>;
  conflictingEvidenceIds: Set<string>;
  components: Set<string>;
  rationale: string;
}

type ExclusionReason =
  | "NON_PRODUCTION_TEST"
  | "NON_PRODUCTION_STORY"
  | "GENERATED_SOURCE"
  | "VENDORED_SOURCE";

interface RoleEvidence {
  value: string;
  evidenceId: string;
  globallyScoped: boolean;
  compatibleValue: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exclusionReason(file: string): ExclusionReason | null {
  const obviousRole = obviousNonProductionPath(file);
  if (obviousRole === "VENDOR") return "VENDORED_SOURCE";
  if (obviousRole === "GENERATED") return "GENERATED_SOURCE";
  if (/(?:^|\/)(?:vendor|third_party)(?:\/|$)/u.test(file)) {
    return "VENDORED_SOURCE";
  }
  if (
    /(?:^|\/)(?:generated|__generated__)(?:\/|$)|\.generated\.[^.]+$/u.test(
      file,
    )
  ) {
    return "GENERATED_SOURCE";
  }
  if (/(?:^|\/)(?:stories|storybook)(?:\/|$)|\.stories\.[^.]+$/u.test(file)) {
    return "NON_PRODUCTION_STORY";
  }
  if (
    /(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)|\.(?:test|spec)\.[^.]+$/u.test(
      file,
    )
  ) {
    return "NON_PRODUCTION_TEST";
  }
  return null;
}

function itemId(category: RecoveryCategory, key: string): string {
  return `recovered:${category}:${hashContent(key).slice("sha256:".length)}`;
}

function createAccumulator(
  category: RecoveryCategory,
  key: string,
  rationale: string,
  status: "OBSERVED" | "INFERRED" | "UNKNOWN" = "OBSERVED",
): ItemAccumulator {
  return {
    status,
    category,
    key,
    values: new Set(),
    evidenceIds: new Set(),
    conflictingEvidenceIds: new Set(),
    components: new Set(),
    rationale,
  };
}

function finalize(accumulator: ItemAccumulator): RecoveredDesignItem {
  return {
    id: itemId(accumulator.category, accumulator.key),
    status: accumulator.status,
    category: accumulator.category,
    key: accumulator.key,
    values: [...accumulator.values].sort(compareText),
    evidenceCount: accumulator.evidenceIds.size,
    components: [...accumulator.components].sort(compareText),
    evidence: [...accumulator.evidenceIds]
      .sort(compareText)
      .map((evidenceId) => ({ evidenceId, relationship: accumulator.conflictingEvidenceIds.has(evidenceId) ? "CONFLICTS" : "SUPPORTS" })),
    rationale: accumulator.rationale,
    confidence: UNSCORED,
  };
}

function sectionForTokenType(tokenType: string): RecoveryCategory | null {
  if (tokenType === "color" || tokenType === "color_candidate") return "colors";
  if (tokenType.startsWith("font_")) return "typography";
  if (tokenType === "spacing") return "spacing";
  if (tokenType === "radius") return "radius";
  if (tokenType === "shadow") return "shadow";
  return null;
}

const SEMANTIC_ROLE_NAMES = new Set([
  "primary-foreground", "secondary-foreground", "destructive-foreground",
  "accent-foreground", "muted-foreground", "card-foreground", "popover-foreground",
  "accent",
  "background",
  "border",
  "card",
  "destructive",
  "foreground",
  "input",
  "muted",
  "popover",
  "primary",
  "ring",
  "secondary",
  "surface",
]);

function semanticRole(name: string): string | null {
  const match = /^--(?:color-)?([a-z0-9-]+)$/u.exec(name);
  const role = match?.[1];
  return role !== undefined && SEMANTIC_ROLE_NAMES.has(role) ? role : null;
}

function compatibleRoleValue(value: string, shadcn: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    isStaticColorSyntax(normalized) ||
    (shadcn && isStaticColorSyntax(`hsl(${normalized})`))
  );
}

export function recoverDesignSystem(
  bundle: ReadonlyEvidenceBundle,
): ReadonlyCurrentDesignSystem {
  if (bundle.repository.supportStatus === "UNSUPPORTED") {
    throw new Error(
      "Design-system recovery requires a supported React or Next.js React repository.",
    );
  }

  const groups = new Map<string, ItemAccumulator>();
  const semanticDeclarations = new Map<string, ItemAccumulator>();
  const semanticUsages = new Map<string, Set<string>>();
  const roleEvidence = new Map<string, RoleEvidence[]>();
  const excludedEvidence = new Map<string, ExclusionReason>();
  const shadcn = bundle.repository.stylingSystems.includes("shadcn");

  function group(
    category: RecoveryCategory,
    key: string,
    rationale: string,
  ): ItemAccumulator {
    const mapKey = `${category}\u0000${key}`;
    const existing = groups.get(mapKey);
    if (existing !== undefined) return existing;
    const created = createAccumulator(category, key, rationale);
    groups.set(mapKey, created);
    return created;
  }

  for (const evidence of bundle.observations) {
    const excluded = exclusionReason(evidence.source.file);
    if (excluded !== null) {
      excludedEvidence.set(evidence.id, excluded);
      continue;
    }
    if (!isRecord(evidence.value)) continue;
    const tokenType = text(evidence.value, "tokenType");
    const normalizedValue = text(evidence.value, "normalizedValue");
    const context = evidence.value.context;
    const component = isRecord(context) ? text(context, "component") : null;

    if (evidence.kind === "design_value_usage" && tokenType !== null) {
      const category = sectionForTokenType(tokenType);
      if (category !== null && normalizedValue !== null) {
        const accumulator = group(
          category,
          normalizedValue,
          `Groups directly observed ${tokenType} usages by normalized value.`,
        );
        accumulator.values.add(normalizedValue);
        accumulator.evidenceIds.add(evidence.id);
        if (component !== null) accumulator.components.add(component);
      }
    }

    if (
      evidence.kind === "design_token_declaration" &&
      tokenType === "color" &&
      normalizedValue !== null
    ) {
      const accumulator = group(
        "colors",
        normalizedValue,
        "Groups directly observed configured color literals by normalized value.",
      );
      accumulator.values.add(normalizedValue);
      accumulator.evidenceIds.add(evidence.id);
    }

    if (
      evidence.kind === "design_token_declaration" &&
      tokenType === "css_custom_property"
    ) {
      const name = text(evidence.value, "name");
      if (name !== null && normalizedValue !== null) {
        const accumulator =
          semanticDeclarations.get(name) ??
          createAccumulator(
            "semanticTokens",
            name,
            "Recovers an explicitly declared CSS custom property without assigning a new semantic role.",
          );
        accumulator.values.add(normalizedValue);
        accumulator.evidenceIds.add(evidence.id);
        semanticDeclarations.set(name, accumulator);
        const role = semanticRole(name);
        if (role !== null) {
          const selector = isRecord(context) ? text(context, "selector") : null;
          const atRule = isRecord(context) ? text(context, "atRule") : null;
          const records = roleEvidence.get(role) ?? [];
          records.push({
            value: normalizedValue,
            evidenceId: evidence.id,
            globallyScoped:
              isRecord(context) && Array.isArray(context.conditionalAtRules) &&
              context.conditionalAtRules.length === 0 &&
              (atRule === "theme" ||
              selector?.split(",").some((part) => part.trim() === ":root") === true),
            compatibleValue: compatibleRoleValue(normalizedValue, shadcn),
          });
          roleEvidence.set(role, records);
        }
      }
    }

    if (evidence.kind === "design_token_usage") {
      const name = text(evidence.value, "name");
      if (name !== null) {
        const ids = semanticUsages.get(name) ?? new Set<string>();
        ids.add(evidence.id);
        semanticUsages.set(name, ids);
      }
    }
  }

  for (const [name, usageIds] of semanticUsages) {
    const declaration = semanticDeclarations.get(name);
    if (declaration !== undefined) {
      for (const id of usageIds) declaration.evidenceIds.add(id);
      continue;
    }
    const unresolved = createAccumulator(
      "semanticTokens",
      name,
      "The CSS custom property is referenced, but no declaration exists in the analyzed files.",
      "UNKNOWN",
    );
    for (const id of usageIds) unresolved.evidenceIds.add(id);
    semanticDeclarations.set(name, unresolved);
  }

  for (const declaration of semanticDeclarations.values()) {
    groups.set(`${declaration.category}\u0000${declaration.key}`, declaration);
  }

  for (const [role, candidates] of roleEvidence) {
    const values = new Set(candidates.map(({ value }) => value));
    const eligible = candidates.every(
      ({ compatibleValue, globallyScoped }) => compatibleValue && globallyScoped,
    );
    const inferred = createAccumulator(
      "semanticTokens",
      `role:${role}`,
      eligible && values.size === 1
        ? `Infers the ${role} role only from an exact existing CSS custom-property name; the value remains directly observed.`
        : `The exact ${role} name is observed, but value type or selector scope does not prove one repository-wide semantic role value.`,
      eligible && values.size === 1 ? "INFERRED" : "UNKNOWN",
    );
    for (const candidate of candidates) {
      inferred.values.add(candidate.value);
      inferred.evidenceIds.add(candidate.evidenceId);
      // Counterevidence to this item's single global-value claim, not a claim
      // that multiple theme declarations themselves are erroneous.
      if (values.size > 1 && candidate.value !== [...values].sort(compareText)[0]) {
        inferred.conflictingEvidenceIds.add(candidate.evidenceId);
      }
    }
    groups.set(`${inferred.category}\u0000${inferred.key}`, inferred);
  }

  const contextualEvidence = new Map<string, typeof bundle.observations>();
  const observationById = new Map(
    bundle.observations.map((evidence) => [evidence.id, evidence] as const),
  );
  for (const evidence of bundle.observations) {
    if (excludedEvidence.has(evidence.id)) continue;
    for (const contextId of evidence.contextEvidenceIds ?? []) {
      const usages = contextualEvidence.get(contextId) ?? [];
      contextualEvidence.set(contextId, [...usages, evidence]);
    }
  }
  for (const componentEvidence of bundle.observations) {
    if (
      excludedEvidence.has(componentEvidence.id) ||
      componentEvidence.kind !== "component_declaration" ||
      !isRecord(componentEvidence.value)
    ) {
      continue;
    }
    const name = text(componentEvidence.value, "normalizedValue");
    if (name === null) continue;
    const accumulator = group(
      "components",
      `${componentEvidence.source.file}#${name}`,
      "Recovers an AST-observed React component and contextualized possible style usages; conditional/cva variants are not proven rendered selections.",
    );
    accumulator.values.add(name);
    accumulator.components.add(name);
    accumulator.evidenceIds.add(componentEvidence.id);
    for (const usage of contextualEvidence.get(componentEvidence.id) ?? []) {
      accumulator.evidenceIds.add(usage.id);
      if (isRecord(usage.value)) {
        const rawValue = text(usage.value, "rawValue");
        if (rawValue !== null) accumulator.values.add(rawValue);
        const usageContext = usage.value.context;
        const referencedIds =
          isRecord(usageContext) && Array.isArray(usageContext.referencedEvidenceIds)
            ? usageContext.referencedEvidenceIds.filter(
                (id): id is string => typeof id === "string",
              )
            : [];
        for (const referencedId of referencedIds) {
          const referenced = observationById.get(referencedId);
          if (referenced === undefined) continue;
          accumulator.evidenceIds.add(referenced.id);
          if (isRecord(referenced.value)) {
            const referencedValue = text(referenced.value, "rawValue");
            if (referencedValue !== null) accumulator.values.add(referencedValue);
          }
        }
      }
    }
  }

  const sections = {
    colors: [] as RecoveredDesignItem[],
    typography: [] as RecoveredDesignItem[],
    spacing: [] as RecoveredDesignItem[],
    radius: [] as RecoveredDesignItem[],
    shadow: [] as RecoveredDesignItem[],
    semanticTokens: [] as RecoveredDesignItem[],
    components: [] as RecoveredDesignItem[],
  };
  for (const accumulator of groups.values()) {
    sections[accumulator.category].push(finalize(accumulator));
  }
  sections.semanticTokens.push(...componentMappings(bundle, new Set(excludedEvidence.keys())));
  for (const section of Object.values(sections)) {
    section.sort((left, right) => compareText(left.key, right.key));
  }

  const includedEvidenceIds = new Set<string>();
  for (const section of Object.values(sections)) {
    for (const item of section) {
      for (const reference of item.evidence) {
        includedEvidenceIds.add(reference.evidenceId);
      }
    }
  }
  const unresolvedEvidenceIds = bundle.unknowns
    .filter(({ id, source }) => {
      if (source === undefined) return true;
      const reason = exclusionReason(source.file);
      if (reason === null) return true;
      excludedEvidence.set(id, reason);
      return false;
    })
    .map(({ id }) => id)
    .sort(compareText);
  for (const id of unresolvedEvidenceIds) includedEvidenceIds.add(id);

  const payload = {
    schemaVersion: CURRENT_DESIGN_SYSTEM_SCHEMA_VERSION,
    source: {
      evidenceFingerprint: bundle.contentFingerprint,
      workingTreeFingerprint: bundle.snapshot.workingTreeFingerprint,
    },
    sections,
    unresolvedEvidenceIds,
    coverage: {
      includedEvidenceIds: [...includedEvidenceIds].sort(compareText),
      excludedEvidence: [...excludedEvidence.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([evidenceId, reasonCode]) => ({ evidenceId, reasonCode })),
      limitations: [
        "Confidence is ordinal static evidence support, not runtime correctness or a probability.",
        "Unbound UNKNOWN scopes and unscanned runtime behavior are not item-completeness guarantees.",
        "Dynamic and unverified class-helper semantics remain unresolved evidence.",
        "Test, story, generated, and vendored evidence is excluded from recovered production sections.",
        "Semantic roles require an exact supported name, compatible value syntax, and global selector scope.",
      ],
    },
  };
  const system = currentDesignSystemSchema.parse({
    ...payload,
    contentFingerprint: createRecoveryContentFingerprint(payload),
  });

  const evidenceIds = new Set([
    ...bundle.observations.map(({ id }) => id),
    ...bundle.inferences.map(({ id }) => id),
    ...bundle.unknowns.map(({ id }) => id),
  ]);
  for (const item of Object.values(system.sections).flat()) {
    for (const reference of item.evidence) {
      if (!evidenceIds.has(reference.evidenceId)) {
        throw new Error(`Recovery references missing evidence: ${reference.evidenceId}`);
      }
    }
  }
  for (const id of system.unresolvedEvidenceIds) {
    if (!evidenceIds.has(id)) {
      throw new Error(`Recovery references missing unresolved evidence: ${id}`);
    }
  }
  for (const id of system.coverage.includedEvidenceIds) {
    if (!evidenceIds.has(id)) {
      throw new Error(`Recovery coverage references missing evidence: ${id}`);
    }
  }
  for (const { evidenceId } of system.coverage.excludedEvidence) {
    if (!evidenceIds.has(evidenceId)) {
      throw new Error(`Recovery exclusion references missing evidence: ${evidenceId}`);
    }
  }

  return assessRecoveredSystem(bundle, deepFreeze(system));
}
