import { constants } from "node:fs";
import { lstat, opendir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { relativeFilePathSchema } from "../schemas/provenance.js";

export const RESOURCE_LIMITS = { depth: 32, files: 10000, entries: 20000, fileBytes: 8 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, parserBytes: 1024 * 1024, parserPunctuation: 20000, parserDepth: 128 } as const;
export function assertParserBudget(source: string): void {
  if (Buffer.byteLength(source) > RESOURCE_LIMITS.parserBytes) throw new RepositorySafetyError("LIMIT_EXCEEDED");
  let count = 0, depth = 0;
  for (const char of source) {
    if ("{}[]();<>".includes(char) && ++count > RESOURCE_LIMITS.parserPunctuation) throw new RepositorySafetyError("LIMIT_EXCEEDED");
    if ("{[(".includes(char)) depth++;
    else if ("}])".includes(char)) depth = Math.max(0, depth - 1);
    if (depth > RESOURCE_LIMITS.parserDepth) throw new RepositorySafetyError("LIMIT_EXCEEDED");
  }
}
export class RepositorySafetyError extends Error {
  constructor(readonly code: "LIMIT_EXCEEDED" | "UNSAFE_INPUT") { super(code === "LIMIT_EXCEEDED" ? "LIMIT_EXCEEDED: repository exceeds static analysis resource limits." : "UNSAFE_INPUT: repository path or file cannot be safely read."); }
}
export function sensitivePath(file: string): boolean {
  return file.split("/").some((part) => /^\.env(?:\..*)?$/iu.test(part) || /^(?:credentials[^/]*|id_rsa|id_ed25519|\.aws|\.ssh|\.npmrc|\.netrc)$/iu.test(part) || /\.(?:pem|key|p12|pfx)$/iu.test(part));
}
export function sensitiveText(source: string): boolean {
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if ((code < 32 && ![9, 10, 13].includes(code)) || code === 127 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return source.includes("/Users/") || source.includes("/home/") || /[a-z]:\\users\\/iu.test(source) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(source) || /\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,})/u.test(source) ||
    /https?:\/\/[^\s/]{1,256}:[^\s/]{1,256}@/iu.test(source) || /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["'][^"'\r\n]{8,}/iu.test(source);
}
export async function repositoryInventory(root: string) {
  const files: string[] = [], skipped: string[] = [];
  let entries = 0;
  const ignored = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > RESOURCE_LIMITS.depth) throw new RepositorySafetyError("LIMIT_EXCEEDED");
    for await (const item of await opendir(path.join(root, directory))) {
      if (++entries > RESOURCE_LIMITS.entries) throw new RepositorySafetyError("LIMIT_EXCEEDED");
      const relative = directory ? `${directory}/${item.name}` : item.name;
      if (!relativeFilePathSchema.safeParse(relative).success) throw new RepositorySafetyError("UNSAFE_INPUT");
      if (sensitivePath(relative)) { skipped.push(relative); continue; }
      if (item.isSymbolicLink()) { skipped.push(relative); continue; }
      if (item.isDirectory()) { if (!ignored.has(item.name)) await walk(relative, depth + 1); }
      else if (item.isFile()) { files.push(relative); if (files.length > RESOURCE_LIMITS.files) throw new RepositorySafetyError("LIMIT_EXCEEDED"); }
      else skipped.push(relative);
    }
  }
  await walk("", 0);
  return { files: files.sort(), skipped: skipped.sort() };
}
async function readSafeBytesUnchecked(root: string, relative: string): Promise<Buffer> {
  if (!relativeFilePathSchema.safeParse(relative).success || sensitivePath(relative)) throw new RepositorySafetyError("UNSAFE_INPUT");
  if ((await lstat(root)).isSymbolicLink()) throw new RepositorySafetyError("UNSAFE_INPUT");
  const canonical = await realpath(root);
  let file = canonical;
  for (const segment of relative.split("/")) {
    file = path.join(file, segment);
    if ((await lstat(file)).isSymbolicLink()) throw new RepositorySafetyError("UNSAFE_INPUT");
  }
  if (!(await realpath(file)).startsWith(`${canonical}${path.sep}`)) throw new RepositorySafetyError("UNSAFE_INPUT");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new RepositorySafetyError("UNSAFE_INPUT");
    if (info.size > RESOURCE_LIMITS.fileBytes) throw new RepositorySafetyError("LIMIT_EXCEEDED");
    // Fixed allocation avoids unbounded readFile allocation if a file grows after stat.
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > info.size) throw new RepositorySafetyError("UNSAFE_INPUT");
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

export async function readSafeBytes(root: string, relative: string): Promise<Buffer> {
  try { return await readSafeBytesUnchecked(root, relative); }
  catch (error) { throw error instanceof RepositorySafetyError ? error : new RepositorySafetyError("UNSAFE_INPUT"); }
}
