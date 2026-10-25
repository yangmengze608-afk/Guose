import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFile, writeFile, lstat, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { detectRepository } from "../src/repo/index.js";
import { authorizeDemoExecution, executeApprovedPlan, undoExecution, cleanupExecution } from "../src/execution/index.js";
import { auditEmittedCss, assertMutationAllowlist, materializePlan } from "../src/execution/emitter.js";
import { compileTransformationPlan, type CompileTransformationRequest } from "../src/transformation/compiler.js";
import type { TransformationPlan } from "../src/transformation/schema.js";
import { createBundleContentFingerprint as fp, hashContent } from "../src/utils/content-hash.js";

const fault = vi.hoisted(() => ({ cssWrite: false, sourceSnapshot: false, createdWorkspaces: [] as string[] }));
vi.mock("../src/execution/baseline.js", async importOriginal => {
  const baseline = await importOriginal<typeof import("../src/execution/baseline.js")>();
  return { ...baseline, readExecutionBaseline: async (root: string) => {
    const files = await baseline.readExecutionBaseline(root);
    if (fault.sourceSnapshot) files.set("index.html", (files.get("index.html") ?? "") + "<!-- synthetic stale read -->");
    return files;
  } };
});
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, mkdtemp: async (prefix: string) => {
    const directory = await fs.mkdtemp(prefix);
    if (fault.cssWrite && prefix.endsWith("guose-static-verify-")) fault.createdWorkspaces.push(directory);
    return directory;
  }, open: (...args: Parameters<typeof fs.open>) => {
    if (fault.cssWrite && String(args[0]).endsWith("/guose-p2-home.css")) throw new Error("synthetic write failure after Home mutation");
    return fs.open(...args);
  } };
});
let request: CompileTransformationRequest, plan: TransformationPlan, human: unknown;
const read = async (p: string) => JSON.parse(await readFile(p, "utf8")) as unknown;
beforeAll(async () => {
  const audit = await read("docs/validation/t2/design-brief-approval.json") as { receipt: CompileTransformationRequest["briefApproval"] };
  // Synthetic test-only binding/review, portable across checkout paths. Not a
  // human approval event. Actual P2 demo script uses the real reviewed P1 plan.
  const bundle = await detectRepository("examples/guose-demo-app"), root = path.resolve("."), targetPath = "examples/guose-demo-app";
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const baselineCommit = git(["rev-parse", "HEAD"]), baselineTree = git(["rev-parse", `HEAD:${targetPath}`]);
  const binding = { status: "CONFIRMED_FOR_T3_PLANNING", targetConfirmed: true, planningAllowed: true, briefHash: audit.receipt.briefFingerprint,
    repoIdentity: { root, targetPath, identityHash: hashContent(`${root}\n${targetPath}`), baselineCommit, baselineTree },
    pageTarget: { logicalTarget: "guose-demo/home", entry: "src/pages/Home.tsx", selector: 'main[data-page="home"]' },
    scope: { allowed: audit.receipt.brief.modify, preserved: audit.receipt.brief.preserve, allowLayoutChange: false, protectedPaths: ["src/components/Navbar.tsx", "src/components/Footer.tsx"] },
    baseline: { workingTreeFingerprint: bundle.snapshot.workingTreeFingerprint, configHash: bundle.snapshot.configHash, evidenceFingerprint: bundle.contentFingerprint } };
  request = { briefApproval: audit.receipt, confirmedBinding: binding, expectedBriefHash: audit.receipt.briefFingerprint, expectedBindingHash: fp(binding), bundle };
  plan = await compileTransformationPlan(request);
  human = { status: "APPROVED", planHash: plan.contentFingerprint, briefHash: plan.source.briefHash, bindingHash: plan.source.bindingHash,
    target: binding.repoIdentity, operations: plan.operations.map((o, i) => ({ number: i + 1, id: o.id, type: o.type, role: o.target.role, humanClassification: "CORRECT" })) };
});
const input = () => ({ request, plan, humanReview: human, event: { decision: "EXECUTE_APPROVED_PLAN_IN_ISOLATED_DEMO" as const, displayedPlanHash: plan.contentFingerprint, actor: "synthetic-test-host-event-not-user-approval" } });
const rehash = (p: TransformationPlan) => { const { contentFingerprint: _old, ...data } = p; void _old; p.contentFingerprint = fp(data); return p; };

