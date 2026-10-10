import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import { z } from "zod";
import { planMigration } from "../planner/index.js";
import { detectRepository, readValidatedRepository } from "../repo/index.js";
import { evidenceReferenceSchema, sourceLocationSchema, relativeFilePathSchema, sha256DigestSchema, gitObjectIdSchema, MIGRATION_POLICY_VERSION, type ReadonlyEvidenceBundle, type ReadonlyStylePack } from "../schemas/index.js";
import { createBundleContentFingerprint, hashContent } from "../utils/content-hash.js";
import { deepFreeze } from "../utils/deep-freeze.js";
import { unifiedDiff } from "./diff.js";
import { obviousNonProductionPath } from "../utils/non-production-path.js";
import { readSafeBytes, sensitiveText } from "../repo/safety.js";

const editSchema = z.object({
  offsetUnit: z.literal("UTF16_CODE_UNITS"),
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
  before: z.string().min(1), after: z.string().min(1),
  planItemId: z.string().min(1), evidenceId: z.string().min(1), status: z.literal("INFERRED"),
  decision: z.literal("REVIEW_REQUIRED"),
  evidenceIds: z.array(z.string().min(1)).min(1),
  mappingEvidence: z.array(evidenceReferenceSchema.extend({ source: sourceLocationSchema })).min(1),
  reasonCodes: z.array(z.string().min(1)).min(1), risk: z.enum(["MEDIUM", "HIGH"]),
  role: z.string().min(1),
}).strict().superRefine((edit, context) => {
  if (edit.start >= edit.end || !edit.evidenceIds.includes(edit.evidenceId) ||
      new Set(edit.evidenceIds).size !== edit.evidenceIds.length ||
      JSON.stringify([...edit.evidenceIds].sort()) !== JSON.stringify(edit.mappingEvidence.map(({ evidenceId }) => evidenceId).sort())) {
    context.addIssue({ code: "custom", message: "Edit range and complete unique mapping provenance must reconcile." });
  }
});
export const dryRunPatchSchema = z.object({
  schemaVersion: z.literal("1.0.0"), status: z.literal("OBSERVED"), dryRunOnly: z.literal(true),
  reviewRequired: z.literal(true), lane: z.enum(["literals", "tokens"]),
  source: z.object({ evidenceFingerprint: sha256DigestSchema, planFingerprint: sha256DigestSchema,
    recoveryFingerprint: sha256DigestSchema, workingTreeFingerprint: sha256DigestSchema,
    configHash: sha256DigestSchema, gitHead: gitObjectIdSchema.nullable(), guoseVersion: z.string().min(1),
    policyVersion: z.literal(MIGRATION_POLICY_VERSION),
    stylePack: z.object({ id: z.literal("neutral-modern"), version: z.string().min(1), contentFingerprint: sha256DigestSchema }).strict(),
  }).strict(),
  contentFingerprint: sha256DigestSchema,
  files: z.array(z.object({ file: relativeFilePathSchema, beforeDigest: sha256DigestSchema, afterDigest: sha256DigestSchema,
    edits: z.array(editSchema).min(1), diff: z.string().min(1), reverseDiff: z.string().min(1) }).strict()),
  omitted: z.array(z.object({ planItemId: z.string(), reason: z.string() }).strict()),
  diff: z.string(), reverseDiff: z.string(), limitations: z.array(z.string()).min(1),
}).strict().superRefine(({ contentFingerprint, ...payload }, context) => {
  if (contentFingerprint !== createBundleContentFingerprint(payload)) context.addIssue({ code: "custom", message: "Patch fingerprint mismatch." });
  if (new Set(payload.files.map(({ file }) => file)).size !== payload.files.length ||
      payload.diff !== payload.files.map(({ diff }) => diff).join("") ||
      payload.reverseDiff !== payload.files.map(({ reverseDiff }) => reverseDiff).join("")) context.addIssue({ code: "custom", message: "Patch files/diffs must reconcile." });
});
export type DryRunPatch = z.infer<typeof dryRunPatchSchema>;

