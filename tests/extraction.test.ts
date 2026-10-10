import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectRepository } from "../src/repo/index.js";

const temporaryDirectories: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "guose-extraction-"));
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

describe("design evidence extraction", () => {
  it("checks declaration syntax without emitting or treating ambient types as runtime evidence", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }),
      "next-env.d.ts": '/// <reference types="next" />\nexport {};',
      "src/types.d.ts": 'declare const className: "bg-primary";',
      "src/broken.d.ts": 'declare const value: ;',
      "src/Button.tsx": 'export const Button = () => <button className="bg-primary" />;',
    });
    const result = await detectRepository(root);
    expect(result.unknowns.filter(({ kind }) => kind === "source_parse").map(({ source }) => source?.file)).toEqual(["src/broken.d.ts"]);
    expect(result.observations.some(({ source, kind }) => source.file === "src/types.d.ts" && kind === "design_value_usage")).toBe(false);
    expect(result.observations.some(({ source, kind }) => source.file === "src/Button.tsx" && kind === "design_value_usage")).toBe(true);
  });
  it("binds JavaScript lexical scopes before resolving helper calls", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }),
      "src/browser.js": 'import { clsx } from "clsx"; function run(enabled) { if (enabled) { return clsx("bg-primary"); } return String(enabled); }',
      "src/Button.jsx": 'import { clsx } from "clsx"; export function Button() { return <button className={clsx("bg-primary")} />; }',
    });
    const result = await detectRepository(root);
    expect(result.observations.some(({ source, kind }) => source.file === "src/browser.js" && kind === "design_value_usage")).toBe(true);
    expect(result.observations.some(({ source, kind }) => source.file === "src/Button.jsx" && kind === "component_declaration")).toBe(true);
  });
  it("extracts CSS tokens, values, metrics, and variable references with provenance", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/styles.css": `:root {
  --primary: #6366f1;
  --radius: 0.5rem;
}
.button {
  color: var(--primary);
  background: rgb(10 20 30);
  border-radius: 8px;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.1);
  font-family: Inter, sans-serif;
  font-size: 1rem;
  font-weight: 600;
  padding: 0.5rem 1rem;
}
`,
    });

    const result = await detectRepository(root);
    const extracted = result.observations.filter(
      ({ value }) =>
        typeof value === "object" &&
        value !== null &&
        "detector" in value &&
        value.detector === "rules-only",
    );

    expect(
      extracted.some(
        ({ kind, value, source }) =>
          kind === "design_token_declaration" &&
          isRecord(value) &&
          value.name === "--primary" &&
          value.normalizedValue === "#6366f1" &&
          value.tokenType === "css_custom_property" &&
          source.type === "SPAN" &&
          source.file === "src/styles.css" &&
          source.startLine === 2,
      ),
    ).toBe(true);
    expect(
      extracted.some(
        ({ kind, value }) =>
          kind === "design_token_usage" &&
          isRecord(value) &&
          value.name === "--primary",
      ),
    ).toBe(true);
    expect(
      extracted.some(
        ({ kind, value }) =>
          kind === "design_value_usage" &&
          isRecord(value) &&
          value.normalizedValue === "rgb(10 20 30)" &&
          value.tokenType === "color",
      ),
    ).toBe(true);
    for (const tokenType of ["radius", "shadow", "font_family", "spacing"]) {
      expect(
        extracted.some(
          ({ kind, value }) =>
            kind === "design_value_usage" &&
            isRecord(value) &&
            value.tokenType === tokenType,
        ),
      ).toBe(true);
    }
  });

  it("extracts static cn/cva Tailwind classes and marks dynamic classes UNKNOWN", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/Button.tsx": `import { cva } from "class-variance-authority";
