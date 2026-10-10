/** Same-line edits only: three context lines, merged neighboring hunks. */
export function unifiedDiff(file: string, before: string, after: string): string {
  if (before === after) return "";
  const left = before.split("\n"), right = after.split("\n");
  const trailingNewline = before.endsWith("\n");
  if (trailingNewline) { left.pop(); right.pop(); }
  if (left.length !== right.length || trailingNewline !== after.endsWith("\n")) throw new Error("Patch must preserve line structure.");
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < left.length; i++) {
    if (left[i] === right[i]) continue;
    const start = Math.max(0, i - 3), end = Math.min(left.length, i + 4);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  const output = [`--- ${JSON.stringify(`a/${file}`)}`, `+++ ${JSON.stringify(`b/${file}`)}`];
  function line(prefix: string, text: string, index: number): void {
    output.push(`${prefix}${text}`);
    if (!trailingNewline && index === left.length - 1) output.push("\\ No newline at end of file");
  }
  for (const { start, end } of ranges) {
    output.push(`@@ -${start + 1},${end - start} +${start + 1},${end - start} @@`);
    for (let i = start; i < end; i++) {
      const oldLine = left[i], newLine = right[i];
      if (oldLine === undefined || newLine === undefined) throw new Error("Missing diff line");
      if (oldLine === newLine) line(" ", oldLine, i);
      else { line("-", oldLine, i); line("+", newLine, i); }
    }
  }
  return `${output.join("\n")}\n`;
}
