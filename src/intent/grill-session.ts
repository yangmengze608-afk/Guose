import { z } from "zod";
import { designBriefSchema, relativeFilePathSchema } from "../schemas/index.js";
import type { DesignBrief } from "../schemas/index.js";
import { createBundleContentFingerprint, hashContent } from "../utils/content-hash.js";
import { deepFreeze } from "../utils/deep-freeze.js";

export const BRIEF_FIELDS = ["goal", "style", "keywords", "traditionalStrength", "preserve", "modify", "avoid", "scope", "intensity", "allowLayoutChange", "unresolvedQuestions"] as const;
export type BriefField = typeof BRIEF_FIELDS[number];
export const GRILL_SECTIONS = ["Intent", "Constraints", "Key decisions", "Surfaced assumptions", "Open questions", "Out of scope"] as const;
type GrillSection = typeof GRILL_SECTIONS[number];
const bindingSchema = z.object({
  value: z.unknown(),
  citations: z.array(z.object({ section: z.enum(GRILL_SECTIONS), quote: z.string().min(1).max(8000) }).strict()).min(1).max(8),
}).strict();
export type GrillFieldBinding = z.infer<typeof bindingSchema>;
export type GrillBindings = Partial<Record<BriefField, GrillFieldBinding>>;
export type IntentCitation = { sourceId: string; section: GrillSection; quote: string; startLine: number; endLine: number };
export type DraftField = { status: "MISSING" | "NEEDS_CONFIRMATION"; sourceKind: "GRILL_SESSION" | "HUMAN_EDIT" | "NONE"; citations: IntentCitation[] };
export type DesignBriefDraft = {
  status: "DRAFT"; sessionFingerprint: string; sourceId: string;
  sections: Partial<Record<GrillSection, string>>;
  candidate: Record<string, unknown>; fields: Record<BriefField, DraftField>;
  missing: BriefField[]; parseIssues: string[]; validationIssues: string[];
  brief: DesignBrief | null; canConfirm: boolean; fingerprint: string;
};

export function finalizeBriefDraft(input: Omit<DesignBriefDraft, "status" | "missing" | "validationIssues" | "brief" | "canConfirm" | "fingerprint">): DesignBriefDraft {
  const parsed = designBriefSchema.safeParse(input.candidate);
  const missing = BRIEF_FIELDS.filter((field) => field !== "unresolvedQuestions" && input.candidate[field] === undefined);
  const payload = {
    status: "DRAFT" as const, ...input, missing,
    validationIssues: parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`),
    brief: parsed.success ? parsed.data : null,
    canConfirm: parsed.success && input.parseIssues.length === 0 && (parsed.data.unresolvedQuestions?.length ?? 0) === 0,
  };
  return deepFreeze({ ...payload, fingerprint: createBundleContentFingerprint(payload) });
}

/** Parse native Markdown, not aesthetic meaning. Typed bindings are reviewable
 * proposals with exact source quotes, never OBSERVED code facts or approvals. */
export function parseGrillSession(markdown: string, bindings: GrillBindings = {}, sourceId = ".grill/session.md"): DesignBriefDraft {
  z.string().min(1).max(65536).parse(markdown);
  relativeFilePathSchema.parse(sourceId);
  const proposed = z.record(z.string(), bindingSchema).parse(bindings);
  const rows: Partial<Record<GrillSection, { text: string; line: number }[]>> = {};
  const parseIssues: string[] = [];
  let current: GrillSection | null = null;
  let fence: string | null = null;
  let title = false, date = false;
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");
  lines.forEach((text, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(text)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && text.trim() === marker) fence = null;
      return;
    }
    if (fence !== null) return;
    if (/^# Grill: \S/u.test(text)) { title = true; return; }
    if (text.startsWith("Date: ")) { date = z.iso.date().safeParse(text.slice(6).trim()).success; return; }
    if (text.startsWith("## ")) {
      const name = text.slice(3).trim();
      if (!GRILL_SECTIONS.some((section) => section === name)) { parseIssues.push(`Unsupported section: ${name}`); current = null; return; }
      current = name as GrillSection;
      if (rows[current]) parseIssues.push(`Duplicate section: ${current}`);
      else rows[current] = [];
      return;
    }
    if (current !== null) rows[current]?.push({ text, line: index + 1 });
  });
  if (!title || !date) parseIssues.push("Native Grill title and ISO date are required.");
  if (fence !== null) parseIssues.push("Unclosed Markdown fence.");
  const sections: DesignBriefDraft["sections"] = {};
  for (const section of GRILL_SECTIONS) {
    if (rows[section]) sections[section] = rows[section].map((row) => row.text).join("\n").trim();
  }
  if (!sections.Intent) parseIssues.push("Native Intent is missing.");
  const candidate: Record<string, unknown> = {};
  const missingField = (): DraftField => ({ status: "MISSING", sourceKind: "NONE", citations: [] });
  const fields: Record<BriefField, DraftField> = {
    goal: missingField(), style: missingField(), keywords: missingField(), traditionalStrength: missingField(),
    preserve: missingField(), modify: missingField(), avoid: missingField(), scope: missingField(),
    intensity: missingField(), allowLayoutChange: missingField(), unresolvedQuestions: missingField(),
  };
  const assign = (field: BriefField, value: unknown, citations: IntentCitation[]) => {
    const parsed = designBriefSchema.shape[field].safeParse(value);
    if (!parsed.success) { parseIssues.push(`Invalid proposed ${field}; retain MISSING.`); return; }
    candidate[field] = parsed.data;
    fields[field] = { status: "NEEDS_CONFIRMATION", sourceKind: "GRILL_SESSION", citations };
  };
  if (sections.Intent) {
    const content = rows.Intent?.filter((row) => row.text.trim()) ?? [];
    assign("goal", sections.Intent, content.map((row) => ({ sourceId, section: "Intent", quote: row.text, startLine: row.line, endLine: row.line })));
  }
  for (const [key, binding] of Object.entries(proposed)) {
    if (!BRIEF_FIELDS.some((field) => field === key)) throw new Error(`Unknown Brief field: ${key}`);
    const citations: IntentCitation[] = [];
    for (const citation of binding.citations) {
      const matches = (rows[citation.section] ?? []).filter((row) => row.text.includes(citation.quote));
      if (matches.length !== 1 || matches[0]!.text.split(citation.quote).length !== 2) {
        parseIssues.push(`Missing or ambiguous citation for ${key}.`); continue;
      }
      citations.push({ sourceId, ...citation, startLine: matches[0]!.line, endLine: matches[0]!.line });
    }
    if (citations.length === binding.citations.length) assign(key as BriefField, binding.value, citations);
  }
  if (sections["Open questions"]) {
    const questions = (rows["Open questions"] ?? []).filter((row) => row.text.trim());
    // A mapping proposal cannot silently erase native open questions.
    assign("unresolvedQuestions", questions.map((row) => row.text.replace(/^\s*[-*] /u, "")), questions.map((row) => ({
      sourceId, section: "Open questions", quote: row.text, startLine: row.line, endLine: row.line,
    })));
  }
  return finalizeBriefDraft({ sessionFingerprint: hashContent(markdown), sourceId, sections, candidate, fields, parseIssues });
}
