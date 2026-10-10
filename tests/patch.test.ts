import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { generateDryRunPatch, dryRunPatchSchema } from "../src/patch/index.js";
import { detectRepository } from "../src/repo/index.js";
import { loadStylePack } from "../src/style-packs/index.js";
import type { EvidenceBundle } from "../src/schemas/index.js";

const roots: string[] = [];
async function fixture(css: string, name = "src/app.css") {
  const root = await mkdtemp(path.join(tmpdir(), "guose-patch-")); roots.push(root);
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }));
  await writeFile(path.join(root, name), css);
  return { root, bundle: await detectRepository(root), pack: await loadStylePack("neutral-modern") };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const css = ':root { --primary: #fff; }\n.x { color: var(--primary); }\n.x { color: #fff; }\n';

describe("dry-run patch materialization", () => {
  it("changes exact value bytes only, keeps policy changes separate and writes no source", async () => {
    const { root, bundle, pack } = await fixture(css);
    const patch = await generateDryRunPatch(bundle, pack);
    expect(patch.files).toHaveLength(1);
    expect(patch.files[0]?.edits).toHaveLength(1);
    expect(patch.files[0]?.edits[0]).toMatchObject({ before: "#fff", after: "var(--primary)", decision: "REVIEW_REQUIRED" });
    expect(patch.diff).toContain("-.x { color: #fff; }");
    expect(await readFile(path.join(root, "src/app.css"), "utf8")).toBe(css);
    expect(patch.diff).not.toContain("#18181b");
    const tokens = await generateDryRunPatch(bundle, pack, "tokens");
    expect(tokens.files[0]?.edits[0]?.after).toBe("#18181b");
    expect(tokens.diff).not.toContain("+.x { color: var(--primary); }");
    expect(Object.isFrozen(patch.files)).toBe(true);
    expect(dryRunPatchSchema.safeParse({ ...patch, diff: "tampered" }).success).toBe(false);
  });
  it.each(["LF", "CRLF", "NO_EOF_NEWLINE"])("produces git-applicable reversible diff including %s and space paths", async (mode) => {
    const text = mode === "CRLF" ? css.replace(/\n/gu, "\r\n") : mode === "NO_EOF_NEWLINE" ? css.trimEnd() : css;
    const file = "src/my styles.css";
    const { root, bundle, pack } = await fixture(text, file);
    const patch = await generateDryRunPatch(bundle, pack);
    // Application proof in our disposable fixture, never external/user source.
    await execa("git", ["apply", "--check", "-"], { cwd: root, input: patch.diff });
    await execa("git", ["apply", "-"], { cwd: root, input: patch.diff });
    expect(await readFile(path.join(root, file), "utf8")).not.toBe(text);
    await execa("git", ["apply", "--check", "-"], { cwd: root, input: patch.reverseDiff });
    await execa("git", ["apply", "-"], { cwd: root, input: patch.reverseDiff });
    expect(await readFile(path.join(root, file), "utf8")).toBe(text);
  });
  it("rejects stale evidence including unpatched files", async () => {
    const { root, bundle, pack } = await fixture(css);
    await writeFile(path.join(root, "override.css"), '.x { --primary: #000; }');
    await expect(generateDryRunPatch(bundle, pack)).rejects.toThrow("STALE");
  });
  it("rejects a forged observation payload retaining the original fingerprint", async () => {
    const { bundle, pack } = await fixture(':root { --primary: #000; } .x { color: var(--primary); } .x { color: #fff; }');
    const forged = structuredClone(bundle) as EvidenceBundle;
    for (const evidence of forged.observations) {
      if (evidence.kind !== "design_token_declaration" || typeof evidence.value !== "object" || evidence.value === null) continue;
      const data = evidence.value as Record<string, unknown>;
      data.rawValue = "#fff"; data.normalizedValue = "#fff";
    }
    await expect(generateDryRunPatch(forged, pack)).rejects.toThrow();
  });
  it.each(["literals", "tokens"] as const)("retains self-contained mapping provenance in %s lane", async (lane) => {
    const { bundle, pack } = await fixture(css);
    const patch = await generateDryRunPatch(bundle, pack, lane);
    expect(patch.source).toMatchObject({ workingTreeFingerprint: bundle.snapshot.workingTreeFingerprint,
      configHash: bundle.snapshot.configHash, guoseVersion: bundle.snapshot.guoseVersion,
      stylePack: { id: "neutral-modern", version: pack.version, contentFingerprint: pack.contentFingerprint } });
    const edit = patch.files[0]?.edits[0];
    expect(edit?.evidenceIds).toContain(edit?.evidenceId);
    expect(edit?.mappingEvidence.map(({ evidenceId }) => evidenceId).sort()).toEqual([...(edit?.evidenceIds ?? [])].sort());
    expect(edit?.role).toBe("primary");
    if (lane === "literals") expect(edit?.evidenceIds.length).toBeGreaterThanOrEqual(3);
    expect(edit?.mappingEvidence.every(({ source }) => source.file === "src/app.css")).toBe(true);
  });
  it.each(["vendor.css", "generated.css", "third-party.css", "third_party.css", "bundle.min.css"])("denies obvious nonproduction basename %s", async (basename) => {
    const { bundle, pack } = await fixture(css, `src/${basename}`);
    expect((await generateDryRunPatch(bundle, pack)).files).toEqual([]);
    expect((await generateDryRunPatch(bundle, pack, "tokens")).files).toEqual([]);
  });
  it("merges nearby edits without a whole-file rewrite or comment formatting", async () => {
    const text = `/* untouched comment */\n:root { --primary: #fff; }\n.x { color: var(--primary); }\n.x { color :  #fff; color: #fff; }\n${"/* unchanged */\n".repeat(20)}`;
    const { root, bundle, pack } = await fixture(text);
    const patch = await generateDryRunPatch(bundle, pack);
    expect(patch.files[0]?.edits).toHaveLength(2);
    expect(patch.diff).toContain("+.x { color :  var(--primary); color: var(--primary); }");
    expect(patch.diff.match(/^@@/gmu)).toHaveLength(1);
    expect(patch.diff.split("\n").length).toBeLessThan(15);
    expect(await readFile(path.join(root, "src/app.css"), "utf8")).toBe(text);
    await execa("git", ["apply", "--check", "-"], { cwd: root, input: patch.diff });
  });
  it("rejects symlink substitution after scan", async () => {
    const { root, bundle, pack } = await fixture(css);
    await rm(path.join(root, "src/app.css"));
    await writeFile(path.join(root, "elsewhere.css"), css);
    await symlink(path.join(root, "elsewhere.css"), path.join(root, "src/app.css"));
    await expect(generateDryRunPatch(bundle, pack)).rejects.toThrow();
  });
  it("omits ambiguous, important and nonproduction changes", async () => {
    const { root, pack } = await fixture(':root { --primary: #fff; --background: #fff; } .x { color: #fff !important; }');
    await mkdir(path.join(root, "generated"));
    await writeFile(path.join(root, "generated/theme.css"), css);
    const patch = await generateDryRunPatch(await detectRepository(root), pack);
    expect(patch.files).toEqual([]);
  });
  it("does not falsely report staleness from multi-directory glob completion order", async () => {
    const { root, pack } = await fixture(css);
    for (const directory of ["z", "a", "generated", "nested/path"]) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(path.join(root, directory, "tokens.css"), ':root { --other: #123456; }');
    }
    const bundle = await detectRepository(root);
    for (let run = 0; run < 4; run++) {
      expect((await detectRepository(root)).contentFingerprint).toBe(bundle.contentFingerprint);
      expect((await generateDryRunPatch(bundle, pack)).files).toHaveLength(1);
    }
  });
});
