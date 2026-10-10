import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectRepository } from "../src/repo/index.js";
import { hashEntries } from "../src/repo/snapshot.js";

const temporaryDirectories: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "guose-detection-"));
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

describe("repository detection", () => {
  it("binds dependency provenance to root sections with matching version precedence, never nested overrides", async () => {
    const source = '{\n"dependencies": {"react":"19.0.0"},\n"peerDependencies":{"react":"18.0.0"},\n"devDependencies":{"react":"17.0.0","tailwindcss":"4.0.0"},\n"overrides":{"other":{"react":"16.0.0"}}\n}';
    const root = await fixture({ "package.json": source });
    const result = await detectRepository(root);
    const evidence = result.observations.find(({ id }) => id === "package-dependency:react");
    expect(evidence?.value).toEqual({ signal: "package_dependency", value: { name: "react", version: "19.0.0" } });
    expect(evidence?.source).toMatchObject({ type: "SPAN", startLine: 2, endLine: 2 });
  });

  it("uses the last duplicate root dependency section rather than a nested same-name section", async () => {
    const source = '{\n"dependencies":{"react":"17.0.0"},\n"dependencies":{"react":"19.0.0","tailwindcss":"4.0.0"},\n"custom":{"dependencies":{"react":"16.0.0"}}\n}';
    const result = await detectRepository(await fixture({ "package.json": source }));
    const evidence = result.observations.find(({ id }) => id === "package-dependency:react");
    expect(evidence?.value).toEqual({ signal: "package_dependency", value: { name: "react", version: "19.0.0" } });
    expect(evidence?.source).toMatchObject({ startLine: 3, endLine: 3 });
  });

  it("uses an unambiguous file-entry hash encoding", () => {
    expect(hashEntries([["a", "x\0b\0y"]])).not.toBe(
      hashEntries([
        ["a", "x"],
        ["b", "y"],
      ]),
    );
  });

  it("detects Next.js, React, Tailwind, shadcn, and CSS variables with source spans", async () => {
    const root = await fixture({
      "package.json": JSON.stringify(
        {
          dependencies: {
            next: "15.0.0",
            react: "19.0.0",
            tailwindcss: "4.0.0",
          },
        },
        null,
        2,
      ),
      "components.json": JSON.stringify({
        $schema: "https://ui.shadcn.com/schema.json",
        style: "new-york",
      }),
      "src/app.css": '@import "tailwindcss";\n:root { --primary: #111827; }\n',
    });

    const result = await detectRepository(root);

    expect(result.repository).toEqual({
      root: ".",
      frameworks: ["nextjs", "react"],
      stylingSystems: ["css-variables", "shadcn", "tailwind"],
      supportStatus: "SUPPORTED",
    });
    const reactEvidence = result.observations.find(
      ({ id }) => id === "package-dependency:react",
    );
    const variableEvidence = result.observations.find(
      ({ id }) => id === "css-variables:src/app.css",
    );
    expect(reactEvidence?.source).toMatchObject({
      file: "package.json",
      startLine: 4,
    });
    expect(variableEvidence?.source).toMatchObject({
      file: "src/app.css",
      startLine: 2,
    });
  });

  it("marks unsupported framework evidence explicitly", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { vue: "3.5.0" } }),
    });

    const result = await detectRepository(root);

    expect(result.repository.supportStatus).toBe("UNSUPPORTED");
    expect(result.repository.frameworks).toEqual(["vue"]);
    expect(result.unknowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "UNKNOWN",
          kind: "framework_support",
        }),
      ]),
    );
  });

  it("does not load or execute JavaScript configuration", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "tailwind.config.js":
        'throw new Error("Guose must never execute this file");\nexport default {};\n',
    });

    await expect(detectRepository(root)).resolves.toMatchObject({
      repository: { supportStatus: "SUPPORTED" },
    });
  });

  it("changes the working-tree fingerprint when a TSX file changes", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/App.tsx": "export const App = () => <main>A</main>;\n",
    });
    const first = await detectRepository(root);
    await writeFile(
      path.join(root, "src/App.tsx"),
      "export const App = () => <main>B</main>;\n",
      "utf8",
    );
    const second = await detectRepository(root);

    expect(second.snapshot.workingTreeFingerprint).not.toBe(
      first.snapshot.workingTreeFingerprint,
    );
    expect(second.contentFingerprint).not.toBe(first.contentFingerprint);
  });

  it("keeps content identity stable when only scan time changes", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
    });

    const first = await detectRepository(root);
    const second = await detectRepository(root);

    expect(second.contentFingerprint).toBe(first.contentFingerprint);
  });

  it("returns a recursively frozen evidence bundle", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
    });

    const result = await detectRepository(root);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.observations)).toBe(true);
    expect(Object.isFrozen(result.snapshot.files)).toBe(true);
  });

  it("does not promote invalid dependency values to observed support", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: null, tailwindcss: null },
      }),
    });

    const result = await detectRepository(root);

    expect(result.repository.supportStatus).toBe("UNSUPPORTED");
    expect(result.observations).toHaveLength(0);
    expect(result.unknowns.some(({ id }) => id === "unknown:package-json-format")).toBe(
      true,
    );
  });

  it("does not infer shadcn from an unrelated components.json filename", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "components.json": JSON.stringify({ components: ["header", "footer"] }),
    });

    const result = await detectRepository(root);

    expect(result.repository.stylingSystems).toEqual(["tailwind"]);
    expect(result.observations.some(({ id }) => id === "config:components.json")).toBe(
      false,
    );
  });

  it("explains why a repository without React is unsupported", async () => {
    const root = await fixture({ "package.json": "{\"private\":true}\n" });

    const result = await detectRepository(root);

    expect(result.repository.supportStatus).toBe("UNSUPPORTED");
    expect(result.unknowns).toContainEqual(
      expect.objectContaining({ id: "unknown:react", status: "UNKNOWN" }),
    );
  });
});
