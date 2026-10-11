import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfirmation, parseOperationClassification } from "./public-demo-input.mjs";
import { detectRepository } from "../dist/repo/index.js";
import { createDesignBriefReview } from "../dist/intent/brief-review.js";
import { compileTransformationPlan } from "../dist/transformation/index.js";
import { authorizeDemoExecution, executeApprovedPlan, undoExecution, cleanupExecution } from "../dist/execution/index.js";
import { createBundleContentFingerprint as fingerprint, hashContent } from "../dist/utils/content-hash.js";

// Portable trusted-host adapter. Never loads historical target/plan approvals.
const root = fileURLToPath(new URL("..", import.meta.url));
const targetPath = "examples/guose-demo-app";
const read = async p => JSON.parse(await readFile(path.join(root, p), "utf8"));
const mode = process.argv[2];
if (!["--inspect", "--interactive"].includes(mode)) {
  process.stdout.write("Usage: npm run demo:workflow -- --inspect|--interactive\nInspect never approves or transforms. Interactive requires a human TTY.\n");
  if (mode && mode !== "--help") process.exitCode = 2;
} else {
  const markdown = await readFile(path.join(root, "docs/validation/t2/clarified-grill-session.md"), "utf8");
  const bindings = await read("docs/validation/t2/clarified-grill-bindings.json");
  const sample = await read("docs/validation/t2/design-brief-approval.json");
  const bundle = await detectRepository(path.join(root, targetPath));
  const review = createDesignBriefReview(markdown, bindings, "docs/validation/t2/clarified-grill-session.md", bundle);
  review.edit({ traditionalStrength: sample.receipt.brief.traditionalStrength, intensity: sample.receipt.brief.intensity });
  const draft = review.view().draft;
  process.stdout.write(JSON.stringify({ status: "DRAFT_REQUIRES_CURRENT_HUMAN_APPROVAL", sampleBrief: draft.brief,
    draftHash: draft.fingerprint, target: targetPath, page: "src/pages/Home.tsx", originalUnknowns: bundle.unknowns.length,
    planningAllowed: false, executionAllowed: false }, null, 2) + "\n");
  if (mode === "--interactive") {
    assert(process.stdin.isTTY && process.stdout.isTTY, "Human TTY required; piped approval is not supported.");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let receipt;
    const confirm = async token => assertConfirmation(await terminal.question(`Type exactly ${token} (anything else cancels): `), token);
    try {
      await confirm(`CONFIRM BRIEF ${draft.fingerprint}`);
      const briefApproval = review.decide("CONFIRM", { displayedDraftFingerprint: draft.fingerprint, sessionMarkdown: markdown,
        actor: "interactive-local-human", currentBundle: await detectRepository(path.join(root, targetPath)) }).receipt;
      assert(briefApproval);
      const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
      const baselineCommit = git(["rev-parse", "HEAD"]), baselineTree = git(["rev-parse", `HEAD:${targetPath}`]);
      const binding = { status: "CONFIRMED_FOR_T3_PLANNING", targetConfirmed: true, planningAllowed: true, briefHash: briefApproval.briefFingerprint,
        repoIdentity: { root, targetPath, identityHash: hashContent(`${root}\n${targetPath}`), baselineCommit, baselineTree },
        pageTarget: { logicalTarget: "guose-demo/home", entry: "src/pages/Home.tsx", selector: 'main[data-page="home"]' },
        scope: { allowed: briefApproval.brief.modify, preserved: briefApproval.brief.preserve, allowLayoutChange: false,
          protectedPaths: ["src/components/Navbar.tsx", "src/components/Footer.tsx"] },
        baseline: { workingTreeFingerprint: bundle.snapshot.workingTreeFingerprint, configHash: bundle.snapshot.configHash, evidenceFingerprint: bundle.contentFingerprint } };
      const bindingHash = fingerprint(binding);
      process.stdout.write(JSON.stringify(binding, null, 2) + "\n");
      await confirm(`CONFIRM TARGET ${bindingHash}`);
      const request = { briefApproval, confirmedBinding: binding, expectedBriefHash: briefApproval.briefFingerprint, expectedBindingHash: bindingHash, bundle };
      const plan = await compileTransformationPlan(request);
      process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
      const operations = [];
      for (const [i, op] of plan.operations.entries()) {
        const classification = parseOperationClassification(await terminal.question(`#${i + 1} ${op.id}: CORRECT or REASONABLE; anything else cancels: `));
        operations.push({ number: i + 1, id: op.id, type: op.type, role: op.target.role, humanClassification: classification });
      }
      await confirm(`APPROVE PLAN ${plan.contentFingerprint}`);
      const humanReview = { status: "APPROVED", planHash: plan.contentFingerprint, briefHash: plan.source.briefHash,
        bindingHash, target: binding.repoIdentity, operations };
      await confirm(`EXECUTE ISOLATED ${plan.contentFingerprint}`);
      receipt = await executeApprovedPlan(await authorizeDemoExecution({ request, plan, humanReview,
        event: { decision: "EXECUTE_APPROVED_PLAN_IN_ISOLATED_DEMO", displayedPlanHash: plan.contentFingerprint, actor: "interactive-local-human" } }));
      process.stdout.write(receipt.diff + "\n" + JSON.stringify({ workspace: receipt.workspace, results: receipt.results, diffHash: receipt.diffHash }, null, 2) + "\n");
      await terminal.question("Inspect diff; run trusted demo checks in a second terminal if desired. Press Enter to undo and clean up: ");
    } finally {
      terminal.close();
      if (receipt) {
        const undo = await undoExecution(receipt);
        process.stdout.write(JSON.stringify({ undo, cleanup: await cleanupExecution(receipt) }) + "\n");
      }
    }
  }
}
