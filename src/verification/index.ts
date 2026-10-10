import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import ts from "typescript";
import { z } from "zod";
import { detectRepository, readValidatedRepository } from "../repo/index.js";
import { recoverDesignSystem } from "../recovery/index.js";
import { planMigration } from "../planner/index.js";
import { dryRunPatchSchema, generateDryRunPatch } from "../patch/index.js";
import { unifiedDiff } from "../patch/diff.js";
import { deriveStaticVerificationStatus, migrationPlanSchema, stylePackSchema, verificationResultSchema,
  type ReadonlyEvidenceBundle, type ReadonlyStylePack, type VerificationResult } from "../schemas/index.js";
import { createBundleContentFingerprint, hashContent } from "../utils/content-hash.js";
import { deepFreeze } from "../utils/deep-freeze.js";
import { obviousNonProductionPath } from "../utils/non-production-path.js";
import { createStaticWorkspace, StaticWorkspaceFailure } from "./workspace.js";
import { checkStaticContrast } from "./contrast.js";

export interface StaticVerificationRequest {
  lane?: "literals" | "tokens";
  plan?: unknown;
  patch?: unknown;
}
function syntaxValid(file: string, source: string): boolean {
  if (file.endsWith(".css")) { try { postcss.parse(source); return true; } catch { return false; } }
  if (file.endsWith(".json")) return ts.parseConfigFileTextToJson(file, source).error === undefined;
  const kind = /\.tsx$/u.test(file) ? ts.ScriptKind.TSX : /\.jsx$/u.test(file) ? ts.ScriptKind.JSX : /\.(?:js|mjs|cjs)$/u.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const program = ts.createProgram([file], { noResolve: true, noLib: true, allowJs: true, jsx: ts.JsxEmit.Preserve }, {
    getSourceFile: (name) => name === file ? sourceFile : undefined, getDefaultLibFileName: () => "", writeFile: () => undefined,
    getCurrentDirectory: () => "", getDirectories: () => [], fileExists: (name) => name === file, readFile: () => undefined,
    getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  });
  return program.getSyntacticDiagnostics(sourceFile).length === 0;
}
function discoverRuntime(source: string | undefined): VerificationResult["runtime"] {
  const manifest = source ? z.object({ scripts: z.record(z.string(), z.string()).optional() }).passthrough().safeParse((() => { try { return JSON.parse(source) as unknown; } catch { return null; } })()) : null;
  return (["test", "typecheck", "lint", "build"] as const).map((name) => ({ name,
    discovery: manifest?.success ? manifest.data.scripts?.[name] !== undefined ? "DISCOVERED" : "ABSENT" : "UNKNOWN",
    command: manifest?.success && manifest.data.scripts?.[name] !== undefined ? name === "test" ? "npm test (display only)" : `npm run ${name} (display only)` : null,
    status: "UNVERIFIED", reason: "v0.1 intentionally executes no target scripts; runtime execution isolation is deferred.",
  }));
}
function applyExact(source: string, edits: readonly { start: number; end: number; before: string; after: string }[]): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 0; i < ordered.length; i++) {
    const edit = ordered[i];
    if (!edit || edit.start < 0 || edit.end > source.length || source.slice(edit.start, edit.end) !== edit.before ||
        (i > 0 && (ordered[i - 1]?.end ?? 0) > edit.start)) throw new Error("Patch does not apply to exact permitted positions.");
  }
  let after = source;
  for (const edit of ordered.reverse()) after = after.slice(0, edit.start) + edit.after + after.slice(edit.end);
  return after;
}

