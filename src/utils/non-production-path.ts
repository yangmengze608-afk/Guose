/** Conservative filenames are exclusion signals, not proof of code ownership. */
export function obviousNonProductionPath(file: string): "VENDOR" | "GENERATED" | null {
  const normalized = file.toLowerCase();
  if (/(?:^|\/)(?:vendor|third[-_]party)(?:\/|\.[^/]+$)/u.test(normalized)) return "VENDOR";
  if (/(?:^|\/)(?:generated|__generated__)(?:\/|\.[^/]+$)|\.min\.[^/]+$/u.test(normalized)) return "GENERATED";
  return null;
}
