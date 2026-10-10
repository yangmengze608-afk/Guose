import { describe, expect, it } from "vitest";
import { loadStylePack } from "../src/style-packs/index.js";
import { stylePackDefinitionSchema, stylePackSchema } from "../src/schemas/index.js";

describe("bundled style pack", () => {
  it("loads the single immutable authored target policy deterministically", async () => {
    const first = await loadStylePack("neutral-modern");
    expect(first).toEqual(await loadStylePack("neutral-modern"));
    expect(first.sourceKind).toBe("AUTHORED_TARGET_POLICY");
    expect(first.semanticTokens.primary).toBe("#18181b");
    expect(Object.isFrozen(first.semanticTokens)).toBe(true);
    expect(stylePackSchema.safeParse(first).success).toBe(true);
  });
  it("rejects arbitrary paths and unsupported packs", async () => {
    await expect(loadStylePack("../../package.json")).rejects.toThrow("Unsupported style pack");
    await expect(loadStylePack("modern-song")).rejects.toThrow("only neutral-modern");
  });
  it("rejects invalid color syntax, extra fields and tampered fingerprints", async () => {
    const pack = await loadStylePack("neutral-modern");
    expect(stylePackSchema.safeParse({ ...pack, contentFingerprint: `sha256:${"0".repeat(64)}` }).success).toBe(false);
    const { contentFingerprint, ...definition } = pack;
    expect(contentFingerprint).toMatch(/^sha256:/u);
    expect(stylePackDefinitionSchema.safeParse({ ...definition, semanticTokens: { primary: "rgb(nonsense)" } }).success).toBe(false);
    expect(stylePackDefinitionSchema.safeParse({ ...definition, webUi: true }).success).toBe(false);
  });
});