import clsx from "clsx";
const button = cva("bg-primary text-white rounded-md shadow-sm px-4 text-sm", {
  variants: { tone: { danger: "bg-red-500 ring-red-500" } },
});
export function Button({ tone }: { tone?: string }) {
  return <button className={clsx("border-border font-semibold", tone && "bg-red-500", \`ring-\${tone}\`)} />;
}
function Helper() { return clsx("bg-green-500"); }
void Helper;
void button;
`,
    });

    const result = await detectRepository(root);
    const classes = result.observations
      .filter(({ id }) => id.startsWith("tailwind-class:src/Button.tsx:"))
      .map(({ value }) =>
        typeof value === "object" && value !== null && "rawValue" in value
          ? value.rawValue
          : null,
      );

    expect(classes).toEqual(
      expect.arrayContaining([
        "bg-primary",
        "text-white",
        "rounded-md",
        "shadow-sm",
        "px-4",
        "text-sm",
        "border-border",
        "font-semibold",
        "bg-red-500",
        "ring-red-500",
      ]),
    );
    expect(
      result.unknowns.some(
        ({ kind, status, source }) =>
          kind === "dynamic_tailwind_class" &&
          status === "UNKNOWN" &&
          source?.file === "src/Button.tsx" &&
          source.type === "SPAN",
      ),
    ).toBe(true);

    const component = result.observations.find(
      ({ kind, value }) =>
        kind === "component_declaration" &&
        isRecord(value) &&
        value.normalizedValue === "Button",
    );
    const componentClass = result.observations.find(
      ({ id, contextEvidenceIds }) =>
        id.startsWith("tailwind-class:src/Button.tsx:7:") &&
        component !== undefined &&
        contextEvidenceIds?.includes(component.id) === true,
    );
    expect(component).toBeDefined();
    expect(
      result.observations.some(
        ({ kind, value }) =>
          kind === "component_declaration" &&
          isRecord(value) &&
          value.normalizedValue === "Helper",
      ),
    ).toBe(false);
    expect(componentClass).toBeDefined();
    expect(
      result.provenance.edges.some(
        ({ from, to, relationship }) =>
          from === component?.id &&
          to === componentClass?.id &&
          relationship === "CONTEXTUALIZES",
      ),
    ).toBe(true);
  });

  it("parses Tailwind config literals without executing the configuration", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "tailwind.config.ts": `throw new Error("must not execute");
export default { theme: { extend: { colors: { brand: "#123456" } } } };
`,
    });

    const result = await detectRepository(root);

    expect(
      result.observations.some(
        ({ kind, value, source }) =>
          kind === "design_token_declaration" &&
          isRecord(value) &&
          value.normalizedValue === "#123456" &&
          value.tokenType === "color" &&
          source.type === "SPAN" &&
          source.file === "tailwind.config.ts" &&
          source.startLine === 2,
      ),
    ).toBe(true);
  });

  it("reports malformed CSS as UNKNOWN instead of fabricating observations", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/broken.css": ".broken { color: #fff;\n",
    });

    const result = await detectRepository(root);

    expect(result.unknowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "css_parse",
          reasonCode: "PARSE_FAILED",
          source: { type: "FILE", file: "src/broken.css" },
        }),
      ]),
    );
    expect(
      result.observations.some(
        ({ id }) => id.startsWith("css-color:src/broken.css:"),
      ),
    ).toBe(false);
  });

  it("reports malformed TSX as UNKNOWN instead of trusting a recovered fragment", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/Broken.tsx":
        'export const Broken = () => <div className="bg-red-500";\n',
    });

    const result = await detectRepository(root);

    expect(
      result.unknowns.some(
        ({ kind, reasonCode, source }) =>
          kind === "source_parse" &&
          reasonCode === "PARSE_FAILED" &&
          source?.file === "src/Broken.tsx",
      ),
    ).toBe(true);
    expect(
      result.observations.some(({ id }) =>
        id.startsWith("tailwind-class:src/Broken.tsx:"),
      ),
    ).toBe(false);
  });

  it("does not classify layout, width, image, or ambiguous utilities as colors", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/App.tsx": `export const App = () => (
  <main className="text-center border-2 ring-2 bg-cover bg-[url('/hero.png')] bg-brand bg-red-500" />
);
`,
    });

    const result = await detectRepository(root);
    const colorClasses = result.observations
      .filter(
        ({ kind, value }) =>
          kind === "design_value_usage" &&
          isRecord(value) &&
          value.tokenType === "color_candidate",
      )
      .map(({ value }) => (isRecord(value) ? value.rawValue : null));

    expect(colorClasses).toEqual(["bg-red-500"]);
    expect(
      result.observations.some(
        ({ kind, value }) =>
          kind === "class_literal" &&
          isRecord(value) &&
          value.rawValue === "bg-brand",
      ),
    ).toBe(true);
    expect(
      result.unknowns.some(({ kind }) => kind === "tailwind_class_semantics"),
    ).toBe(true);
  });

  it("requires Tailwind repository evidence before classifying Tailwind utilities", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { react: "19.0.0" } }),
      "src/App.tsx": 'export const App = () => <main className="bg-red-500" />;\n',
    });

    const result = await detectRepository(root);

    expect(
      result.observations.some(({ id }) => id.startsWith("tailwind-class:")),
    ).toBe(false);
    expect(result.unknowns.some(({ id }) => id === "unknown:tailwind")).toBe(true);
  });

  it("requires verified helper bindings and extracts clsx object keys", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { clsx: "2.1.1", react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/classes.ts": `import clsx from "clsx";
