import { readSafeBytes, repositoryInventory, RESOURCE_LIMITS } from "../repo/safety.js";
import { hashContent } from "../utils/content-hash.js";

/** Execution bytes include opaque runtime assets (e.g. index.html), not new
 * design evidence. Scanner snapshot is intentionally narrower than a runnable copy. */
export const executionFingerprint = (files: ReadonlyMap<string, string>) => hashContent(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b, "en")).map(([p, s]) => [p, hashContent(s)])));
export async function readExecutionBaseline(root: string) {
  const inventory = await repositoryInventory(root);
  if (inventory.skipped.length) throw new Error("UNSAFE_WORKSPACE_ENTRY");
  const files = new Map<string, string>(); let size = 0;
  for (const file of inventory.files) {
    const bytes = await readSafeBytes(root, file), text = bytes.toString("utf8");
    size += bytes.length;
    if (size > RESOURCE_LIMITS.totalBytes || !Buffer.from(text).equals(bytes)) throw new Error("UNSUPPORTED_EXECUTION_BASELINE");
    files.set(file, text);
  }
  return files;
}
