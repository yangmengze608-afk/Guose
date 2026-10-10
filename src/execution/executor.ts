import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createStaticWorkspace, StaticWorkspaceFailure } from "../verification/workspace.js";
import { readSafeBytes } from "../repo/safety.js";
import { detectRepository } from "../repo/index.js";
import { hashContent } from "../utils/content-hash.js";
import { deepFreeze } from "../utils/deep-freeze.js";
import { consumeAuthorization, type ExecutionAuthorization } from "./authorization.js";
import { materializePlan, assertMutationAllowlist, HOME_FILE, CSS_FILE } from "./emitter.js";
import { executionFingerprint as fingerprint, readExecutionBaseline as manifest } from "./baseline.js";

const exec = promisify(execFile);
export type ExecutionReceipt = Readonly<{ schemaVersion: "P2_EXECUTION_1"; status: "READY"; executorVersion: "ScopedCssExecutor/1.0.0";
  planHash: string; workspace: string; baselineHash: string; workspaceHash: string; originalFingerprint: string;
  results: ReturnType<typeof materializePlan>["results"]; modifiedFiles: string[]; sourceHashes: Record<string, string>;
  diff: string; diffHash: string; atomicity: "PASS"; cssDeclarationWithoutOperation: "PASS"; executionReview: "CORRECTLY_APPLIED" }>;
