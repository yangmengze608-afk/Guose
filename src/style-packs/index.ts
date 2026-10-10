import { readFile } from "node:fs/promises";
import { stylePackDefinitionSchema, stylePackSchema, type ReadonlyStylePack } from "../schemas/style-pack.js";
import { createBundleContentFingerprint } from "../utils/content-hash.js";
import { deepFreeze } from "../utils/deep-freeze.js";

export async function loadStylePack(id: string): Promise<ReadonlyStylePack> {
  if (id !== "neutral-modern") throw new Error(`Unsupported style pack: ${id}. v0.1 supports only neutral-modern.`);
  // Fixed package-owned resource, never a target-repository path or executable.
  const source = await readFile(new URL("../../style-packs/neutral-modern/pack.json", import.meta.url), "utf8");
  const definition = stylePackDefinitionSchema.parse(JSON.parse(source));
  if (definition.id !== id) throw new Error("Bundled style pack identity mismatch.");
  return deepFreeze(stylePackSchema.parse({ ...definition, contentFingerprint: createBundleContentFingerprint(definition) }));
}
