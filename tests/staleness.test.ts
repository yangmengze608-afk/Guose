import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import { detectRepository } from "../src/repo/index.js";
import { recoverDesignSystem } from "../src/recovery/index.js";
import { planMigration } from "../src/planner/index.js";
import { loadStylePack } from "../src/style-packs/index.js";
import { generateDryRunPatch } from "../src/patch/index.js";
import { verifyMigration } from "../src/verification/index.js";
import { assessArtifactFreshness } from "../src/staleness/index.js";
import { createBundleContentFingerprint } from "../src/utils/content-hash.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "guose-staleness-")); roots.push(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }));
  await writeFile(path.join(root, "app.css"), ":root { --primary: #123456; }\n.x { color: var(--primary); }\n.x { color: #123456; }\n");
  const bundle = await detectRepository(root), pack = await loadStylePack("neutral-modern");
  return { root, bundle, pack, recovery: recoverDesignSystem(bundle), plan: planMigration(bundle, pack), patch: await generateDryRunPatch(bundle, pack), verification: await verifyMigration(bundle, pack) };
}
it("ignores timestamps and reports all unchanged artifact dependencies FRESH", async () => {
  const f = await fixture(), now = await detectRepository(f.root);
  for (const kind of ["recovery", "plan", "patch", "verification"] as const) expect(assessArtifactFreshness(kind, f[kind], f.bundle, now, f.pack).status).toBe("FRESH");
  expect(assessArtifactFreshness("recovery", f.recovery, f.bundle, now).status).toBe("FRESH");
});
it.each(["app.css", "untracked.tsx", "tsconfig.json"])("marks changed %s STALE across old artifacts", async (file) => {
  const f = await fixture(); await writeFile(path.join(f.root, file), file.endsWith("json") ? "{}" : "/* changed */");
  const now = await detectRepository(f.root);
  for (const kind of ["recovery", "plan", "patch", "verification"] as const) expect(assessArtifactFreshness(kind, f[kind], f.bundle, now, f.pack).status).toBe("STALE");
});
it("requires pack identity only for consuming artifacts", async () => {
  const f = await fixture();
  const { contentFingerprint: previous, ...payload } = f.pack; void previous;
  const modified = { ...payload, version: "0.1.1" }, pack = { ...modified, contentFingerprint: createBundleContentFingerprint(modified) };
  for (const kind of ["plan", "patch", "verification"] as const) {
    expect(assessArtifactFreshness(kind, f[kind], f.bundle, f.bundle).status).toBe("UNKNOWN");
    expect(assessArtifactFreshness(kind, f[kind], f.bundle, f.bundle, pack).status).toBe("STALE");
  }
  expect(assessArtifactFreshness("recovery", f.recovery, f.bundle, f.bundle, pack).status).toBe("FRESH");
});
it("does not treat missing or invalid metadata as freshness proof", async () => {
  const f = await fixture();
  expect(assessArtifactFreshness("recovery", {}, f.bundle, f.bundle).status).toBe("UNKNOWN");
  expect(assessArtifactFreshness("plan", f.plan, undefined, f.bundle, f.pack).status).toBe("UNKNOWN");
});
it("detects HEAD-only changes without relying on file timestamps", async () => {
  const f = await fixture();
  await execa("git", ["init"], { cwd: f.root }); await execa("git", ["add", "."], { cwd: f.root });
  const args = ["-c", "user.name=Guose Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"];
  await execa("git", args, { cwd: f.root });
  const baseline = await detectRepository(f.root), recovery = recoverDesignSystem(baseline);
  await execa("git", [...args, "--allow-empty"], { cwd: f.root });
  expect(assessArtifactFreshness("recovery", recovery, baseline, await detectRepository(f.root)).checks).toContainEqual({ dependency: "gitHead", status: "CHANGED" });
});
it("detects Guose version changes and unavailable Git as UNKNOWN", async () => {
  const f = await fixture();
  const rebind = (snapshot: typeof f.bundle.snapshot) => {
    const { contentFingerprint: previous, ...payload } = f.bundle; void previous;
    return { ...payload, snapshot, contentFingerprint: createBundleContentFingerprint({ ...payload, snapshot: { ...snapshot, createdAt: "" } }) };
  };
  const version = rebind({ ...f.bundle.snapshot, guoseVersion: "0.1.1" });
  expect(assessArtifactFreshness("recovery", f.recovery, f.bundle, version).status).toBe("STALE");
  const unavailable = rebind({ ...f.bundle.snapshot, gitHead: null, gitDirty: null, gitStateReason: "GIT_UNAVAILABLE" });
  expect(assessArtifactFreshness("recovery", recoverDesignSystem(unavailable), unavailable, unavailable).status).toBe("UNKNOWN");
});
