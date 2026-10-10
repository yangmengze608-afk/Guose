// Deliberately bounded grammar, not a browser CSS validity oracle. Aliases,
// calculations, relative colors and unsupported names require more evidence.
export function isStaticColorSyntax(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.test(normalized)) return true;
  if (/^(?:black|white|transparent|currentcolor)$/u.test(normalized)) return true;
  const match = /^(rgb|rgba|hsl|hsla|lab|lch|oklab|oklch)\((.*)\)$/u.exec(normalized);
  if (match === null) return false;
  const body = match[2] ?? "";
  const scalar = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/u;
  const hue = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:deg|rad|grad|turn)?$/u;
  const commaSyntax = body.includes(",");
  if (commaSyntax && (body.includes("/") || !["rgb", "rgba", "hsl", "hsla"].includes(match[1] ?? ""))) return false;
  const parts = body.split("/");
  if (parts.length > 2) return false;
  const channels = commaSyntax
    ? body.split(",").map((part) => part.trim())
    : (parts[0] ?? "").trim().split(/\s+/u);
  const alpha = commaSyntax && channels.length === 4
    ? channels.pop() : parts[1]?.trim();
  if (channels.length !== 3 || (alpha !== undefined && !scalar.test(alpha))) return false;
  const functionName = match[1] ?? "";
  return channels.every((channel, index) => {
    if ((functionName.startsWith("hsl") && index === 0) ||
        (["lch", "oklch"].includes(functionName) && index === 2)) return hue.test(channel);
    if (functionName.startsWith("hsl")) return scalar.test(channel) && channel.endsWith("%");
    return scalar.test(channel);
  });
}
