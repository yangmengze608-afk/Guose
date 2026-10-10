import { describe, expect, it } from "vitest";
import { designBriefDecisionSchema, designBriefSchema } from "../src/schemas/index.js";

function brief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: "降低模板化 AI 视觉感，改成克制的现代东方风格",
    style: "modern_chinese",
    keywords: ["克制", "安静", "高级", "现代"],
    traditionalStrength: 0.4,
    preserve: ["layout", "logo", "content-structure"],
    modify: ["palette", "radius", "shadow", "spacing", "button", "card"],
    avoid: ["calligraphy-font", "gold", "large-red-areas", "traditional-patterns", "ink-background"],
    scope: { type: "page", targets: ["home"] },
    intensity: "medium",
    allowLayoutChange: false,
    ...overrides,
  };
}

describe("DesignBrief authored intent", () => {
  it("accepts the user's complete sample without inventing evidence or approval", () => {
    expect(designBriefSchema.parse(brief())).toEqual(brief());
  });

  it("accepts component scope and a non-Chinese style without defaults", () => {
    const input = brief({ style: "blue_purple", traditionalStrength: 0,
      scope: { type: "component", targets: ["Button/default", "Card"] } });
    expect(designBriefSchema.parse(input)).toEqual(input);
  });

  it("preserves unresolved questions rather than treating validity as readiness", () => {
    const input = brief({ unresolvedQuestions: ["是否允许改变字体？"] });
    expect(designBriefSchema.parse(input).unresolvedQuestions).toEqual(["是否允许改变字体？"]);
  });

  it("accepts explicit empty restrictions and maximum traditional intent", () => {
    expect(designBriefSchema.safeParse(brief({ preserve: [], avoid: [], traditionalStrength: 1 })).success).toBe(true);
  });

  it("does not resolve a syntactically valid target into a code fact", () => {
    const parsed = designBriefSchema.parse(brief({ scope: { type: "component", targets: ["not-yet-resolved"] } }));
    expect(parsed.scope).toEqual({ type: "component", targets: ["not-yet-resolved"] });
    expect(parsed).not.toHaveProperty("approved");
    expect(parsed).not.toHaveProperty("evidence");
  });

  it("trims input without mutating the original object", () => {
    const input = brief({ goal: "  克制  ", keywords: [" 安静 "], scope: { type: "page", targets: [" home "] } });
    const parsed = designBriefSchema.parse(input);
    expect(parsed.goal).toBe("克制");
    expect(parsed.keywords).toEqual(["安静"]);
    expect(parsed.scope.targets).toEqual(["home"]);
    expect(input.goal).toBe("  克制  ");
  });

  it.each(["goal", "style", "keywords", "traditionalStrength", "preserve", "modify", "avoid", "scope", "intensity", "allowLayoutChange"])(
    "rejects missing %s rather than supplying intent", (key) => {
      const input = brief();
      delete input[key];
      expect(designBriefSchema.safeParse(input).success).toBe(false);
    },
  );

  it.each([
    { goal: "   " }, { style: " " }, { keywords: [] }, { modify: [] },
    { scope: { type: "page", targets: [] } },
    { scope: { type: "repository", targets: ["all"] } },
    { scope: { type: "component", targets: [" "] } },
    { intensity: "automatic" }, { allowLayoutChange: "false" },
    { traditionalStrength: -0.1 }, { traditionalStrength: 1.1 },
    { traditionalStrength: "0.4" }, { traditionalStrength: Number.NaN },
    { traditionalStrength: Number.POSITIVE_INFINITY },
    { keywords: ["calm", " CALM "] },
    { scope: { type: "page", targets: ["home", "HOME"] } },
    { avoid: Array.from({ length: 33 }, (_, index) => `avoid-${index}`) },
    { goal: "x".repeat(2001) }, { style: "x".repeat(101) },
    { preserve: ["x".repeat(201)] },
    { unresolvedQuestions: [""] },
  ])("rejects incomplete, unbounded or malformed intent: %j", (override) => {
    expect(designBriefSchema.safeParse(brief(override)).success).toBe(false);
  });

  it.each([
    { preserve: ["radius"], modify: [" Radius "] },
    { preserve: ["gold"], avoid: ["gold"] },
    { modify: ["gold"], avoid: ["GOLD"] },
    { preserve: ["logo"], modify: ["LAYOUT"], allowLayoutChange: false },
    { preserve: ["Layout"], allowLayoutChange: true },
  ])("reports explicit conflicts without choosing for the user: %j", (override) => {
    const parsed = designBriefSchema.safeParse(brief(override));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.code === "custom")).toBe(true);
    }
  });

  it("permits explicit layout intent when not contradicted", () => {
    expect(designBriefSchema.safeParse(brief({ preserve: ["logo"], modify: ["layout"], allowLayoutChange: true })).success).toBe(true);
  });

  it.each([
    { approved: true }, { status: "OBSERVED" }, { evidence: ["source:1"] },
    { execute: "npm run deploy" },
    { scope: { type: "page", targets: ["home"], root: "/tmp/project" } },
  ])("rejects extra evidence/authority fields: %j", (override) => {
    expect(designBriefSchema.safeParse(brief(override)).success).toBe(false);
  });

  it.each(["CONFIRM", "EDIT", "CANCEL"])("accepts %s as decision vocabulary only", (decision) => {
    expect(designBriefDecisionSchema.parse(decision)).toBe(decision);
  });

  it.each(["APPROVE", "confirmed", true, { decision: "CONFIRM", execute: true }])(
    "rejects non-Brief decision values: %j", (decision) => {
      expect(designBriefDecisionSchema.safeParse(decision).success).toBe(false);
    },
  );
});
