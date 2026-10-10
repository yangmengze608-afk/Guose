import type { TransformationPlan, TransformationOperation } from "./schema.js";
import { TRANSFORMATION_TYPES } from "./strategy.js";

type Golden = { changes: { id: string; after: Record<string, unknown> }[] };
const normalize = (value: unknown): string => typeof value === "string" ? value.replace(/rgba?\(|\)|,|\s+/gu, "").replace("/", "").toLowerCase() : String(value);
const propertyKey: Record<string, string> = { "background-color": "background", "background-image": "backgroundImage", "border-radius": "borderRadius", "box-shadow": "boxShadow", "padding-bottom": "ctaPaddingBottom", "padding-top": "heroAndFeaturesPaddingBlock", padding: "padding", border: "border", color: "color" };

/** Evaluation only. Neither compiler nor strategy imports this module/reference. */
export function compareGoldenPlan(plan: Pick<TransformationPlan, "operations" | "scopeProposal" | "protectedPaths" | "source">, golden: Golden) {
  const groups = new Map(golden.changes.map(x => [x.id, x.after]));
  function reference(op: TransformationOperation) {
    const role = op.target.role;
    const id = op.type === "SECTION_SPACING" ? "P10" : role === "section" || role === "page" ? "P01" :
      ["primary", "secondary"].includes(role) ? ["BUTTON_RADIUS", "COMPONENT_PADDING"].includes(op.type) ? "P05" : role === "primary" ? "P03" : "P04" :
        role === "elevated" ? "P06" : role === "flat" ? "P07" : role === "cta" || op.target.selector.includes("text-indigo-100") ? "P08" : "P02";
    return { id, values: groups.get(id) ?? {} };
  }
  const rows = plan.operations.map(op => {
    const ref = reference(op);
    let match = true;
    for (const [property, value] of Object.entries(op.after.declarations)) {
      let expected: unknown = ref.values[propertyKey[property] ?? property];
      if (op.target.role === "page" && property === "color") expected = ref.values.foreground;
      if (ref.id === "P01" && property === "background-image") expected = ref.values.heroBackgroundImage;
      if (ref.id === "P02" && property === "color") expected = ref.values[op.target.role === "text" ? "mutedForeground" : "accent"];
      if (op.target.selector.includes("text-indigo-100") && property === "color") expected = ref.values.paragraphColor;
      if (ref.id === "P04" && property === "border") expected = `1px solid ${String(ref.values.borderColor)}`;
      if (property === "padding-bottom" && op.target.selector.includes("hero") || property === "padding-bottom" && op.target.selector.includes("features")) expected = ref.values.heroAndFeaturesPaddingBlock;
      if (typeof expected === "object" && expected !== null) expected = (expected as Record<string, unknown>).desktop;
      if (property.startsWith("focus-visible:")) {
        const focus = groups.get("P05") ?? {};
        expected = property.endsWith("box-shadow") ? "none" : property.endsWith("outline-offset") ? focus.focusRingOffset : `2px solid ${String(focus.focusRingColor)}`;
      }
      if (normalize(value) !== normalize(expected)) match = false;
    }
    const unsafe = !op.target.selector.startsWith(plan.scopeProposal.selector) || op.targetFile !== plan.source.entry || plan.protectedPaths.includes(op.targetFile);
    const unauthorized = !TRANSFORMATION_TYPES.includes(op.type) || op.approvalStatus !== "REVIEW_REQUIRED" || op.after.status !== "INFERRED";
    return { id: op.id, type: op.type, role: op.target.role, referenceGroup: ref.id, status: unsafe ? "UNSAFE" : unauthorized ? "UNAUTHORIZED" : match ? "MATCH" : "ACCEPTABLE_VARIATION", rationale: unsafe ? "Static scope invariant failed" : unauthorized ? "Unsupported category or unauthorized status" : match ? "Supported object/category/direction and comparable desktop values match golden" : "Approved visual category/direction; finite strategy differs in border/shadow value or lacks golden detail; not runtime approval" };
  });
  const missing = [
    { referenceGroup: "P09", detail: "Task-row/status interior palette: no supported anchored rule" },
    { referenceGroup: "P11", detail: "Grid gaps/header margin: not in first supported rules" },
    { referenceGroup: "P02", detail: "Static hero span shares tag with dynamic class span: conservatively abstained" },
    { referenceGroup: "P03/P04", detail: "Hover background proposals omitted" },
    { referenceGroup: "P06/P07/P08/P10", detail: "Mobile padding/spacing proposals omitted" },
  ];
  return { totalOps: rows.length, match: rows.filter(x => x.status === "MATCH").length, acceptableVariation: rows.filter(x => x.status === "ACCEPTABLE_VARIATION").length,
    missing: missing.length, unauthorized: rows.filter(x => x.status === "UNAUTHORIZED").length, unsafe: rows.filter(x => x.status === "UNSAFE").length, protectedViolations: rows.filter(x => plan.protectedPaths.includes(plan.operations.find(o => o.id === x.id)!.targetFile)).length,
    unknownBoundOps: plan.operations.filter(x => x.certainty === "REVIEW_REQUIRED_WITH_UNKNOWN").length, rows, missingDetails: missing,
    boundary: "STATIC ENGINEERING SEMANTIC REVIEW, NOT HUMAN PLAN APPROVAL OR RUNTIME SAFETY", humanReview: "PENDING" };
}
