import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { recoverDesignSystem } from "../src/recovery/index.js";
import { detectRepository } from "../src/repo/index.js";

const temporaryDirectories: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "guose-recovery-"));
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

describe("design-system recovery", () => {
  it("recovers primitives, explicit tokens, and component usages from one EvidenceBundle", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/app.css": `:root {
  --primary: #6366f1;
  --radius: 0.5rem;
}
.button {
  color: var(--primary);
  color: var(--missing);
  border-radius: 8px;
  font-size: 1rem;
  padding: 0.5rem;
}
`,
      "src/Button.tsx": `import clsx from "clsx";
export function Button({ tone }: { tone: string }) {
  return <button className={clsx("bg-primary rounded-md px-4 text-sm", \`ring-\${tone}\`)} />;
}
`,
    });

    const evidence = await detectRepository(root);
    const recovered = recoverDesignSystem(evidence);

    expect(recovered.source).toEqual({
      evidenceFingerprint: evidence.contentFingerprint,
      workingTreeFingerprint: evidence.snapshot.workingTreeFingerprint,
    });
    expect(
      recovered.sections.colors.some(
        ({ key, status }) => key === "#6366f1" && status === "OBSERVED",
      ),
    ).toBe(true);
    expect(
      recovered.sections.radius.some(({ key }) => key === "8px"),
    ).toBe(true);
    expect(
      recovered.sections.typography.some(({ key }) => key === "1rem"),
    ).toBe(true);
    expect(
      recovered.sections.spacing.some(({ key }) => key === "0.5rem"),
    ).toBe(true);

    const primary = recovered.sections.semanticTokens.find(
      ({ key }) => key === "--primary",
    );
    expect(primary).toMatchObject({
      status: "OBSERVED",
      values: ["#6366f1"],
    });
    expect(primary?.evidence.length).toBe(2);
    expect(
      recovered.sections.semanticTokens.find(({ key }) => key === "role:primary"),
    ).toMatchObject({ status: "INFERRED", values: ["#6366f1"] });

    const missing = recovered.sections.semanticTokens.find(
      ({ key }) => key === "--missing",
    );
    expect(missing).toMatchObject({ status: "UNKNOWN", values: [] });

    const button = recovered.sections.components.find(
      ({ key }) => key === "src/Button.tsx#Button",
    );
    expect(button?.values).toEqual(
      expect.arrayContaining(["Button", "bg-primary", "rounded-md", "px-4", "text-sm"]),
    );
    expect(button?.components).toEqual(["Button"]);
    expect(button?.evidence.length).toBeGreaterThan(1);
    expect(
      Object.values(recovered.sections)
        .flat()
        .every(
          ({ confidence, status }) =>
            status === "UNKNOWN" ? confidence.status === "UNRESOLVED" : confidence.status === "ASSESSED",
        ),
    ).toBe(true);
    expect(recovered.unresolvedEvidenceIds).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unknown:dynamic-class:src/Button.tsx:"),
      ]),
    );
    expect(Object.isFrozen(recovered)).toBe(true);
    expect(Object.isFrozen(recovered.sections.colors)).toBe(true);
  });

  it("is deterministic for the same evidence content", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/app.css": ":root { --primary: #6366f1; }\n",
    });

    const first = recoverDesignSystem(await detectRepository(root));
    const second = recoverDesignSystem(await detectRepository(root));

    expect(second.contentFingerprint).toBe(first.contentFingerprint);
    expect(second).toEqual(first);
  });

  it("downgrades a named semantic role to UNKNOWN when declarations conflict", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/app.css":
        ":root { --primary: #111111; }\n.dark { --primary: #222222; }\n",
    });

    const recovered = recoverDesignSystem(await detectRepository(root));
    const role = recovered.sections.semanticTokens.find(
      ({ key }) => key === "role:primary",
    );

    expect(role).toMatchObject({
      status: "UNKNOWN",
      values: ["#111111", "#222222"],
    });
    expect(role?.rationale).toContain("does not prove one repository-wide");
  });

  it("does not infer a global color role from a local or type-incompatible variable", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/app.css": ".chart { --primary: 20px; --border: solid; }\n",
    });

    const recovered = recoverDesignSystem(await detectRepository(root));

    expect(
      recovered.sections.semanticTokens.find(({ key }) => key === "role:primary"),
    ).toMatchObject({ status: "UNKNOWN", values: ["20px"] });
    expect(
      recovered.sections.semanticTokens.find(({ key }) => key === "role:border"),
    ).toMatchObject({ status: "UNKNOWN", values: ["solid"] });
  });

  it("keeps same-named components in different files separate", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/admin/Button.tsx":
        'export const Button = () => <button className="bg-red-500" />;\n',
      "src/public/Button.tsx":
        'export const Button = () => <button className="bg-blue-500" />;\n',
    });

    const recovered = recoverDesignSystem(await detectRepository(root));
    const buttons = recovered.sections.components.filter(({ values }) =>
      values.includes("Button"),
    );

    expect(buttons.map(({ key }) => key)).toEqual([
      "src/admin/Button.tsx#Button",
      "src/public/Button.tsx#Button",
    ]);
    expect(buttons[0]?.values).toContain("bg-red-500");
    expect(buttons[0]?.values).not.toContain("bg-blue-500");
  });

  it("links a local cva definition through a forwardRef component usage", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: {
          "class-variance-authority": "0.7.1",
          react: "19.0.0",
          tailwindcss: "4.0.0",
        },
      }),
      "src/Button.tsx": `import React from "react";
import { cva } from "class-variance-authority";
import clsx from "clsx";
const buttonVariants = cva("bg-primary rounded-md", {
  variants: { tone: { danger: "bg-destructive" } },
});
export const Button = React.forwardRef<HTMLButtonElement>((props, ref) => (
  <button ref={ref} className={clsx(buttonVariants({ tone: "danger" }))} {...props} />
));
`,
    });

    const recovered = recoverDesignSystem(await detectRepository(root));
    const button = recovered.sections.components.find(
      ({ key }) => key === "src/Button.tsx#Button",
    );

    expect(button?.values).toEqual(
      expect.arrayContaining([
        "Button",
        "buttonVariants",
        "bg-primary",
        "rounded-md",
        "bg-destructive",
      ]),
    );
  });

  it("excludes test evidence from production recovery and records coverage", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/app.css": ":root { --primary: #111111; }\n",
      "tests/theme.css": ".fixture { color: #abcdef; }\n",
    });

    const recovered = recoverDesignSystem(await detectRepository(root));

    expect(recovered.sections.colors.some(({ key }) => key === "#abcdef")).toBe(
      false,
    );
    expect(
      recovered.coverage.excludedEvidence.some(
        ({ reasonCode }) => reasonCode === "NON_PRODUCTION_TEST",
      ),
    ).toBe(true);
    expect(recovered.coverage.limitations).not.toHaveLength(0);
  });

  it("refuses to recover an unsupported non-React repository", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { vue: "3.5.0" } }),
    });
    const evidence = await detectRepository(root);

    expect(() => recoverDesignSystem(evidence)).toThrow(
      "requires a supported React or Next.js React repository",
    );
  });

  it("keeps unresolved aliases UNKNOWN and excludes test components without crashing", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }),
      "src/app.css": ":root { --primary: var(--spacing); --spacing: 20px; --secondary: var(--missing); }",
      "tests/Button.test.tsx": 'export const Button = () => <button className="bg-red-500" />;',
    });
    const recovered = recoverDesignSystem(await detectRepository(root));
    expect(recovered.sections.components).toEqual([]);
    for (const key of ["role:primary", "role:secondary"]) {
      expect(recovered.sections.semanticTokens.find((item) => item.key === key)?.status).toBe("UNKNOWN");
    }
    expect(recovered.coverage.excludedEvidence.length).toBeGreaterThan(0);
  });

  it("does not attach global cva styles to a lexically shadowing local function", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }),
      "src/App.tsx": `import { cva } from "class-variance-authority";
const variants = cva("bg-red-500");
export function App() {
  const variants = () => "unrelated";
  return <main className={variants()} />;
}`,
    });
    const recovered = recoverDesignSystem(await detectRepository(root));
    expect(recovered.sections.components[0]?.values).toEqual(["App"]);
    expect(recovered.unresolvedEvidenceIds.length).toBeGreaterThan(0);
  });

  it("does not infer global semantic roles from conditional CSS or invalid color functions", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }),
      "src/app.css": '@media (min-width: 1600px) { :root { --primary: #fff; } } @supports (display: grid) { @theme { --color-secondary: #000; } } :root { --accent: rgb(nonsense); }',
    });
    const result = recoverDesignSystem(await detectRepository(root));
    for (const key of ["role:primary", "role:secondary", "role:accent"]) {
      expect(result.sections.semanticTokens.find((item) => item.key === key)?.status).toBe("UNKNOWN");
    }
  });

  it("requires valid bounded HSL channels for shadcn legacy role values", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }),
      "components.json": JSON.stringify({
        $schema: "https://ui.shadcn.com/schema.json",
        style: "default", rsc: true, tsx: true,
        tailwind: { config: "", css: "src/app.css", baseColor: "neutral", cssVariables: true },
        aliases: { components: "@/components", utils: "@/lib/utils" },
      }),
      "src/app.css": ':root { --primary: 1 2 3; --secondary: 10 20% 30% / nonsense; --accent: 10 20% 30% / 50%; }',
    });
    const evidence = await detectRepository(root);
    expect(evidence.repository.stylingSystems).toContain("shadcn");
    const recovered = recoverDesignSystem(evidence);
    expect(recovered.sections.semanticTokens.find(({ key }) => key === "role:primary")?.status).toBe("UNKNOWN");
    expect(recovered.sections.semanticTokens.find(({ key }) => key === "role:secondary")?.status).toBe("UNKNOWN");
    expect(recovered.sections.semanticTokens.find(({ key }) => key === "role:accent")?.status).toBe("INFERRED");
  });
});