declare const active: boolean;
function cn(value: string) { return value.toUpperCase(); }
export const trusted = clsx({ "bg-green-500": active });
export const unrelated = cn("bg-red-500");
`,
    });

    const result = await detectRepository(root);
    const values = result.observations
      .filter(({ id }) => id.startsWith("tailwind-class:src/classes.ts:"))
      .map(({ value }) => (isRecord(value) ? value.rawValue : null));

    expect(values).toContain("bg-green-500");
    expect(values).not.toContain("bg-red-500");
  });

  it("limits Tailwind config colors to exported theme color subtrees", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "tailwind.config.ts": `const diagnostic = "#123456";
const palette = { dynamic: "#abcdef" };
export default {
  content: ["#fedcba"],
  theme: { extend: { colors: { brand: "#654321", imported: palette } } },
};
void diagnostic;
`,
    });

    const result = await detectRepository(root);
    const configured = result.observations
      .filter(({ id }) => id.startsWith("tailwind-config-color:"))
      .map(({ value }) => (isRecord(value) ? value.normalizedValue : null));

    expect(configured).toEqual(["#654321"]);
    expect(
      result.unknowns.some(({ kind }) => kind === "tailwind_config_color"),
    ).toBe(true);
  });

  it("excludes URL fragments and non-color keywords from CSS color evidence", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/app.css": `.icon {
  background: url(#fff);
  animation: black 1s;
  color: white;
  border-color: #123456;
  outline-color: #12345;
}
`,
    });

    const result = await detectRepository(root);
    const colors = result.observations
      .filter(({ id }) => id.startsWith("css-color:"))
      .map(({ value }) => (isRecord(value) ? value.normalizedValue : null));

    expect(colors).toEqual(["white", "#123456"]);
  });

  it("recognizes memo and forwardRef component wrappers without executing them", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/wrapped.tsx": `import React, { memo } from "react";
export const Button = React.forwardRef<HTMLButtonElement>((props, ref) => (
  <button ref={ref} className="bg-primary" {...props} />
));
export const Card = memo(() => <section className="bg-card" />);
`,
    });

    const result = await detectRepository(root);
    const components = result.observations
      .filter(({ kind }) => kind === "component_declaration")
      .map(({ value }) => (isRecord(value) ? value.normalizedValue : null));

    expect(components).toEqual(expect.arrayContaining(["Button", "Card"]));
  });

  it("keeps unverified utils cn and shadowed imported helpers UNKNOWN", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }),
      "src/App.tsx": `import { cn } from "@/lib/utils";
import clsx from "clsx";
export const App = () => <main className={cn("bg-red-500")} />;
export function Card(clsx: (value: string) => string) {
  return <section className={clsx("bg-blue-500")} />;
}
`,
    });
    const result = await detectRepository(root);
    expect(result.observations.some(({ id }) => id.startsWith("tailwind-class:"))).toBe(false);
    expect(result.unknowns.filter(({ kind }) => kind === "dynamic_tailwind_class")).toHaveLength(2);
  });

  it("rejects the second red-team false-color and config counterexamples", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }),
      "src/app.css": ".bad { width: #fff; animation: rgb(1 2 3) 1s; }",
      "src/App.tsx": 'export const App = () => <main className="shadow-red-500 shadow-[#fff] shadow-[0_1px_2px_#000] shadow-md" />;',
      "tailwind.config.ts": 'export default { metadata: { theme: { colors: { fake: "#123456" } } }, theme: { colors: { bad: "16px", good: "#abcdef" } } };',
    });
    const result = await detectRepository(root);
    const values = result.observations.filter(({ kind }) =>
      kind === "design_value_usage" || kind === "design_token_declaration",
    ).map(({ value }) => isRecord(value) ? value.normalizedValue : null);
    expect(values).toEqual(["shadow-md", "#abcdef"]);
    expect(result.unknowns.filter(({ kind }) => kind === "tailwind_class_semantics")).toHaveLength(3);
    expect(result.unknowns.some(({ kind }) => kind === "tailwind_config_color")).toBe(true);
  });

  it("preserves CVA structure, lexical wrapper identities and runtime-only imports", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }),
      "src/App.tsx": `import { cva } from "class-variance-authority";
import { memo as m } from "react";
import type { clsx } from "clsx";
const variants = cva("p-4", { variants: { tone: { normal: "bg-white" } }, defaultVariants: { tone: "bg-blue-500" }, compoundVariants: [{ tone: "bg-red-500", class: "text-white" }] });
export const Card = m(() => <div className={variants()} />);
export function Outer() {
  const m = () => 42;
  const Fake = m(() => <div className="bg-red-500" />);
  return <main className={clsx("bg-green-500")} />;
}`,
    });
    const result = await detectRepository(root);
    const card = result.observations.find(({ kind, value }) => kind === "component_declaration" && isRecord(value) && value.normalizedValue === "Card");
    expect(card?.value).toMatchObject({ context: { declarationKind: "memo" } });
    expect(result.observations.some(({ kind, value }) => kind === "component_declaration" && isRecord(value) && value.normalizedValue === "Fake")).toBe(false);
    const cvaClasses = result.observations.filter(({ value }) => isRecord(value) && isRecord(value.context) && value.context.expression === "class helper").map(({ value }) => isRecord(value) ? value.rawValue : null);
    expect(cvaClasses).toEqual(["p-4", "bg-white", "text-white"]);
    expect(result.unknowns.some(({ kind }) => kind === "dynamic_tailwind_class")).toBe(true);
  });

  it("reports unsupported config shapes and invalid color functions as UNKNOWN", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }),
      "tailwind.config.ts": 'const colors = { brand: "#123456" }; export default { theme: { extend: { colors }, colors: { bad: "rgb(nonsense)" } } };',
      "src/app.css": ':root { --primary: rgb(nonsense); }',
    });
    const result = await detectRepository(root);
    expect(result.observations.filter(({ value }) => isRecord(value) && value.tokenType === "color")).toEqual([]);
    expect(result.unknowns.filter(({ kind }) => kind === "tailwind_config_color")).toHaveLength(2);
    expect(result.unknowns.some(({ kind }) => kind === "css_color_syntax")).toBe(true);
  });

  it.each([
    "const a = a; export default a;",
    "const a = b; const b = a; export default a;",
    'const b = { theme: { colors: { brand: "#fff" } } }; const a = b; export default a;',
  ])(
    "bounds cyclic exported configuration aliases: %s",
    async (source) => {
      const root = await fixture({
        "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }),
        "tailwind.config.ts": source,
      });
      const result = await detectRepository(root);
      expect(result.unknowns.some(({ kind }) => kind === "tailwind_config_color")).toBe(true);
    },
  );
});