describe("trusted-demo isolated scoped executor", () => {
  it("rejects unapproved human plan", async () => {
    await expect(authorizeDemoExecution({ ...input(), humanReview: { ...(human as object), status: "PENDING" } })).rejects.toThrow();
  });
  it("requires an explicit current execution event", async () => {
    await expect(authorizeDemoExecution({ ...input(), event: { ...input().event, actor: "" } })).rejects.toThrow("UNAPPROVED_EXECUTION");
  });
  it("rejects tampered after value without matching hash", async () => {
    const p = structuredClone(plan); p.operations.find(op => op.type === "SECTION_SPACING")!.after.declarations["padding-top"] = "999px";
    await expect(authorizeDemoExecution({ ...input(), plan: p })).rejects.toThrow("Plan hash mismatch");
  });
  it("rejects rehashed stale plan even when caller changes displayed hash", async () => {
    const p = structuredClone(plan); p.operations.find(op => op.type === "SECTION_SPACING")!.after.declarations["padding-top"] = "999px"; rehash(p);
    await expect(authorizeDemoExecution({ ...input(), plan: p, event: { ...input().event, displayedPlanHash: p.contentFingerprint } })).rejects.toThrow("STALE_PLAN_REVIEW");
  });
  it.each(["button", "escape", "important", "protected"])("rejects %s mutation", async kind => {
    const p = structuredClone(plan);
    if (kind === "button") p.operations[0]!.target.selector = "button";
    if (kind === "escape") p.operations[0]!.target.selector = `${p.scopeProposal.selector}+button`;
    if (kind === "important") p.operations[0]!.after.declarations.padding = "12px !important";
    if (kind === "protected") p.operations[0]!.targetFile = "src/components/Navbar.tsx";
    await expect(authorizeDemoExecution({ ...input(), plan: rehash(p) })).rejects.toThrow();
  });
  it("rejects stale source snapshot identity", async () => {
    const b = structuredClone(request.confirmedBinding) as { baseline: { workingTreeFingerprint: string } };
    b.baseline.workingTreeFingerprint = `sha256:${"0".repeat(64)}`;
    await expect(authorizeDemoExecution({ ...input(), request: { ...request, confirmedBinding: b } })).rejects.toThrow("STALE_BINDING");
  });
  it("rechecks opaque runtime bytes after authorization, before any copy", async () => {
    const auth = await authorizeDemoExecution(input()); fault.sourceSnapshot = true;
    try { await expect(executeApprovedPlan(auth)).rejects.toThrow("STALE_EXECUTION_SOURCE"); }
    finally { fault.sourceSnapshot = false; }
  });
  it("does not grant execution for an arbitrary third-party target", async () => {
    const b = structuredClone(request.confirmedBinding) as { repoIdentity: { root: string; targetPath: string } };
    b.repoIdentity.targetPath = "tests/fixtures/transformation-project";
    await expect(authorizeDemoExecution({ ...input(), request: { ...request, confirmedBinding: b } })).rejects.toThrow("TRUSTED_DEMO_ONLY");
  });
  it("rejects a third source file and declarations without operations", () => {
    expect(() => assertMutationAllowlist(["src/components/ui/button.tsx"])).toThrow("THIRD_FILE_MUTATION");
    expect(() => auditEmittedCss("button { color: red }", plan, [])).toThrow("CSS_DECLARATION_WITHOUT_OPERATION");
    expect(() => auditEmittedCss("/* guose-op:missing */ button { color: red }", plan, [])).toThrow();
  });
  it("skips unknown ownership rather than interpreting CVA runtime", async () => {
    const source = await readFile("examples/guose-demo-app/src/pages/Home.tsx", "utf8");
    const output = materializePlan(plan, source);
    expect(output.results.filter(r => r.status === "APPLIED")).toHaveLength(4);
    expect(output.results.filter(r => r.status === "SKIPPED_UNKNOWN")).toHaveLength(34);
    expect(output.results.filter(r => r.status === "SKIPPED_SCOPE")).toHaveLength(1);
    expect(output.css).not.toContain("border-radius");
    expect(output.results.filter(r => r.reason.includes("color pairing"))).toHaveLength(4);
    expect(output.css).not.toMatch(/(?:^|[;{\s])color:/u);
    expect(output.results.filter(r => r.status === "SKIPPED_UNKNOWN").every(r => r.reason.includes("EXECUTION_UNRESOLVED"))).toBe(true);
  });
  it("serialized capabilities cannot execute", async () => {
    const auth = await authorizeDemoExecution(input());
    await expect(executeApprovedPlan(JSON.parse(JSON.stringify(auth)) as typeof auth)).rejects.toThrow("UNAPPROVED");
  });
  it("execution authorization expires instead of becoming indefinite authority", async () => {
    const auth = await authorizeDemoExecution(input()), now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 300_001);
    try { await expect(executeApprovedPlan(auth)).rejects.toThrow("EXPIRED"); }
    finally { clock.mockRestore(); }
  });
  it("undo refuses a replaced ownership marker", async () => {
    const r = await executeApprovedPlan(await authorizeDemoExecution(input()));
    const marker = path.join(path.dirname(r.workspace), ".guose-owned"), original = await readFile(marker, "utf8");
    await writeFile(marker, "synthetic tamper");
    await expect(undoExecution(r)).rejects.toThrow("WORKSPACE_CONTAINMENT_FAILED");
    await writeFile(marker, original); await undoExecution(r); expect(await cleanupExecution(r)).toBe("REMOVED");
  });
  it("undo rejects a symlink substituted for generated CSS", async () => {
    const r = await executeApprovedPlan(await authorizeDemoExecution(input()));
    const css = path.join(r.workspace, "src/styles/guose-p2-home.css"), original = await readFile(css, "utf8");
    await unlink(css); await symlink("../pages/Home.tsx", css);
    await expect(undoExecution(r)).rejects.toThrow("UNSAFE_WORKSPACE_ENTRY");
    await unlink(css); await writeFile(css, original); await undoExecution(r); expect(await cleanupExecution(r)).toBe("REMOVED");
  });
  it("executes deterministically twice, verifies minimal diff, undoes and cleans up", async () => {
    const receipts = [];
    for (let i = 0; i < 2; i++) {
      const auth = await authorizeDemoExecution(input()), receipt = await executeApprovedPlan(auth);
      receipts.push(receipt);
      expect(receipt.modifiedFiles).toEqual(["src/pages/Home.tsx", "src/styles/guose-p2-home.css"]);
      expect(receipt.diff).not.toContain("/Users/");
      expect(receipt.diff).not.toContain("package.json");
      await expect(executeApprovedPlan(auth)).rejects.toThrow("UNAPPROVED");
      expect((await undoExecution(receipt)).baselineHash).toBe(receipt.baselineHash);
      expect(await cleanupExecution(receipt)).toBe("REMOVED");
    }
    expect(receipts[0]!.diffHash).toBe(receipts[1]!.diffHash);
    expect(receipts[0]!.sourceHashes).toEqual(receipts[1]!.sourceHashes);
    expect(receipts[0]!.workspaceHash).toBe(receipts[1]!.workspaceHash);
  });
  it("undo refuses later edits without overwriting user bytes", async () => {
    const r = await executeApprovedPlan(await authorizeDemoExecution(input()));
    const p = path.join(r.workspace, "src/pages/Home.tsx"), emitted = await readFile(p, "utf8");
    const userEdit = emitted + "\n// synthetic later user edit\n";
    await writeFile(p, userEdit);
    await expect(undoExecution(r)).rejects.toThrow("STOP_AND_REQUEST_DIRECTION");
    expect(await readFile(p, "utf8")).toBe(userEdit);
    // Explicit test-owner restoration, never executor silently overwriting a user edit.
    await writeFile(p, emitted); await undoExecution(r); expect(await cleanupExecution(r)).toBe("REMOVED");
  });
  it("partial write failure discards only the newly owned workspace atomically", async () => {
    const auth = await authorizeDemoExecution(input());
    fault.createdWorkspaces.length = 0;
    fault.cssWrite = true;
    try { await expect(executeApprovedPlan(auth)).rejects.toThrow("atomicity=PASS"); }
    finally { fault.cssWrite = false; }
    expect(fault.createdWorkspaces).toHaveLength(1);
    await expect(lstat(fault.createdWorkspaces[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