/** Does not write to target. Rejects symlink components and stale file bytes. */
async function readBoundFile(root: string, file: string, digest: string): Promise<string> {
  relativeFilePathSchema.parse(file);
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Symlink analysis root is not supported for patch materialization.");
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of file.split("/")) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Symlink source is not patchable.");
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("Source escaped analysis root.");
  const bytes = await readSafeBytes(root, file);
  if (hashContent(bytes) !== digest) throw new Error(`STALE source file: ${file}`);
  const source = bytes.toString("utf8");
  if (sensitiveText(source)) throw new Error("Recognized sensitive patch context rejected.");
  return source;
}

export async function generateDryRunPatch(inputBundle: ReadonlyEvidenceBundle, pack: ReadonlyStylePack, lane: "literals" | "tokens" = "literals") {
  // Validate a cloned payload before trusting its fingerprint, root or records.
  // Never keep reading the caller's potentially mutable/unvalidated object.
  const { bundle, root } = await readValidatedRepository(inputBundle);
  if (lane !== "literals" && lane !== "tokens") throw new Error("Patch lane must be literals or tokens.");
  const current = await detectRepository(root);
  if (current.contentFingerprint !== bundle.contentFingerprint) throw new Error("STALE evidence: repository content/config/Git identity changed.");
  // Recompute the plan from facts: no caller-supplied authorization artifact.
  const plan = planMigration(bundle, pack);
  const observations = new Map(bundle.observations.map((item) => [item.id, item]));
  const snapshots = new Map(bundle.snapshot.files.map((item) => [item.path, item]));
  const pending = new Map<string, z.infer<typeof editSchema>[]>();
  const contents = new Map<string, string>();
  const omitted: DryRunPatch["omitted"] = [];
  const desiredKind = lane === "literals" ? "RAW_LITERAL_REPLACEMENT" : "TOKEN_POLICY_CHANGE";
  for (const item of plan.items) {
    if (item.kind !== desiredKind) continue;
    if (item.status !== "INFERRED" || item.decision !== "REVIEW_REQUIRED" || item.target === null || item.blockingUnknownIds.length) {
      omitted.push({ planItemId: item.id, reason: "No selected reviewable target, unresolved evidence, or DO_NOT_TOUCH." });
      continue;
    }
    for (const reference of item.evidence) {
      const evidence = observations.get(reference.evidenceId);
      if (!evidence || typeof evidence.value !== "object" || evidence.value === null || evidence.source.type !== "SPAN") continue;
      const data = evidence.value as Record<string, unknown>;
      if ((lane === "literals" && evidence.kind !== "design_value_usage") || (lane === "tokens" && evidence.kind !== "design_token_declaration")) continue;
      const span = evidence.source;
      const { file } = span;
      if (obviousNonProductionPath(file) !== null) {
        omitted.push({ planItemId: item.id, reason: "Conservative generated/vendor path deny gate." }); continue;
      }
      const snapshot = snapshots.get(file);
      if (!snapshot || !file.endsWith(".css")) throw new Error("Missing CSS snapshot for candidate.");
      let source = contents.get(file);
      if (source === undefined) { source = await readBoundFile(root, file, snapshot.digest); contents.set(file, source); }
      const parsed = postcss.parse(source, { from: file });
      let selected: postcss.Declaration | undefined;
      parsed.walkDecls((declaration) => {
        const start = declaration.source?.start, end = declaration.source?.end;
        if (start && end && start.line === span.startLine && start.column - 1 === span.startColumn &&
            end.line === span.endLine && end.column === span.endColumn) selected = declaration;
      });
      if (!selected || selected.source?.start?.offset === undefined || typeof data.rawValue !== "string" || selected.value !== data.rawValue) {
        omitted.push({ planItemId: item.id, reason: "Exact declaration/value provenance could not be re-established." }); continue;
      }
      const declaration = selected;
      const property = declaration.prop;
      if ((lane === "literals" && !["color", "background-color", "border-color"].includes(property.toLowerCase())) ||
          (lane === "tokens" && property !== data.name) || declaration.important) {
        omitted.push({ planItemId: item.id, reason: "Unsupported property or !important declaration." }); continue;
      }
      // Exact value bytes only. Comments, escape spellings and multiline values
      // fail this grammar; no serialization/formatting of the whole stylesheet.
      const start = (declaration.source?.start?.offset ?? 0) + property.length + (declaration.raws.between ?? ":").length;
      const end = start + declaration.value.length;
      if (source.slice(start, end) !== declaration.value || /[\r\n]/u.test(declaration.value) || /[\r\n]/u.test(item.target)) {
        omitted.push({ planItemId: item.id, reason: "Value is not an exact single-line byte slice." }); continue;
      }
      const edit = editSchema.parse({ offsetUnit: "UTF16_CODE_UNITS", start, end, before: declaration.value, after: item.target,
        planItemId: item.id, evidenceId: evidence.id, status: "INFERRED", decision: "REVIEW_REQUIRED",
        evidenceIds: item.evidence.map(({ evidenceId }) => evidenceId),
        mappingEvidence: item.evidence.map((reference) => {
          const sourceRecord = observations.get(reference.evidenceId);
          if (!sourceRecord) throw new Error("Missing mapping evidence source");
          return { ...reference, source: sourceRecord.source };
        }), reasonCodes: item.reasonCodes, risk: item.risk, role: item.role,
      });
      const edits = pending.get(file) ?? [];
      if (!edits.some((other) => other.start === start && other.end === end && other.after === edit.after)) edits.push(edit);
      pending.set(file, edits);
    }
  }
  const files: DryRunPatch["files"] = [];
  for (const [file, edits] of [...pending].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const before = contents.get(file);
    if (before === undefined) throw new Error("Missing bound source");
    const ordered = edits.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) if ((ordered[i - 1]?.end ?? 0) > (ordered[i]?.start ?? 0)) throw new Error("Overlapping edits are not supported.");
    let after = before;
    for (const edit of [...ordered].reverse()) after = after.slice(0, edit.start) + edit.after + after.slice(edit.end);
    postcss.parse(after, { from: file });
    // A final read detects changes during generation; it is not a filesystem lock.
    await readBoundFile(root, file, hashContent(before));
    if (before !== after) files.push({ file, beforeDigest: hashContent(before), afterDigest: hashContent(after), edits: ordered,
      diff: unifiedDiff(file, before, after), reverseDiff: unifiedDiff(file, after, before) });
  }
  const payload = { schemaVersion: "1.0.0" as const, status: "OBSERVED" as const, dryRunOnly: true as const, reviewRequired: true as const, lane,
    source: { evidenceFingerprint: bundle.contentFingerprint, planFingerprint: plan.contentFingerprint,
      recoveryFingerprint: plan.source.recoveryFingerprint, workingTreeFingerprint: bundle.snapshot.workingTreeFingerprint,
      configHash: bundle.snapshot.configHash, gitHead: bundle.snapshot.gitHead, guoseVersion: bundle.snapshot.guoseVersion,
      policyVersion: plan.policyVersion, stylePack: plan.source.stylePack }, files, omitted,
    diff: files.map(({ diff }) => diff).join(""), reverseDiff: files.map(({ reverseDiff }) => reverseDiff).join(""),
    limitations: ["Review hypotheses only; do not apply without human review. Runtime behavior and contrast are unverified.",
      "Literal substitutions and authored token-policy changes are separate lanes, never combined.",
      "Single-line exact CSS values only; no Tailwind rewrite, formatting, import changes or unrelated refactor.",
      "Path checks reject symlinks but do not establish protection against a concurrently hostile filesystem."] };
  if ((await detectRepository(root)).contentFingerprint !== bundle.contentFingerprint) throw new Error("STALE evidence: repository changed during patch generation.");
  return deepFreeze(dryRunPatchSchema.parse({ ...payload, contentFingerprint: createBundleContentFingerprint(payload) }));
}
