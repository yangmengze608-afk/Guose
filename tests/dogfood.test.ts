import path from "node:path";
import { expect, it } from "vitest";
import { detectRepository } from "../src/repo/index.js";
import { recoverDesignSystem } from "../src/recovery/index.js";
import { planMigration } from "../src/planner/index.js";
import { generateDryRunPatch } from "../src/patch/index.js";
import { verifyMigration } from "../src/verification/index.js";
import { loadStylePack } from "../src/style-packs/index.js";
import { assessArtifactFreshness } from "../src/staleness/index.js";

it("dogfoods the authored fixture with a real dry-run operation and unchanged source", async () => {
  const root = path.resolve("examples/dogfood"), bundle = await detectRepository(root), pack = await loadStylePack("neutral-modern");
  const recovered = recoverDesignSystem(bundle), plan = planMigration(bundle, pack), patch = await generateDryRunPatch(bundle, pack), verification = await verifyMigration(bundle, pack);
  expect(bundle.repository.supportStatus).toBe("SUPPORTED");
  expect(recovered.sections.semanticTokens.length).toBeGreaterThan(0);
  expect(bundle.unknowns.some(({ kind }) => kind === "dynamic_tailwind_class")).toBe(true);
  expect(bundle.unknowns.some(({ kind }) => kind === "tailwind_class_semantics")).toBe(false);
  for (const role of ["primary-foreground", "destructive-foreground"]) {
    expect(recovered.sections.semanticTokens.find(({ key }) => key === `role:${role}`)?.status).toBe("INFERRED");
    expect(plan.items.find(({ current }) => current.includes(`text-${role}`))?.kind).toBe("UNCHANGED_SEMANTIC_USAGE");
  }
  expect(plan.summary.autoSafe).toBe(0);
  expect(patch.files).toHaveLength(1);
  expect(patch.files[0]?.file).toBe("src/styles.css");
  expect(verification.result).toBe("PARTIALLY_VERIFIED");
  expect(verification.verifiedOperations).toEqual(verification.plannedOperationIds);
  expect(verification.verifiedOperations).toHaveLength(1);
  expect(verification.executionCount).toBe(0);
  expect(verification.isolation.cleanup).toBe("REMOVED");
  const current = await detectRepository(root);
  expect(current.contentFingerprint).toBe(bundle.contentFingerprint);
  expect(assessArtifactFreshness("verification", verification, bundle, current, pack).status).toBe("FRESH");
});
