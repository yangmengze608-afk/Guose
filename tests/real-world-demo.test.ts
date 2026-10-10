import path from "node:path";
import { expect, it } from "vitest";
import { detectRepository } from "../src/repo/index.js";
import { loadStylePack } from "../src/style-packs/index.js";
import { generateDryRunPatch } from "../src/patch/index.js";
import { verifyMigration } from "../src/verification/index.js";

it("reports the authored demo's contrast failure without editing dynamic or unrelated source", async () => {
  const root = path.resolve("examples/demo-react-tailwind"), bundle = await detectRepository(root), pack = await loadStylePack("neutral-modern");
  expect(bundle.unknowns.some(({ kind }) => kind === "dynamic_tailwind_class")).toBe(true);
  const patch = await generateDryRunPatch(bundle, pack);
  // Only the same-selector color anchor; unrelated background remains raw.
  expect(patch.files).toHaveLength(1);
  expect(patch.files[0]?.file).toBe("src/styles.css");
  expect(patch.files[0]?.edits).toHaveLength(1);
  const result = await verifyMigration(bundle, pack);
  expect(result.checks.some(({ id, status }) => id.includes("contrast") && status === "FAIL")).toBe(true);
  expect(result.result).toBe("FAILED");
  expect(result.executionCount).toBe(0);
  expect(result.isolation.cleanup).toBe("REMOVED");
  expect((await detectRepository(root)).contentFingerprint).toBe(bundle.contentFingerprint);
});
