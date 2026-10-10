import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProgram, runCli } from "../src/cli/program.js";
import { currentDesignSystemSchema, migrationPlanSchema } from "../src/schemas/index.js";

const temporaryDirectories: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "guose-cli-"));
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

describe("CLI foundation", () => {
  it("emits review-only patch JSON and rejects any apply flag", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }),
      "app.css": ':root { --primary: #fff; } .x { color: var(--primary); } .x { color: #fff; }',
    });
    let stdout = "", stderr = "";
    const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
    expect(await runCli(["node", "guose", "patch", root, "--dry-run", "--json"], io)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ dryRunOnly: true, reviewRequired: true, lane: "literals" });
    stdout = "";
    expect(await runCli(["node", "guose", "patch", root, "--apply", "--json"], io)).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({ error: { code: "USAGE_ERROR" } });
  });
  it("registers the complete v0.1 command surface", () => {
    const commandNames = createProgram().commands.map((command) =>
      command.name(),
    );

    expect(commandNames).toEqual([
      "scan",
      "recover",
      "plan",
      "patch",
      "verify",
    ]);
  });

  it("keeps patch dry-run enabled by default", () => {
    const patch = createProgram().commands.find(
      (command) => command.name() === "patch",
    );

    expect(patch?.getOptionValue("dryRun")).toBe(true);
  });

  it("rejects obsolete runtime-execution confirmation flags", async () => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(
      ["node", "guose", "verify", ".", "--yes", "--json"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      error: {
        code: "USAGE_ERROR",
      },
    });
  });

  it("returns a stable JSON input error without a stack trace", async () => {
    let stderr = "";
    const exitCode = await runCli(
      ["node", "guose", "scan", "/definitely/not/a/guose/repo", "--json"],
      {
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(stderr)).toMatchObject({
      error: { code: "UNSAFE_INPUT" },
    });
    expect(stderr).not.toContain("node_modules");
    expect(stderr).not.toContain("    at ");
  });

  it("returns JSON for Commander usage errors", async () => {
    let stderr = "";
    const exitCode = await runCli(["node", "guose", "scan", "--json"], {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr)).toMatchObject({
      error: { code: "USAGE_ERROR" },
    });
  });

  it("returns machine-readable help when --json is requested", async () => {
    let stdout = "";
    const exitCode = await runCli(
      ["node", "guose", "scan", "--help", "--json"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ help: { command: "scan" } });
  });

  it("runs recover from one scan and emits a machine-readable current system", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        dependencies: { react: "19.0.0", tailwindcss: "4.0.0" },
      }),
      "src/app.css": ":root { --primary: #6366f1; }\n",
    });
    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(
      ["node", "guose", "recover", root, "--json"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const parsed = currentDesignSystemSchema.parse(JSON.parse(stdout));
    expect(parsed.schemaVersion).toBe("1.0.0");
    expect(
      parsed.sections.semanticTokens.some(
        ({ key, status }) => key === "role:primary" && status === "INFERRED",
      ),
    ).toBe(true);
  });
  it("runs the review-first planner with only the bundled style pack", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ dependencies: { react: "19", tailwindcss: "4" } }),
      "src/app.css": ':root { --primary: #fff; } .x { color: var(--primary); } .x { color: #fff; }',
    });
    let stdout = "", stderr = "";
    const io = { stdout: (value: string) => { stdout += value; }, stderr: (value: string) => { stderr += value; } };
    expect(await runCli(["node", "guose", "plan", root, "--style", "neutral-modern", "--json"], io)).toBe(0);
    expect(stderr).toBe("");
    expect(migrationPlanSchema.parse(JSON.parse(stdout)).summary).toMatchObject({ autoSafe: 0, rawLiteralReviewCandidates: 1 });
    stdout = ""; stderr = "";
    expect(await runCli(["node", "guose", "plan", root, "--style", "modern-song", "--json"], io)).toBe(2);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({ error: { code: "INPUT_ERROR" } });
  });
});
