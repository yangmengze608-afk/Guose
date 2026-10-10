import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashContent } from "../utils/content-hash.js";
import type { ReadonlyEvidenceBundle } from "../schemas/index.js";
import { readValidatedRepository } from "../repo/detect.js";
import { sensitivePath, readSafeBytes } from "../repo/safety.js";

export class StaticWorkspaceFailure extends Error {
  constructor(readonly cleanupStatus: "REMOVED" | "RETAINED_FOR_SAFETY", readonly copiedFiles: number, readonly excludedFiles: string[]) {
    super("Static analysis copy failed; no target code executed.");
  }
}

export async function readExactSource(root: string, relative: string, digest: string): Promise<string> {
  const bytes = await readSafeBytes(root, relative);
  if (hashContent(bytes) !== digest) throw new Error("STALE source digest.");
  return bytes.toString("utf8");
}

export async function createStaticWorkspace(inputBundle: ReadonlyEvidenceBundle) {
  const { bundle, root } = await readValidatedRepository(inputBundle);
  const parent = await realpath(tmpdir());
  const container = await mkdtemp(path.join(parent, "guose-static-verify-"));
  const identity = await lstat(container), marker = randomUUID();
  const markerPath = path.join(container, ".guose-owned");
  const workspace = path.join(container, "workspace");
  const excludedFiles: string[] = [], sources = new Map<string, string>();
  async function cleanup(): Promise<"REMOVED" | "RETAINED_FOR_SAFETY"> {
    try {
      const current = await lstat(container), markerStat = await lstat(markerPath);
      if (current.isSymbolicLink() || !current.isDirectory() || current.ino !== identity.ino || current.dev !== identity.dev ||
          path.dirname(await realpath(container)) !== parent || markerStat.isSymbolicLink() ||
          await readFile(markerPath, "utf8") !== marker) return "RETAINED_FOR_SAFETY";
      await rm(container, { recursive: true, force: false });
      return "REMOVED";
    } catch { return "RETAINED_FOR_SAFETY"; }
  }
  try {
    await chmod(container, 0o700);
    await writeFile(markerPath, marker, { mode: 0o600, flag: "wx" });
    await mkdir(workspace, { mode: 0o700 });
    if (bundle.snapshot.files.length > 10000) throw new Error("Analysis file count limit exceeded.");
    let size = 0;
    for (const file of bundle.snapshot.files) {
      if (sensitivePath(file.path)) { excludedFiles.push(file.path); continue; }
      const source = await readExactSource(root, file.path, file.digest);
      size += Buffer.byteLength(source);
      if (size > 128 * 1024 * 1024) throw new Error("Analysis copy size limit exceeded.");
      const destination = path.join(workspace, file.path);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, source, { mode: 0o600, flag: "wx" });
      sources.set(file.path, source);
    }
    return { container, workspace, sources, excludedFiles, cleanup };
  } catch { throw new StaticWorkspaceFailure(await cleanup(), sources.size, excludedFiles); }
}
