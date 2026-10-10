import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProvenanceGraph } from "../src/provenance/index.js";
import { detectRepository } from "../src/repo/index.js";
import { evidenceBundleSchema } from "../src/schemas/index.js";
import { createBundleContentFingerprint } from "../src/utils/content-hash.js";

const temporaryDirectories: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "guose-provenance-"));
  temporaryDirectories.push(root);
  await Promise.all(
    Object.entries(files).map(async ([relativeFile, content]) => {
      const destination = path.join(root, relativeFile);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("provenance graph", () => {
  it("deduplicates source nodes while retaining every evidence-to-source edge", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/app.css": ":root { --primary: #6366f1; }\n",
    });

    const result = await detectRepository(root);
    const declaration = result.observations.find(({ id }) =>
      id.startsWith("css-variable:src/app.css:"),
    );
    const color = result.observations.find(({ id }) =>
      id.startsWith("css-color:src/app.css:"),
    );
    expect(declaration).toBeDefined();
    expect(color).toBeDefined();

    const declarationEdge = result.provenance.edges.find(
      ({ from, relationship }) =>
        from === declaration?.id && relationship === "LOCATED_AT",
    );
    const colorEdge = result.provenance.edges.find(
      ({ from, relationship }) =>
        from === color?.id && relationship === "LOCATED_AT",
    );
    expect(declarationEdge?.to).toBe(colorEdge?.to);
    expect(
      result.provenance.sources.filter(({ id }) => id === declarationEdge?.to),
    ).toHaveLength(1);
  });

  it("materializes support, conflict, related, and location relationships deterministically", () => {
    const source = { type: "FILE", file: "src/App.tsx" } as const;
    const graph = createProvenanceGraph({
      observations: [
        {
          id: "observed:one",
          source,
          contextEvidenceIds: ["observed:two"],
        },
        { id: "observed:two", source },
      ],
      inferences: [
        {
          id: "inferred:role",
          evidence: [
            { evidenceId: "observed:one", relationship: "SUPPORTS" },
            { evidenceId: "observed:two", relationship: "CONFLICTS" },
          ],
        },
      ],
      unknowns: [
        {
          id: "unknown:role",
          relatedEvidenceIds: ["observed:two"],
        },
      ],
    });

    expect(graph.sources).toHaveLength(1);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        {
          from: "observed:two",
          to: "observed:one",
          relationship: "CONTEXTUALIZES",
        },
        {
          from: "observed:one",
          to: "inferred:role",
          relationship: "SUPPORTS",
        },
        {
          from: "observed:two",
          to: "inferred:role",
          relationship: "CONFLICTS",
        },
        {
          from: "observed:two",
          to: "unknown:role",
          relationship: "RELATED_TO",
        },
      ]),
    );
    expect(graph).toEqual(
      createProvenanceGraph({
        observations: [
          {
            id: "observed:one",
            source,
            contextEvidenceIds: ["observed:two"],
          },
          { id: "observed:two", source },
        ],
        inferences: [
          {
            id: "inferred:role",
            evidence: [
              { evidenceId: "observed:one", relationship: "SUPPORTS" },
              { evidenceId: "observed:two", relationship: "CONFLICTS" },
            ],
          },
        ],
        unknowns: [
          {
            id: "unknown:role",
            relatedEvidenceIds: ["observed:two"],
          },
        ],
      }),
    );
  });

  it("rejects a graph that omits an evidence edge even with a fresh fingerprint", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/App.tsx":
        'export const App = () => <main className="bg-primary" />;\n',
    });
    const detected = await detectRepository(root);
    const clone = structuredClone(detected);
    const invalidGraph = {
      ...clone.provenance,
      edges: clone.provenance.edges.slice(0, -1),
    };
    const { contentFingerprint, ...payload } = { ...clone, provenance: invalidGraph };
    void contentFingerprint;
    const tampered = {
      ...payload,
      contentFingerprint: createBundleContentFingerprint({
        ...payload,
        snapshot: { ...payload.snapshot, createdAt: "" },
      }),
    };

    expect(evidenceBundleSchema.safeParse(tampered).success).toBe(false);
  });

  it("rejects a contextual edge whose component evidence does not exist", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/App.tsx":
        'export const App = () => <main className="bg-primary" />;\n',
    });
    const detected = await detectRepository(root);
    const observations = detected.observations.map((item) =>
      item.id.startsWith("tailwind-class:")
        ? { ...item, contextEvidenceIds: ["observed:missing-component"] }
        : item,
    );
    const provenance = createProvenanceGraph({
      observations,
      inferences: detected.inferences,
      unknowns: detected.unknowns,
    });
    const payload = {
      schemaVersion: detected.schemaVersion,
      snapshot: detected.snapshot,
      repository: detected.repository,
      observations,
      inferences: detected.inferences,
      unknowns: detected.unknowns,
      provenance,
    };
    const tampered = {
      ...payload,
      contentFingerprint: createBundleContentFingerprint({
        ...payload,
        snapshot: { ...payload.snapshot, createdAt: "" },
      }),
    };

    expect(evidenceBundleSchema.safeParse(tampered).success).toBe(false);
  });
});
