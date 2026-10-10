import { createHash } from "node:crypto";

export function hashContent(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

export function createBundleContentFingerprint(bundle: unknown): string {
  return hashContent(JSON.stringify(stableValue(bundle)));
}
