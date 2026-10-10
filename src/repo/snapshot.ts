import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { readSafeBytes, RESOURCE_LIMITS, RepositorySafetyError, sensitiveText, assertParserBudget } from "./safety.js";

import { execa } from "execa";

import type { EvidenceSnapshot } from "../schemas/index.js";
import { hashContent } from "../utils/content-hash.js";

export { createBundleContentFingerprint } from "../utils/content-hash.js";

const GUOSE_VERSION = "0.1.0-dev.0";

type HashableContent = string | Uint8Array;

function updateLength(hash: ReturnType<typeof createHash>, length: number): void {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(length));
  hash.update(encoded);
}

export function hashEntries(
  entries: ReadonlyArray<readonly [string, HashableContent]>,
): string {
  const hash = createHash("sha256");

  for (const [file, content] of [...entries].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )) {
    const fileBytes = Buffer.from(file);
    const contentBytes =
      typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    updateLength(hash, fileBytes.byteLength);
    hash.update(fileBytes);
    updateLength(hash, contentBytes.byteLength);
    hash.update(contentBytes);
  }

  return `sha256:${hash.digest("hex")}`;
}

export async function readTextEntries(
  root: string,
  relativeFiles: readonly string[],
  onExcluded: (file: string, reason: string) => void = () => undefined,
): Promise<Array<readonly [string, string]>> {
  const result: Array<readonly [string, string]> = [];
  let size = 0;
  for (const file of relativeFiles) {
    const bytes = await readSafeBytes(root, file); size += bytes.length;
    if (size > RESOURCE_LIMITS.totalBytes) throw new RepositorySafetyError("LIMIT_EXCEEDED");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { onExcluded(file, "Binary or invalid UTF-8 input"); continue; }
    if (text.includes("\0") || sensitiveText(text)) { onExcluded(file, "Binary or recognized-sensitive input"); continue; }
    try { assertParserBudget(text); }
    catch (error) {
      if (file === "package.json") throw error;
      onExcluded(file, "LIMIT_EXCEEDED: static parser resource budget"); continue;
    }
    result.push([file, text]);
  }
  return result;
}

export async function readBinaryEntries(
  root: string,
  relativeFiles: readonly string[],
): Promise<Array<readonly [string, Uint8Array]>> {
  const result: Array<readonly [string, Uint8Array]> = [];
  let size = 0;
  for (const file of relativeFiles) {
    const bytes = await readSafeBytes(root, file); size += bytes.length;
    if (size > RESOURCE_LIMITS.totalBytes) throw new RepositorySafetyError("LIMIT_EXCEEDED");
    result.push([file, bytes]);
  }
  return result;
}

async function readGitState(root: string): Promise<
  Pick<EvidenceSnapshot, "gitHead" | "gitDirty" | "gitStateReason">
> {
  try {
    let metadata;
    try { metadata = await lstat(path.join(root, ".git")); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { gitHead: null, gitDirty: null, gitStateReason: "NOT_GIT_REPOSITORY" };
      throw error;
    }
    // No parent discovery, gitfile indirection, metadata symlinks or config includes.
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Unsupported Git metadata layout.");
    let metadataEntries = 0;
    async function inspectMetadata(directory: string, depth: number): Promise<void> {
      if (depth > RESOURCE_LIMITS.depth) throw new Error("Git metadata depth exceeded.");
      for await (const item of await opendir(path.join(root, directory))) {
        if (++metadataEntries > RESOURCE_LIMITS.entries || item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) throw new Error("Unsupported Git metadata entry.");
        if (item.name === "commondir" || item.name === "alternates" || item.name === "config.worktree") throw new Error("External Git metadata indirection rejected.");
        if (item.isDirectory()) await inspectMetadata(`${directory}/${item.name}`, depth + 1);
      }
    }
    await inspectMetadata(".git", 0);
    const config = (await readSafeBytes(root, ".git/config")).toString("utf8");
    if (/^[ \t]*\[include(?:if)?(?:[ \t]|\])/imu.test(config) || sensitiveText(config)) throw new Error("Unsafe Git configuration rejected.");
    // Git metadata is read-only, but status can invoke repository fsmonitor.
    // Disable hooks/monitor/submodule recursion and inherited Git configuration.
    const disabledFilters: string[] = [];
    const git = (args: string[]) => execa("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", ...disabledFilters, ...args], {
      cwd: root, reject: false, extendEnv: false, timeout: 2000,
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_ATTR_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: path.dirname(root), GIT_NO_REPLACE_OBJECTS: "1" },
    });
    const repository = await git(["rev-parse", "--is-inside-work-tree"]);
    if (repository.exitCode !== 0 || repository.stdout !== "true") {
      return {
        gitHead: null,
        gitDirty: null,
        gitStateReason: "GIT_UNAVAILABLE",
      };
    }

    // Index refresh can call clean/process filters even when hooks are off.
    const filters = await git(["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|smudge|required)$"]);
    if (filters.exitCode !== 0 && filters.exitCode !== 1) throw new Error("Git filter metadata unavailable.");
    const drivers = new Set<string>();
    for (const key of filters.stdout.split("\n").filter(Boolean)) {
      const driver = /^filter\.([a-zA-Z0-9_.-]+)\.(?:clean|process|smudge|required)$/u.exec(key)?.[1];
      if (!driver) throw new Error("Unbounded Git filter key; status not inspected.");
      drivers.add(driver);
    }
    for (const driver of drivers) disabledFilters.push("-c", `filter.${driver}.clean=`, "-c", `filter.${driver}.process=`, "-c", `filter.${driver}.smudge=`, "-c", `filter.${driver}.required=false`);

    const status = await git(["status", "--porcelain=v1", "--ignore-submodules=all"]);
    if (status.exitCode !== 0) {
      return { gitHead: null, gitDirty: null, gitStateReason: "GIT_UNAVAILABLE" };
    }

    const head = await git(["rev-parse", "--verify", "HEAD"]);
    if (head.exitCode !== 0) {
      return {
        gitHead: null,
        gitDirty: status.stdout.length > 0,
        gitStateReason: "UNBORN_HEAD",
      };
    }
    return {
      gitHead: head.stdout,
      gitDirty: status.stdout.length > 0,
      gitStateReason: null,
    };
  } catch {
    return {
      gitHead: null,
      gitDirty: null,
      gitStateReason: "GIT_UNAVAILABLE",
    };
  }
}

export async function createEvidenceSnapshot(
  root: string,
  analysisEntries: ReadonlyArray<readonly [string, string]>,
  configEntries: ReadonlyArray<readonly [string, string]>,
  workingTreeEntries: ReadonlyArray<readonly [string, Uint8Array]>,
  allowGitInspection = true,
): Promise<EvidenceSnapshot> {
  const gitState = allowGitInspection ? await readGitState(root) : { gitHead: null, gitDirty: null, gitStateReason: "GIT_UNAVAILABLE" as const };
  return {
    ...gitState,
    workingTreeFingerprint: hashEntries(workingTreeEntries),
    configHash: hashEntries(configEntries),
    files: analysisEntries.map(([file, content]) => ({
      path: file,
      digest: hashContent(content),
      lineCount: content.split("\n").length,
    })),
    stylePack: null,
    guoseVersion: GUOSE_VERSION,
    createdAt: new Date().toISOString(),
  };
}
