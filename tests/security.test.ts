import { access, mkdtemp, mkdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { detectRepository } from "../src/repo/index.js";
import { repositoryInventory, readSafeBytes, RESOURCE_LIMITS, assertParserBudget, sensitiveText } from "../src/repo/safety.js";
import { relativeFilePathSchema, evidenceBundleSchema } from "../src/schemas/index.js";
import { loadStylePack } from "../src/style-packs/index.js";
import { generateDryRunPatch } from "../src/patch/index.js";
import { verifyMigration } from "../src/verification/index.js";
import { createStaticWorkspace, StaticWorkspaceFailure } from "../src/verification/workspace.js";
import { recoverDesignSystem } from "../src/recovery/index.js";
import { planMigration } from "../src/planner/index.js";
import { runCli } from "../src/cli/program.js";
import { extractDesignEvidence } from "../src/extraction/index.js";
import { createBundleContentFingerprint } from "../src/utils/content-hash.js";
import { execa } from "execa";

const roots: string[] = [], canary = "/tmp/guose-security-canary";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
afterAll(async () => { await expect(access(canary)).rejects.toThrow(); });
async function fixture(files: Record<string, string | Buffer> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "guose-security-")); roots.push(root);
  for (const [file, value] of Object.entries({ "package.json": '{"dependencies":{"react":"19","tailwindcss":"4"}}', "app.css": ":root { --primary: #123456; }\n.x { color: var(--primary); }\n.x { color: #123456; }\n", ...files })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), value);
  }
  return root;
}
it.each(["../../a", "/tmp/a", "C:/a", "%2e%2e/a", "%252e%252e/a", "a//b", "a/../b", "a\\b", "a\n.css", "a\u202e.css"])("rejects unsafe path %s", async (file) => {
  expect(relativeFilePathSchema.safeParse(file).success).toBe(false);
  await expect(readSafeBytes(await fixture(), file)).rejects.toThrow("UNSAFE_INPUT");
});
it("skips symlink sources, outside directories and loops", async () => {
  const root = await fixture(), outside = await fixture();
  await symlink(path.join(outside, "app.css"), path.join(root, "link.css"));
  await symlink(outside, path.join(root, "outside")); await symlink(root, path.join(root, "loop"));
  const bundle = await detectRepository(root);
  expect(bundle.unknowns.filter(({ kind }) => kind === "security_exclusion")).toHaveLength(3);
  expect(bundle.snapshot.files.map(({ path: file }) => file)).toEqual(["app.css", "package.json"]);
  await expect(detectRepository(path.join(root, "loop"))).rejects.toThrow("UNSAFE_INPUT");
});
it("rejects extreme depth and huge file count with LIMIT_EXCEEDED", async () => {
  const root = await fixture(); await mkdir(path.join(root, ...Array<string>(34).fill("nested")), { recursive: true });
  await expect(repositoryInventory(root)).rejects.toThrow("LIMIT_EXCEEDED");
  const wide = await fixture();
  for (let start = 0; start < RESOURCE_LIMITS.files; start += 100) await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(path.join(wide, `f-${start + index}`), "")));
  await expect(repositoryInventory(wide)).rejects.toThrow("LIMIT_EXCEEDED");
}, 15000);
it("bounds allocations and parser complexity", async () => {
  const root = await fixture(); await truncate(path.join(root, "app.css"), RESOURCE_LIMITS.fileBytes + 1);
  await expect(detectRepository(root)).rejects.toThrow("LIMIT_EXCEEDED");
  expect(() => assertParserBudget("x".repeat(RESOURCE_LIMITS.parserBytes + 1))).toThrow("LIMIT_EXCEEDED");
  expect(() => assertParserBudget(";".repeat(RESOURCE_LIMITS.parserPunctuation + 1))).toThrow("LIMIT_EXCEEDED");
  expect(() => assertParserBudget("(".repeat(RESOURCE_LIMITS.parserDepth + 1))).toThrow("LIMIT_EXCEEDED");
});
it("isolates binary and malformed files and retains good evidence", async () => {
  const bundle = await detectRepository(await fixture({ "binary.css": Buffer.from([0, 0xff, 1]), "broken.css": "a {", "broken.tsx": "export const Broken = <div>", "tailwind.config.ts": "export default { theme: { colors: ", "components.json": "{broken" }));
  for (const file of ["binary.css", "broken.css", "broken.tsx", "tailwind.config.ts", "components.json"]) expect(bundle.unknowns.some(({ source, scope }) => source?.file === file || scope === `Excluded repository-relative entry: ${file}`)).toBe(true);
  expect(bundle.observations.some(({ source }) => source.file === "app.css")).toBe(true);
  expect((await detectRepository(await fixture({ "package.json": "{broken" }))).repository.supportStatus).toBe("UNSUPPORTED");
});
it("excludes recognized sensitive paths/text from every artifact", async () => {
  const secret = "sk-" + "a".repeat(32), root = await fixture({ ".env": secret, ".env.local": secret, "private.pem": "-----BEGIN PRIVATE KEY-----", "credentials.ts": secret, "leaky.css": `/* /Users/private-user/home ${secret} */\na{color:#123456}` });
  const bundle = await detectRepository(root), pack = await loadStylePack("neutral-modern");
  const json = JSON.stringify([bundle, recoverDesignSystem(bundle), planMigration(bundle, pack), await generateDryRunPatch(bundle, pack), await verifyMigration(bundle, pack)]);
  for (const text of [root, "/Users/", "private-user", secret, "BEGIN PRIVATE KEY"]) expect(json).not.toContain(text);
  expect(bundle.repository.root).toBe(".");
  expect(bundle.snapshot.gitStateReason).toBe("GIT_UNAVAILABLE");
  expect(bundle.snapshot.files.map(({ path: file }) => file)).not.toContain("credentials.ts");
  expect(bundle.unknowns.filter(({ kind }) => kind === "security_exclusion")).toHaveLength(5);
});
it("rejects JSON/spread/cloned artifacts before filesystem use", async () => {
  const bundle = await detectRepository(await fixture()), pack = await loadStylePack("neutral-modern");
  for (const copy of [JSON.parse(JSON.stringify(bundle)) as typeof bundle, { ...bundle }, structuredClone(bundle), evidenceBundleSchema.parse(bundle)]) {
    await expect(generateDryRunPatch(copy, pack)).rejects.toThrow("UNSAFE_INPUT");
    await expect(verifyMigration(copy, pack)).rejects.toThrow("UNSAFE_INPUT");
    await expect(createStaticWorkspace(copy)).rejects.toThrow("UNSAFE_INPUT");
    expect(recoverDesignSystem(copy).source.evidenceFingerprint).toBe(bundle.contentFingerprint);
  }
});
it("rejects root replacement and cleans a failed copy", async () => {
  const root = await fixture(), bundle = await detectRepository(root);
  await writeFile(path.join(root, "app.css"), "changed");
  try { await createStaticWorkspace(bundle); throw new Error("Expected failure"); }
  catch (error) { expect(error).toBeInstanceOf(StaticWorkspaceFailure); expect((error as StaticWorkspaceFailure).cleanupStatus).toBe("REMOVED"); }
  const backup = `${root}-original`; roots.push(backup); await rename(root, backup); await mkdir(root);
  await expect(generateDryRunPatch(bundle, await loadStylePack("neutral-modern"))).rejects.toThrow("UNSAFE_INPUT");
});
it("rejects production mutations and never executes malicious configs/scripts", async () => {
  await expect(access(canary)).rejects.toThrow();
  const code = `require('node:fs').writeFileSync('${canary}', 'executed');`;
  const root = await fixture({ "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" }, scripts: { test: `touch ${canary}` } }), "tailwind.config.cjs": code + "module.exports = {theme:{colors: process.env.UNKNOWN}};", "vendor/app.css": ".x{color:#123456}", "generated/app.css": ".x{color:#123456}", "node_modules/evil/app.css": ".x{color:#123456}" });
  const bundle = await detectRepository(root), pack = await loadStylePack("neutral-modern"), patch = await generateDryRunPatch(bundle, pack);
  expect(patch.files.every(({ file }) => !/vendor|generated|node_modules/u.test(file))).toBe(true);
  expect(bundle.snapshot.files.some(({ path: file }) => file.includes("node_modules"))).toBe(false);
  await verifyMigration(bundle, pack);
  await expect(access(canary)).rejects.toThrow();
});
it("does not echo absolute CLI input paths", async () => {
  let output = ""; const io = { stdout: (text: string) => { output += text; }, stderr: (text: string) => { output += text; } };
  expect(await runCli(["node", "guose", "scan", "/Users/private-user/no-such-repo", "--json"], io)).toBe(2);
  expect(output).not.toContain("/Users/"); expect(output).not.toContain("private-user");
});
it("bounds credential regex stress inputs", () => {
  expect(sensitiveText("https://" + ":".repeat(500000))).toBe(false);
  expect(sensitiveText("https://username:password@example.invalid")).toBe(true);
  expect(sensitiveText("\u001b[31m injected")).toBe(true);
  expect(() => extractDesignEvidence([["app.tsx", `export const App = () => <div className="text-[${"rem".repeat(8000)}!" />`]], { tailwind: true })).not.toThrow();
}, 1000);
it("keeps identical-content roots independently bound and rejects forged roots", async () => {
  const left = await fixture(), right = await fixture(), a = await detectRepository(left), b = await detectRepository(right), pack = await loadStylePack("neutral-modern");
  expect(a.contentFingerprint).toBe(b.contentFingerprint);
  await writeFile(path.join(right, "app.css"), "changed");
  expect((await generateDryRunPatch(a, pack)).files).toHaveLength(1);
  await expect(generateDryRunPatch(b, pack)).rejects.toThrow("STALE");
  expect(evidenceBundleSchema.safeParse({ ...a, repository: { ...a.repository, root: right } }).success).toBe(false);
});
it("rejects outside-root patch targets and stale offsets even after rehash", async () => {
  const bundle = await detectRepository(await fixture()), pack = await loadStylePack("neutral-modern"), patch = await generateDryRunPatch(bundle, pack);
  for (const attack of ["../../outside.css", "/tmp/outside.css", "package-lock.json", "vendor/app.css", "node_modules/app.css", "generated/app.css", "offset"]) {
    const forged = structuredClone(patch), file = forged.files[0];
    if (!file?.edits[0]) throw new Error("Missing fixture edit");
    if (attack === "offset") file.edits[0].start++;
    else file.file = attack;
    const { contentFingerprint: previous, ...payload } = forged; void previous;
    const result = await verifyMigration(bundle, pack, { patch: { ...payload, contentFingerprint: createBundleContentFingerprint(payload) } });
    expect(result.result).toBe("FAILED"); expect(result.isolation.cleanup).toBe("NOT_CREATED");
  }
});
it("rejects aggregate byte overflow before parsing or producing artifacts", async () => {
  const root = await fixture(), bytes = Buffer.alloc(RESOURCE_LIMITS.fileBytes, 0);
  for (let index = 0; index < 17; index++) await writeFile(path.join(root, `asset-${index}.data`), bytes);
  await expect(detectRepository(root)).rejects.toThrow("LIMIT_EXCEEDED");
}, 15000);
it("isolates noncore parser limits and blocks migration instead of guessing", async () => {
  const bundle = await detectRepository(await fixture({ "too-large.tsx": "x".repeat(RESOURCE_LIMITS.parserBytes + 1) }));
  expect(bundle.unknowns.some(({ reason }) => reason.includes("LIMIT_EXCEEDED"))).toBe(true);
  expect(planMigration(bundle, await loadStylePack("neutral-modern")).summary.rawLiteralReviewCandidates).toBe(0);
});
it("refuses external Git metadata/configuration indirection", async () => {
  const root = await fixture(); await execa("git", ["init"], { cwd: root });
  await writeFile(path.join(root, ".git/config"), '[include]\n path = /Users/private-user/credentials\n');
  const bundle = await detectRepository(root);
  expect(bundle.snapshot.gitStateReason).toBe("GIT_UNAVAILABLE");
  expect(JSON.stringify(bundle)).not.toContain("private-user");
  const pointed = await fixture(); await writeFile(path.join(pointed, ".git"), `gitdir: ${root}/.git`);
  expect((await detectRepository(pointed)).snapshot.gitStateReason).toBe("GIT_UNAVAILABLE");
});