type Session = { copy: Awaited<ReturnType<typeof createStaticWorkspace>>; baseline: Map<string, string>; expected: Map<string, string>; inode: number; device: number; markerDigest: string; undone: boolean; createdStyles: boolean };
const sessions = new WeakMap<object, Session>();
export class ExecutionFailure extends Error {
  readonly status = "FAILED";
  readonly atomicity: "PASS" | "FAIL_RETAINED_FOR_SAFETY";
  constructor(readonly cleanupStatus: "REMOVED" | "RETAINED_FOR_SAFETY", readonly failedOperationIds: string[], error: unknown) {
    super(`EXECUTION_FAILED; atomicity=${cleanupStatus === "REMOVED" ? "PASS" : "FAIL_RETAINED_FOR_SAFETY"}; ${error instanceof Error ? error.message : "unknown"}`, { cause: error });
    this.atomicity = cleanupStatus === "REMOVED" ? "PASS" : "FAIL_RETAINED_FOR_SAFETY";
  }
}
async function guard(s: Session) {
  const st = await lstat(s.copy.workspace);
  if (st.isSymbolicLink() || st.ino !== s.inode || st.dev !== s.device || await realpath(s.copy.workspace) !== s.copy.workspace) throw new Error("WORKSPACE_CONTAINMENT_FAILED");
  const marker = path.join(s.copy.container, ".guose-owned");
  if ((await lstat(marker)).isSymbolicLink() || hashContent(await readFile(marker)) !== s.markerDigest) throw new Error("WORKSPACE_CONTAINMENT_FAILED");
}
async function writeOwned(s: Session, file: string, source: string, expected?: string) {
  assertMutationAllowlist([file]); await guard(s);
  if (file === CSS_FILE && expected === undefined) {
    const src = path.join(s.copy.workspace, "src");
    if (await realpath(src) !== src || (await lstat(src)).isSymbolicLink()) throw new Error("WORKSPACE_CONTAINMENT_FAILED");
    try { await mkdir(path.join(src, "styles"), { mode: 0o700 }); s.createdStyles = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const parent = await realpath(path.dirname(path.join(s.copy.workspace, file)));
  if (!parent.startsWith(`${s.copy.workspace}${path.sep}`) || parent !== path.dirname(path.join(s.copy.workspace, file))) throw new Error("WORKSPACE_CONTAINMENT_FAILED");
  if (expected !== undefined && hashContent(await readSafeBytes(s.copy.workspace, file)) !== hashContent(expected)) throw new Error("STOP_AND_REQUEST_DIRECTION");
  const handle = await open(path.join(s.copy.workspace, file), constants.O_WRONLY | constants.O_NOFOLLOW | (expected === undefined ? constants.O_CREAT | constants.O_EXCL : constants.O_TRUNC), 0o600);
  try { await handle.writeFile(source, "utf8"); } finally { await handle.close(); }
}
async function unifiedDiff(before: string, after: string, file: string, added: boolean) {
  let output: string;
  try { output = (await exec("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", before, after], { maxBuffer: 2 * 1024 * 1024 })).stdout; }
  catch (error) { const e = error as { code?: number; stdout?: string }; if (e.code !== 1 || typeof e.stdout !== "string") throw error; output = e.stdout; }
  return output.split("\n").map(l => l.startsWith("diff --git ") ? `diff --git a/${file} b/${file}` : l.startsWith("--- ") ? `--- ${added ? "/dev/null" : `a/${file}`}` : l.startsWith("+++ ") ? `+++ b/${file}` : l).join("\n");
}
export async function executeApprovedPlan(capability: ExecutionAuthorization): Promise<ExecutionReceipt> {
  const state = await consumeAuthorization(capability);
  let copy: Awaited<ReturnType<typeof createStaticWorkspace>>;
  try { copy = await createStaticWorkspace(state.request.bundle); }
  catch (error) { if (error instanceof StaticWorkspaceFailure) throw new ExecutionFailure(error.cleanupStatus, state.plan.operations.map(o => o.id), error); throw error; }
  try {
    if (copy.excludedFiles.length || copy.sources.has(CSS_FILE)) throw new Error("UNSUPPORTED_BASELINE");
    // Complete the initial copy with non-analysis runtime files. This is byte
    // copying, not an operation or a third-file transformation mutation.
    for (const [file, source] of state.baseline) {
      if (copy.sources.has(file)) continue;
      const destination = path.join(copy.workspace, file);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, source, { flag: "wx", mode: 0o600 });
    }
    const info = await lstat(copy.workspace);
    const s: Session = { copy, baseline: new Map(state.baseline), expected: new Map(state.baseline), inode: info.ino, device: info.dev, markerDigest: hashContent(await readFile(path.join(copy.container, ".guose-owned"))), undone: false, createdStyles: false };
    const baselineHash = fingerprint(s.baseline);
    if (fingerprint(await manifest(copy.workspace)) !== baselineHash || state.request.bundle.snapshot.files.some(f => hashContent(s.baseline.get(f.path) ?? "") !== f.digest)) throw new Error("COPY_BYTE_IDENTITY_FAILED");
    const before = s.baseline.get(HOME_FILE);
    if (before === undefined) throw new Error("MISSING_HOME");
    const emitted = materializePlan(state.plan, before);
    assertMutationAllowlist([HOME_FILE, CSS_FILE]);
    await writeOwned(s, HOME_FILE, emitted.home, before);
    await writeOwned(s, CSS_FILE, emitted.css);
    s.expected.set(HOME_FILE, emitted.home); s.expected.set(CSS_FILE, emitted.css);
    const actual = await manifest(copy.workspace);
    if (fingerprint(actual) !== fingerprint(s.expected)) throw new Error("UNAUTHORIZED_WORKSPACE_MUTATION");
    const reference = path.join(copy.container, "baseline-home.txt");
    await writeFile(reference, before, { flag: "wx", mode: 0o600 });
    const diff = await unifiedDiff(reference, path.join(copy.workspace, HOME_FILE), HOME_FILE, false) + await unifiedDiff("/dev/null", path.join(copy.workspace, CSS_FILE), CSS_FILE, true);
    const root = (state.request.confirmedBinding as { repoIdentity: { root: string; targetPath: string } }).repoIdentity;
    if ((await detectRepository(path.join(root.root, root.targetPath))).contentFingerprint !== state.request.bundle.contentFingerprint) throw new Error("ORIGINAL_SOURCE_CHANGED");
    if (fingerprint(await manifest(state.root)) !== baselineHash) throw new Error("ORIGINAL_EXECUTION_BYTES_CHANGED");
    const receipt = deepFreeze({ schemaVersion: "P2_EXECUTION_1" as const, status: "READY" as const, executorVersion: "ScopedCssExecutor/1.0.0" as const,
      planHash: state.plan.contentFingerprint, workspace: copy.workspace, baselineHash, workspaceHash: fingerprint(actual), originalFingerprint: state.request.bundle.snapshot.workingTreeFingerprint,
      results: emitted.results, modifiedFiles: [HOME_FILE, CSS_FILE], sourceHashes: { [HOME_FILE]: hashContent(emitted.home), [CSS_FILE]: hashContent(emitted.css) }, diff, diffHash: hashContent(diff),
      atomicity: "PASS" as const, cssDeclarationWithoutOperation: "PASS" as const, executionReview: "CORRECTLY_APPLIED" as const });
    sessions.set(receipt, s); return receipt;
  } catch (error) {
    const cleanup = await copy.cleanup();
    throw new ExecutionFailure(cleanup, state.plan.operations.map(o => o.id), error);
  }
}
export async function undoExecution(receipt: ExecutionReceipt) {
  const s = sessions.get(receipt);
  if (!s || s.undone) throw new Error("NO_LIVE_UNDO_CAPABILITY");
  await guard(s);
  if (fingerprint(await manifest(s.copy.workspace)) !== receipt.workspaceHash) throw new Error("STOP_AND_REQUEST_DIRECTION: later edits are not overwritten");
  const home = s.baseline.get(HOME_FILE), expectedHome = s.expected.get(HOME_FILE);
  if (home === undefined || expectedHome === undefined) throw new Error("MISSING_BASELINE");
  await writeOwned(s, HOME_FILE, home, expectedHome);
  try { await unlink(path.join(s.copy.workspace, CSS_FILE)); }
  catch (error) { await writeOwned(s, HOME_FILE, expectedHome, home); throw error; }
  if (s.createdStyles) await rmdir(path.join(s.copy.workspace, "src/styles"));
  const restoredHash = fingerprint(await manifest(s.copy.workspace));
  if (restoredHash !== receipt.baselineHash) throw new Error("UNDO_FINGERPRINT_FAILED");
  s.undone = true;
  return deepFreeze({ status: "RESTORED_BASELINE" as const, baselineHash: restoredHash, sourceByteEquivalent: true });
}
export async function cleanupExecution(receipt: ExecutionReceipt) {
  const s = sessions.get(receipt);
  if (!s || !s.undone) throw new Error("UNDO_BEFORE_CLEANUP_REQUIRED");
  await guard(s);
  if (fingerprint(await manifest(s.copy.workspace)) !== receipt.baselineHash) throw new Error("STOP_AND_REQUEST_DIRECTION");
  const status = await s.copy.cleanup();
  if (status === "REMOVED") sessions.delete(receipt);
  return status;
}
