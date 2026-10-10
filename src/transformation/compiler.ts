import path from "node:path";
import { realpath } from "node:fs/promises";
import type { BriefApprovalReceipt } from "../intent/brief-review.js";
import { detectRepository, readValidatedRepository } from "../repo/detect.js";
import { readExactSource } from "../verification/workspace.js";
import { recoverDesignSystem } from "../recovery/index.js";
import { createBundleContentFingerprint, hashContent } from "../utils/content-hash.js";
import { deepFreeze } from "../utils/deep-freeze.js";
import { designBriefSchema, type ReadonlyEvidenceBundle } from "../schemas/index.js";
import { modernEasternDemoStrategy as strategy, transformationRules } from "./strategy.js";
import { planningBindingSchema, transformationPlanSchema, type TransformationOperation, type TransformationPlan } from "./schema.js";
import { resolveScopedTargets, type ScopedTarget } from "./targets.js";

export interface CompileTransformationRequest {
  briefApproval: BriefApprovalReceipt;
  confirmedBinding: unknown;
  expectedBriefHash: string;
  expectedBindingHash: string;
  bundle: ReadonlyEvidenceBundle;
}

/** Receipts are audited design input, not executable capabilities. No writes,
 * patch generation, target evaluation or human events are created by this API. */
export async function compileTransformationPlan(request: CompileTransformationRequest): Promise<Readonly<TransformationPlan>> {
  const { briefApproval: receipt, bundle: input } = request;
  if (receipt.status !== "APPROVED" || receipt.scope !== "DESIGN_INTENT_ONLY") throw new Error("UNAPPROVED_BRIEF");
  const brief = designBriefSchema.parse(receipt.brief);
  const briefHash = createBundleContentFingerprint(brief), bindingHash = createBundleContentFingerprint(request.confirmedBinding);
  if (briefHash !== receipt.briefFingerprint || briefHash !== request.expectedBriefHash) throw new Error("STALE_BRIEF");
  if (bindingHash !== request.expectedBindingHash) throw new Error("STALE_BINDING");
  const binding = planningBindingSchema.parse(request.confirmedBinding);
  if (binding.briefHash !== briefHash || !brief.scope.targets.includes(binding.pageTarget.logicalTarget)) throw new Error("STALE_BINDING: intent target mismatch");
  if (brief.allowLayoutChange || brief.scope.type !== "page") throw new Error("UNSUPPORTED_SCOPE");
  const { bundle, root } = await readValidatedRepository(input);
  if (await realpath(path.resolve(binding.repoIdentity.root, binding.repoIdentity.targetPath)) !== root ||
    binding.repoIdentity.identityHash !== hashContent(`${binding.repoIdentity.root}\n${binding.repoIdentity.targetPath}`)) throw new Error("STALE_BINDING: repository identity mismatch");
  if (bundle.contentFingerprint !== binding.baseline.evidenceFingerprint || bundle.snapshot.workingTreeFingerprint !== binding.baseline.workingTreeFingerprint || bundle.snapshot.configHash !== binding.baseline.configHash) throw new Error("STALE_BINDING: evidence identity mismatch");
  if ((await detectRepository(root)).contentFingerprint !== bundle.contentFingerprint) throw new Error("STALE_BINDING: current repository changed");
  if (bundle.snapshot.gitStateReason === "GIT_UNAVAILABLE") throw new Error("UNKNOWN_FRESHNESS");
  const sources = new Map<string, string>();
  for (const file of bundle.snapshot.files.filter(f => /\.[jt]sx?$/u.test(f.path))) sources.set(file.path, await readExactSource(root, file.path, file.digest));
  const entry = binding.pageTarget.entry;
  if (binding.scope.protectedPaths.includes(entry)) throw new Error("REJECTED_PROTECTED_SCOPE");
  const marker = `page-${hashContent(`${binding.repoIdentity.identityHash}:${entry}`).slice(7, 19)}`;
  if ([...sources.values()].some(text => text.includes(`data-guose-page="${marker}"`))) throw new Error("UNRESOLVED_SCOPE: proposed marker already present");
  const rootSelector = `[data-guose-page="${marker}"]`;
  const resolved = resolveScopedTargets(bundle, sources, entry, binding.pageTarget.selector, rootSelector, binding.scope.protectedPaths);
  const recovered = recoverDesignSystem(bundle);
  const unknownIds = bundle.unknowns.map(u => u.id).sort();
  const operations: TransformationOperation[] = [];
  const abstentions = [...resolved.abstentions];
  const preserved = new Set([...brief.preserve, ...binding.scope.preserved].map(s => s.toLowerCase()));
  const allowed = new Set(binding.scope.allowed), modifies = new Set(brief.modify);
  const compatible = strategy.compatibleStyles.includes(brief.style) && brief.traditionalStrength <= 0.3;
  const used = new Set<string>();
  for (const target of resolved.targets) {
    for (const rule of transformationRules) {
      const domain = ["primary", "secondary"].includes(target.role) ? "button" : ["elevated", "flat", "cta"].includes(target.role) ? "card" : null;
      if ((domain !== null && preserved.has(domain)) || !rule.intent.every(d => modifies.has(d) && allowed.has(d)) || rule.dimensions.some(d => preserved.has(d))) continue;
      if (!compatible) { abstentions.push({ status: "ABSTAIN", identity: target.identity, reason: "STYLE_STRATEGY does not support this explicit aesthetic intent", evidenceIds: target.evidenceIds, source: target.source }); break; }
      if (brief.intensity !== "high" && rule.type !== "CARD_SHADOW") continue;
      const value = proposal(target, rule.type, brief.intensity);
      if (!value) continue;
      if (preserved.has("palette") && /#|rgb\(/u.test(value)) continue;
      const declarations: Record<string, string> = { [rule.property]: value };
      if ((rule.type === "PAGE_BACKGROUND" || rule.type === "CTA_BACKGROUND") && brief.avoid.some(x => /gradient/u.test(x))) declarations["background-image"] = "none";
      if (rule.type === "SECTION_SPACING") {
        delete declarations["padding-block"];
        if (target.classes.some(c => /^py-\d+$/u.test(c))) { declarations["padding-top"] = value; declarations["padding-bottom"] = value; }
        else if (target.classes.some(c => /^pb-\d+$/u.test(c))) declarations["padding-bottom"] = value;
        else continue;
      }
      // Shadow reduction must not remove the only keyboard indicator. The plan
      // explicitly proposes an independent focus outline, with no new palette.
      if (rule.type === "BUTTON_SHADOW") { declarations["focus-visible:box-shadow"] = "none"; declarations["focus-visible:outline"] = `2px solid ${strategy.palette.accent}`; declarations["focus-visible:outline-offset"] = "2px"; }
      const key = `${target.selector}:${rule.type}`;
      if (used.has(key)) continue;
      used.add(key);
      const peers = resolved.targets.filter(x => x.selector === target.selector && x.role === target.role);
      const ids = [...new Set(peers.flatMap(x => x.evidenceIds))].sort();
      const unknowns = bundle.unknowns.filter(u => ids.some(id => u.relatedEvidenceIds.includes(id))).map(u => u.id).sort();
      operations.push({
        id: `transform:${hashContent(key).slice(7)}`, type: rule.type, targetFile: entry,
        target: { identity: peers.map(x => x.identity).sort().join("|"), role: target.role, selector: target.selector, source: target.source },
        before: { status: target.component || unknowns.length ? "UNKNOWN" : "OBSERVED", authoredClasses: [...new Set(peers.flatMap(x => x.classes))].sort(), computedValue: null },
        after: { status: "INFERRED", declarations }, briefRequirement: [...rule.intent.map(x => `modify:${x}`), `intensity:${brief.intensity}`],
        repoEvidence: ids, conflictEvidence: unknowns,
        proposal: { source: "STYLE_STRATEGY", id: strategy.id, version: strategy.version, strategyHash: createBundleContentFingerprint(strategy), intensity: brief.intensity },
        scopeEvidence: { bindingHash, rootSource: resolved.rootSource, rootSelector, status: "INFERRED", method: "DIGEST_BOUND_AST_REPLAY" },
        certainty: target.component || unknowns.length ? "REVIEW_REQUIRED_WITH_UNKNOWN" : "STATIC_TEMPLATE_SUPPORTED", risk: target.component || unknowns.length ? "HIGH" : "MEDIUM",
        approvalStatus: "REVIEW_REQUIRED", patchability: "NOT_AUTHORIZED_REQUIRES_RUNTIME_SCOPE_CHECK", protectedRegionRelation: "PAGE_OVERRIDE_ONLY_SHARED_SOURCE_UNCHANGED", unknownIds: unknowns,
      });
    }
  }
  if (!compatible || brief.intensity !== "high") abstentions.push({ status: "ABSTAIN", identity: entry, reason: !compatible ? "Unsupported strategy intent" : "Low/medium intensity: abstain from high-intensity palette/radius/spacing; only supported weaker Card shadow proposal", evidenceIds: [] });
  for (const protectedPath of binding.scope.protectedPaths) abstentions.push({ status: "REJECTED_PROTECTED_SCOPE", identity: protectedPath, reason: "Inherited protected region; never a mutation target", evidenceIds: bundle.observations.filter(x => x.source.file === protectedPath).map(x => x.id) });
  for (const target of resolved.targets.filter(x => x.component)) {
    const shared = target.evidenceIds.map(id => bundle.observations.find(x => x.id === id)).find(x => x?.kind === "component_declaration");
    if (shared) abstentions.push({ status: "REJECTED_PROTECTED_SCOPE", identity: shared.source.file, reason: "Shared definition is evidence only: page-scoped override instead of shared source mutation", evidenceIds: [shared.id] });
  }
  if ((await detectRepository(root)).contentFingerprint !== input.contentFingerprint) throw new Error("STALE_BINDING: repository changed during compilation");
  const payload = {
    schemaVersion: "P1_TRANSFORMATION_PLAN_1" as const, status: "REVIEW_REQUIRED" as const,
    source: { briefHash, bindingHash, evidenceFingerprint: bundle.contentFingerprint, recoveryFingerprint: recovered.contentFingerprint, workingTreeFingerprint: bundle.snapshot.workingTreeFingerprint, entry },
    scopeProposal: { selector: rootSelector, attribute: "data-guose-page" as const, value: marker, targetSource: resolved.rootSource, status: "REVIEW_REQUIRED" as const, uniqueness: "STATIC_SOURCE_CHECKED_RUNTIME_UNVERIFIED" as const },
    strategy: { id: strategy.id, version: strategy.version, source: "STYLE_STRATEGY" as const, fingerprint: createBundleContentFingerprint(strategy) },
    operations: operations.sort((a, b) => a.id.localeCompare(b.id, "en")), abstentions, unknownIds, protectedPaths: binding.scope.protectedPaths,
    authority: "PLANNING_AUDIT_CONTENT_ONLY_NOT_EXECUTION_AUTHORITY" as const, executionAllowed: false as const,
    limitations: ["No target code, patch, CSS, workspace or After generated. Every operation needs separate human plan review.", "Before classes are literal templates, never computed CSS. cn/cva rendering and selector ownership remain runtime UNKNOWN.", "Snapshot-digest-bound source replay derives structure; EvidenceBundle remains the sole source identity and design evidence. No independent design fact store.", "STYLE_STRATEGY is an authored proposal, not a recovered fact. No probability or automatic execution approval.", "Responsive overrides, hover palette, layout gaps and unanchored text targets are outside this first compiler; do not guess them.", "Persisted approval/binding content validates planning input only; cannot restore live execution authority.", "Cross-route reuse, hostile concurrent filesystem confinement and runtime selector uniqueness are not established."],
  };
  const plan = transformationPlanSchema.parse({ ...payload, contentFingerprint: createBundleContentFingerprint(payload) });
  const evidenceIds = new Set(bundle.observations.map(x => x.id));
  if (plan.operations.some(op => op.repoEvidence.some(id => !evidenceIds.has(id)))) throw new Error("INVALID_PROVENANCE");
  return deepFreeze(plan);
}

function proposal(target: ScopedTarget, type: string, intensity: "low" | "medium" | "high"): string | null {
  const p = strategy.palette, role = target.role;
  if (type === "PAGE_BACKGROUND" && (role === "page" || (role === "section" && target.classes.some(c => c.startsWith("bg-gradient-"))))) return p.page;
  if (type === "TEXT_COLOR" && ["page", "text", "cta", "elevated", "flat"].includes(role)) return role === "text" ? p.secondary : p.text;
  if (type === "ACCENT_COLOR" && role === "accent") return p.accent;
  if (role === "primary" || role === "secondary") {
    if (type === "BUTTON_BACKGROUND") return role === "primary" ? p.accent : p.surface;
    if (type === "BUTTON_FOREGROUND") return role === "primary" ? p.white : p.accent;
    if (type === "BUTTON_RADIUS") return strategy.radius.button;
    if (type === "BUTTON_SHADOW") return "none";
    if (type === "BUTTON_BORDER") return `1px solid ${role === "primary" ? p.accent : p.buttonBorder}`;
    if (type === "COMPONENT_PADDING") return strategy.padding.button;
  }
  if (role === "elevated" || role === "flat" || role === "cta") {
    if (type === "CTA_BACKGROUND" && role === "cta") return p.soft;
    if (type === "CARD_BACKGROUND" && role !== "cta") return role === "elevated" ? p.elevated : p.surface;
    if (type === "CARD_RADIUS") return strategy.radius[role];
    if (type === "CARD_SHADOW") return intensity === "high" ? role === "elevated" ? strategy.shadow.elevated : strategy.shadow.flat : "0 1px 8px rgb(38 43 44 / 0.08)";
    if (type === "CARD_BORDER") return `1px solid ${p.border}`;
    if (type === "COMPONENT_PADDING") return strategy.padding[role];
  }
  if (type === "SECTION_SPACING" && role === "section") return strategy.sectionSpacing;
  return null;
}
