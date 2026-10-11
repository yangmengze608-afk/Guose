import { describe, expect, it } from "vitest";
import { assertConfirmation, parseOperationClassification } from "../scripts/public-demo-input.mjs";

describe("public demo human input normalization", () => {
  it.each([
    ["CORRECT", "CORRECT"],
    [" CORRECT ", "CORRECT"],
    ["reasonable", "REASONABLE"],
    [" REASONABLE", "REASONABLE"],
  ])("accepts classification %j as %s", (input, expected) => {
    expect(parseOperationClassification(input)).toBe(expected);
  });

  it.each(["YES", "", "   ", "OTHER", "CORRECT REASONABLE", "CORRECT extra"])("rejects classification %j", input => {
    expect(() => parseOperationClassification(input)).toThrow("Plan not approved.");
  });

  const token = "APPROVE PLAN sha256:0123456789abcdef";
  it.each([token, ` ${token} `, `\t${token}\n`])("accepts exact confirmation with outer whitespace %j", input => {
    expect(() => assertConfirmation(input, token)).not.toThrow();
  });

  it.each(["YES", "", "APPROVE PLAN sha256:wrong", token.toLowerCase(), token.replace("PLAN ", "PLAN  "), `${token} extra`])("rejects non-exact confirmation %j", input => {
    expect(() => assertConfirmation(input, token)).toThrow("Cancelled.");
  });

  it("does not normalize the expected token", () => {
    expect(() => assertConfirmation(token, ` ${token} `)).toThrow("Cancelled.");
  });
});
