import assert from "node:assert/strict";

/** @param {string} input */
export function parseOperationClassification(input) {
  const classification = input.trim().toUpperCase();
  assert(["CORRECT", "REASONABLE"].includes(classification), "Plan not approved.");
  return classification;
}

/** @param {string} input @param {string} token */
export function assertConfirmation(input, token) {
  assert.equal(input.trim(), token, "Cancelled.");
}
