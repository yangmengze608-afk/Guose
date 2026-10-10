import postcss from "postcss";
import type { VerificationResult } from "../schemas/index.js";

const PAIRS = [["foreground", "background"], ["primary-foreground", "primary"], ["secondary-foreground", "secondary"], ["destructive-foreground", "destructive"]] as const;
function luminance(color: string): number | null {
  const short = /^#[0-9a-f]{3}$/iu.test(color);
  if (!short && !/^#[0-9a-f]{6}$/iu.test(color)) return null;
  const hex = short ? [...color.slice(1)].map((value) => value + value).join("") : color.slice(1);
  const linear = [0, 2, 4].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}
function roles(sources: ReadonlyMap<string, string>): Map<string, string | null> {
  const collected = new Map<string, { values: Set<string>; scoped: boolean }>();
  for (const [file, source] of sources) {
    if (!file.endsWith(".css")) continue;
    postcss.parse(source).walkDecls((declaration) => {
      const role = /^--(?:color-)?([a-z-]+)$/u.exec(declaration.prop)?.[1];
      if (!role) return;
      const entry = collected.get(role) ?? { values: new Set<string>(), scoped: false };
      entry.values.add(declaration.value.trim().toLowerCase());
      let node: postcss.Root | postcss.Rule | postcss.AtRule | postcss.Document | undefined = declaration.parent;
      if (!(node?.type === "rule" && node.selector.trim() === ":root")) entry.scoped = true;
      while (node) { if (node.type === "atrule" && node.name !== "layer") entry.scoped = true; node = node.parent; }
      collected.set(role, entry);
    });
  }
  return new Map([...collected].map(([role, entry]) => [role, !entry.scoped && entry.values.size === 1 ? [...entry.values][0] ?? null : null]));
}
function ratio(foreground: string | null | undefined, background: string | null | undefined): number | null {
  const left = foreground ? luminance(foreground) : null, right = background ? luminance(background) : null;
  return left === null || right === null ? null : (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}
export function checkStaticContrast(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, unresolvedCss: boolean): VerificationResult["contrast"] {
  const oldRoles = roles(before), newRoles = roles(after);
  return PAIRS.map(([foreground, background]) => {
    const beforeRatio = unresolvedCss ? null : ratio(oldRoles.get(foreground), oldRoles.get(background));
    const afterRatio = unresolvedCss ? null : ratio(newRoles.get(foreground), newRoles.get(background));
    return { pair: `${foreground}/${background}`, beforeRatio, afterRatio,
      status: afterRatio === null ? "UNVERIFIED" : afterRatio < 4.5 ? "FAIL" : "PASS",
      reason: afterRatio === null ? "No unique unconditional opaque hex pair, or unresolved CSS dependency; actual composition is UNVERIFIED."
        : afterRatio < 4.5 ? "Declared pair is below 4.5:1 ordinary-text reference threshold; actual usage/size remain unverified."
          : "Declared opaque pair meets 4.5:1 reference threshold; not proof of runtime accessibility or usage.",
    };
  });
}
