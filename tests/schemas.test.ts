import { describe, expect, it } from "vitest";

import {
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  evidenceBundleSchema,
  inferenceSchema,
  sourceSpanSchema,
  unknownSchema,
} from "../src/schemas/index.js";
import { createBundleContentFingerprint } from "../src/utils/content-hash.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const initialPayload = {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    snapshot: {
      gitHead: null,
      gitDirty: null,
      gitStateReason: "NOT_GIT_REPOSITORY",
      workingTreeFingerprint: DIGEST,
      configHash: DIGEST,
      files: [],
      stylePack: null,
      guoseVersion: "0.1.0-dev.0",
      createdAt: "2026-09-22T00:00:00.000Z",
    },
    repository: {
      root: ".",
      frameworks: ["react"],
      stylingSystems: ["tailwind"],
      supportStatus: "SUPPORTED",
    },
    observations: [],
    inferences: [],
    unknowns: [],
    provenance: { sources: [], edges: [] },
  };
  const { contentFingerprint, ...payloadOverrides } = overrides;
  const payload = { ...initialPayload, ...payloadOverrides };
  const snapshot = payload.snapshot;
  return {
    ...payload,
    contentFingerprint:
      contentFingerprint ??
      createBundleContentFingerprint({
        ...payload,
        snapshot: { ...snapshot, createdAt: "" },
      }),
  };
}

describe("evidence schemas", () => {
  it("accepts a minimal evidence bundle", () => {
    const parsed = evidenceBundleSchema.parse(bundle());

    expect(parsed.schemaVersion).toBe("1.0.0");
  });

  it("rejects inference without supporting evidence", () => {
    expect(() =>
      inferenceSchema.parse({
        id: "inference:primary",
        status: "INFERRED",
        kind: "semantic_role",
        value: "primary",
        rationale: "Conflicting evidence only.",
        evidence: [
          { evidenceId: "observed:1", relationship: "CONFLICTS" },
        ],
      }),
    ).toThrow();
  });

  it("rejects reversed source spans", () => {
    expect(() =>
      sourceSpanSchema.parse({
        type: "SPAN",
        file: "src/App.tsx",
        startLine: 2,
        startColumn: 5,
        endLine: 2,
        endColumn: 4,
      }),
    ).toThrow();
  });

  it("rejects duplicate ids and dangling inference references", () => {
    const source = { type: "FILE", file: "package.json" } as const;
    expect(() =>
      evidenceBundleSchema.parse(
        bundle({
          snapshot: {
            ...(bundle().snapshot as object),
            files: [{ path: "package.json", digest: DIGEST, lineCount: 1 }],
          },
          observations: [
            { id: "same", status: "OBSERVED", kind: "x", value: 1, source },
          ],
          inferences: [
            {
              id: "same",
              status: "INFERRED",
              kind: "role",
              value: "primary",
              rationale: "test",
              evidence: [
                { evidenceId: "missing", relationship: "SUPPORTS" },
              ],
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects contradictory references and unsafe source paths", () => {
    expect(() =>
      evidenceBundleSchema.parse(
        bundle({
          snapshot: {
            ...(bundle().snapshot as object),
            files: [{ path: "src/App.tsx", digest: DIGEST, lineCount: 1 }],
          },
          observations: [
            {
              id: "observed:1",
              status: "OBSERVED",
              kind: "x",
              value: 1,
              source: { type: "FILE", file: "../outside.ts" },
            },
          ],
          inferences: [
            {
              id: "inferred:1",
              status: "INFERRED",
              kind: "role",
              value: "primary",
              rationale: "test",
              evidence: [
                { evidenceId: "observed:1", relationship: "SUPPORTS" },
                { evidenceId: "observed:1", relationship: "CONFLICTS" },
              ],
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects malformed digest values", () => {
    expect(() =>
      evidenceBundleSchema.parse(
        bundle({ contentFingerprint: "sha256:not-a-real-digest" }),
      ),
    ).toThrow();
  });

  it("rejects syntactically valid but incorrect content fingerprints", () => {
    expect(() =>
      evidenceBundleSchema.parse(bundle({ contentFingerprint: DIGEST })),
    ).toThrow();
  });

  it("rejects incomplete UNKNOWN records at the standalone schema boundary", () => {
    expect(
      unknownSchema.safeParse({
        id: "unknown:unsupported",
        status: "UNKNOWN",
        kind: "framework_support",
        reasonCode: "UNSUPPORTED",
        reason: "unsupported",
        relatedEvidenceIds: [],
      }).success,
    ).toBe(false);
  });

  it("rejects inconsistent Git state", () => {
    expect(() =>
      evidenceBundleSchema.parse(
        bundle({
          snapshot: {
            ...(bundle().snapshot as object),
            gitHead: "b".repeat(40),
            gitDirty: true,
            gitStateReason: "GIT_UNAVAILABLE",
          },
        }),
      ),
    ).toThrow();
  });

  it("rejects duplicate manifest paths and portable-unsafe paths", () => {
    expect(() =>
      evidenceBundleSchema.parse(
        bundle({
          snapshot: {
            ...(bundle().snapshot as object),
            files: [
              { path: "package.json", digest: DIGEST, lineCount: 1 },
              { path: "package.json", digest: DIGEST, lineCount: 1 },
            ],
          },
        }),
      ),
    ).toThrow();

    expect(() =>
      sourceSpanSchema.parse({
        type: "SPAN",
        file: "\\\\server\\share\\App.tsx",
        startLine: 1,
        startColumn: 0,
        endLine: 1,
        endColumn: 1,
      }),
    ).toThrow();
  });
});