export class StaticVerificationBackend {
  async verify(inputBundle: ReadonlyEvidenceBundle, inputPack: ReadonlyStylePack, request: StaticVerificationRequest = {}) {
    const { bundle, root } = await readValidatedRepository(inputBundle), pack = deepFreeze(stylePackSchema.parse(inputPack));
    const plan = planMigration(bundle, pack);
    const checks: VerificationResult["checks"] = [], verifiedOperations: string[] = [], failedOperations: string[] = [];
    const add = (id: string, status: "PASS" | "FAIL" | "UNVERIFIED", reason: string) => { checks.push({ id, status, reason }); };
    let freshness: VerificationResult["freshness"] = "UNKNOWN";
    let patchHash = hashContent("no patch verified"), operationIds: string[] = [];
    const isolation: VerificationResult["isolation"] = { copiedFiles: 0, excludedFiles: [], scope: "ANALYSIS_FILES_ONLY", cleanup: "NOT_CREATED" };
    let runtime = discoverRuntime(undefined), contrast: VerificationResult["contrast"] = [];
    const finish = () => {
      const result = deriveStaticVerificationStatus({ checks, freshness, plannedOperationIds: operationIds, verifiedOperations, failedOperations, isolation });
      const payload = { schemaVersion: "1.0.0" as const, status: "OBSERVED" as const, backend: "StaticVerificationBackend" as const,
        result, freshness, timestamp: new Date().toISOString(),
        baseline: { gitHead: bundle.snapshot.gitHead, workingTreeFingerprint: bundle.snapshot.workingTreeFingerprint,
          evidenceFingerprint: bundle.contentFingerprint, configHash: bundle.snapshot.configHash, guoseVersion: bundle.snapshot.guoseVersion,
          planHash: plan.contentFingerprint, patchHash, stylePack: plan.source.stylePack }, checks,
        plannedOperationIds: operationIds, verifiedOperations, failedOperations,
        unverifiedChecks: [...checks.filter(({ status }) => status === "UNVERIFIED").map(({ id }) => id), ...runtime.map(({ name }) => `runtime:${name}`)],
        runtime, executionCount: 0 as const, isolation, contrast,
        limitations: ["Deterministic static migration verification only. Never tests/build/project runtime verification.",
          "Analysis-file copy excludes Git, dependencies, nonanalysis assets and recognized secrets; not a complete executable clone.",
          "Semantic reference existence and declared contrast do not establish cascade, dynamic application, rendering or accessibility compliance.",
          "Runtime execution isolation is intentionally deferred; no container backend or target command execution is implemented.",
          "Concurrently hostile filesystem TOCTOU confinement is not established; no target code runs in this backend."] };
      return deepFreeze(verificationResultSchema.parse({ ...payload, contentFingerprint: createBundleContentFingerprint(payload) }));
    };
    const current = await detectRepository(root);
    if (current.contentFingerprint !== bundle.contentFingerprint) {
      freshness = "STALE"; add("baseline", "UNVERIFIED", "STALE: HEAD, working tree, configuration or evidence identity changed."); return finish();
    }
    freshness = "FRESH";
    add("baseline", "PASS", "Exact EvidenceBundle content/config/Git/version identity matches; null HEAD is not a claim of Git history verification.");
    if (bundle.snapshot.gitStateReason === "GIT_UNAVAILABLE") add("git-metadata", "UNVERIFIED", "Git identity could not be safely inspected.");
    const expected = await generateDryRunPatch(inputBundle, pack, request.lane ?? "literals");
    patchHash = expected.contentFingerprint;
    operationIds = expected.files.flatMap(({ file, edits }) => edits.map(({ start, evidenceId }) => `${file}:${start}:${evidenceId}`));
    const suppliedPlan = request.plan === undefined ? plan : migrationPlanSchema.safeParse(request.plan);
    const suppliedPatch = request.patch === undefined ? expected : dryRunPatchSchema.safeParse(request.patch);
    const parsedPatch = "success" in suppliedPatch ? suppliedPatch.success ? suppliedPatch.data : null : suppliedPatch;
    const parsedPlan = "success" in suppliedPlan ? suppliedPlan.success ? suppliedPlan.data : null : suppliedPlan;
    if (parsedPatch) patchHash = parsedPatch.contentFingerprint;
    if ((parsedPatch && (JSON.stringify(parsedPatch.source.stylePack) !== JSON.stringify(plan.source.stylePack) ||
        parsedPatch.source.guoseVersion !== bundle.snapshot.guoseVersion || parsedPatch.source.configHash !== bundle.snapshot.configHash ||
        parsedPatch.source.gitHead !== bundle.snapshot.gitHead || parsedPatch.source.workingTreeFingerprint !== bundle.snapshot.workingTreeFingerprint)) ||
        (parsedPlan && JSON.stringify(parsedPlan.source.stylePack) !== JSON.stringify(plan.source.stylePack))) {
      freshness = "STALE"; add("artifact-identity", "UNVERIFIED", "STALE: artifact pack/version/config/HEAD/working-tree identity no longer matches."); return finish();
    }
    if (("success" in suppliedPlan && (!suppliedPlan.success || suppliedPlan.data.contentFingerprint !== plan.contentFingerprint)) ||
        ("success" in suppliedPatch && (!suppliedPatch.success || suppliedPatch.data.contentFingerprint !== expected.contentFingerprint))) {
      add("planned-vs-actual", "FAIL", "Submitted plan/patch differs from canonical generated operations, metadata, provenance or exact diff; no copy changes made.");
      failedOperations.push(...operationIds); return finish();
    }
    add("planned-vs-actual", "PASS", "All files, edits, evidence, targets, digests, hunks and reverse diffs match the canonical plan-derived patch.");
    let temporary: Awaited<ReturnType<typeof createStaticWorkspace>> | undefined;
    try {
      temporary = await createStaticWorkspace(inputBundle);
      isolation.copiedFiles = temporary.sources.size; isolation.excludedFiles = temporary.excludedFiles;
      runtime = discoverRuntime(temporary.sources.get("package.json"));
      const before = new Map(temporary.sources), after = new Map(before);
      const excluded = new Set(recoverDesignSystem(bundle).coverage.excludedEvidence.map(({ evidenceId }) => evidenceId));
      const excludedPaths = new Set(bundle.observations.filter(({ id }) => excluded.has(id)).map(({ source }) => source.file));
      for (const file of expected.files) {
        if (obviousNonProductionPath(file.file) !== null || excludedPaths.has(file.file)) throw new Error("Nonproduction file mutation rejected.");
        const source = before.get(file.file);
        if (source === undefined || hashContent(source) !== file.beforeDigest) throw new Error("Copy does not match patch baseline.");
        const proposed = applyExact(source, file.edits);
        if (hashContent(proposed) !== file.afterDigest || unifiedDiff(file.file, source, proposed) !== file.diff ||
            unifiedDiff(file.file, proposed, source) !== file.reverseDiff) throw new Error("Diff or collateral formatting mismatch.");
        let shift = 0;
        const reverse = file.edits.map((edit) => { const start = edit.start + shift; shift += edit.after.length - edit.before.length; return { start, end: start + edit.after.length, before: edit.after, after: edit.before }; });
        if (applyExact(proposed, reverse) !== source) throw new Error("Patch is not reversible.");
        await writeFile(path.join(temporary.workspace, file.file), proposed);
        after.set(file.file, proposed);
        verifiedOperations.push(...file.edits.map(({ start, evidenceId }) => `${file.file}:${start}:${evidenceId}`));
      }
      add("exact-apply-and-reverse", "PASS", `${verifiedOperations.length}/${operationIds.length} exact planned operations applied and reversed in an analysis-only copy; original untouched.`);
      for (const [file, source] of after) {
        if (await readFile(path.join(temporary.workspace, file), "utf8") !== source ||
            (!expected.files.some((item) => item.file === file) && source !== before.get(file))) throw new Error("Undeclared file or location change.");
        if (!syntaxValid(file, source)) throw new Error("CSS/config/source syntax failed static parsing.");
      }
      add("syntax-and-change-boundary", "PASS", "Copied source/config parses without executing modules; only declared exact value slices changed, no unexpected hunks or formatting churn.");
      const declarations = new Set<string>();
      for (const [file, source] of after) if (file.endsWith(".css") && !excludedPaths.has(file)) postcss.parse(source).walkDecls((declaration) => { if (declaration.prop.startsWith("--")) declarations.add(declaration.prop); });
      for (const file of expected.files) for (const edit of file.edits) {
        const target = /^var\((--[a-z0-9-]+)\)$/u.exec(edit.after)?.[1];
        if (target && !declarations.has(target)) throw new Error("Missing semantic target token.");
      }
      add("target-and-provenance", "PASS", "Canonical operation provenance remains bound to baseline source; generated variable targets exist in copied declarations. Scope/runtime semantics remain unverified.");
      const cssDependencies = bundle.unknowns.some(({ kind }) => kind === "css_dependency" || kind === "css_parse" || kind === "security_exclusion");
      contrast = checkStaticContrast(new Map([...before].filter(([file]) => !excludedPaths.has(file))), new Map([...after].filter(([file]) => !excludedPaths.has(file))), cssDependencies);
      for (const pair of contrast) add(`contrast:${pair.pair}`, pair.status, pair.reason);
      if (expected.omitted.length || bundle.unknowns.length || isolation.excludedFiles.length) add("static-coverage", "UNVERIFIED", "Unresolved evidence, omitted operations or excluded secrets remain outside verified scope.");
      else add("static-coverage", "PASS", "No unresolved scan evidence or materialization omissions within selected static scope.");
      if ((await detectRepository(root)).contentFingerprint !== bundle.contentFingerprint) {
        freshness = "STALE"; add("post-verification-freshness", "UNVERIFIED", "Original repository changed during static verification.");
      } else add("post-verification-freshness", "PASS", "Original HEAD, content and configuration remain identical.");
    } catch (error) {
      if (error instanceof StaticWorkspaceFailure) {
        isolation.cleanup = error.cleanupStatus; isolation.copiedFiles = error.copiedFiles; isolation.excludedFiles = error.excludedFiles;
      }
      add("static-apply", "FAIL", "Static copy/application/syntax/reference boundary failed; no target code executed.");
      failedOperations.push(...operationIds.filter((id) => !verifiedOperations.includes(id)));
    } finally {
      if (temporary) isolation.cleanup = await temporary.cleanup();
      if (isolation.cleanup === "RETAINED_FOR_SAFETY") add("cleanup", "UNVERIFIED", "Ownership cleanup guard failed; uncertain temporary path was not recursively deleted.");
    }
    return finish();
  }
}
export const verifyMigration = (bundle: ReadonlyEvidenceBundle, pack: ReadonlyStylePack, request: StaticVerificationRequest = {}) => new StaticVerificationBackend().verify(bundle, pack, request);
