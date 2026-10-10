import { Command, CommanderError } from "commander";

import { recoverDesignSystem } from "../recovery/index.js";
import { detectRepository } from "../repo/index.js";
import { planMigration } from "../planner/index.js";
import { loadStylePack } from "../style-packs/index.js";
import { generateDryRunPatch } from "../patch/index.js";
import { verifyMigration } from "../verification/index.js";
import { RepositorySafetyError } from "../repo/safety.js";

const DESCRIPTION =
  "Recover design-system evidence and plan conservative migrations.";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

function addPathArgument(command: Command): Command {
  return command.argument("<path>", "React repository to analyze");
}

function renderHumanScan(
  bundle: Awaited<ReturnType<typeof detectRepository>>,
): string {
  return [
    `Repository: ${bundle.repository.root}`,
    `Support: ${bundle.repository.supportStatus}`,
    `Frameworks: ${bundle.repository.frameworks.join(", ") || "none"}`,
    `Styling systems: ${bundle.repository.stylingSystems.join(", ") || "none"}`,
    `Observed: ${bundle.observations.length}`,
    `Unknown: ${bundle.unknowns.length}`,
    `Evidence fingerprint: ${bundle.contentFingerprint}`,
  ].join("\n");
}

function renderHumanRecovery(
  system: ReturnType<typeof recoverDesignSystem>,
): string {
  return [
    `Evidence fingerprint: ${system.source.evidenceFingerprint}`,
    `Colors: ${system.sections.colors.length}`,
    `Typography: ${system.sections.typography.length}`,
    `Spacing: ${system.sections.spacing.length}`,
    `Radius: ${system.sections.radius.length}`,
    `Shadow: ${system.sections.shadow.length}`,
    `Semantic tokens: ${system.sections.semanticTokens.length}`,
    `Components: ${system.sections.components.length}`,
    `Unresolved evidence: ${system.unresolvedEvidenceIds.length}`,
    "Confidence: ordinal static-support rubric (0–3), not a probability; UNKNOWN remains unscored",
  ].join("\n");
}

export function createProgram(io: CliIo = processIo): Command {
  const program = new Command()
    .name("guose")
    .description(DESCRIPTION)
    .version("0.1.0-dev.0")
    .configureOutput({
      writeOut: io.stdout,
      writeErr: () => undefined,
    });

  addPathArgument(program.command("scan").description("Collect repository evidence"))
    .option("--json", "emit machine-readable JSON")
    .action(async (repositoryPath: string, options: { json?: boolean }) => {
      const bundle = await detectRepository(repositoryPath);
      io.stdout(
        options.json
          ? `${JSON.stringify(bundle, null, 2)}\n`
          : `${renderHumanScan(bundle)}\n`,
      );
    });

  addPathArgument(
    program.command("recover").description("Recover an observed design system"),
  )
    .option("--json", "emit machine-readable JSON")
    .action(async (repositoryPath: string, options: { json?: boolean }) => {
      const bundle = await detectRepository(repositoryPath);
      const system = recoverDesignSystem(bundle);
      io.stdout(
        options.json
          ? `${JSON.stringify(system, null, 2)}\n`
          : `${renderHumanRecovery(system)}\n`,
      );
    });

  addPathArgument(program.command("plan").description("Create a migration plan"))
    .requiredOption("--style <id>", "style pack id")
    .option("--json", "emit machine-readable JSON")
    .action(async (repositoryPath: string, options: { style: string; json?: boolean }) => {
      const pack = await loadStylePack(options.style);
      const bundle = await detectRepository(repositoryPath);
      const plan = planMigration(bundle, pack);
      io.stdout(options.json ? `${JSON.stringify(plan, null, 2)}\n` : [
        `Policy: ${plan.policyVersion}`, `Style: ${plan.source.stylePack.id}`,
        `AUTO_SAFE: ${plan.summary.autoSafe}`, `REVIEW_REQUIRED: ${plan.summary.reviewRequired}`,
        `DO_NOT_TOUCH: ${plan.summary.doNotTouch}`, plan.summary.statement,
        "Review only: confidence is not migration authorization.", "",
      ].join("\n"));
    });

  addPathArgument(
    program.command("patch").description("Generate a reviewable dry-run patch"),
  )
    .option("--style <id>", "style pack id", "neutral-modern")
    .option("--dry-run", "generate a diff without changing files", true)
    .option("--lane <kind>", "separate review lane: literals or tokens", "literals")
    .option("--json", "emit machine-readable JSON")
    .action(async (repositoryPath: string, options: { style: string; lane: string; json?: boolean }) => {
      if (options.lane !== "literals" && options.lane !== "tokens") throw new CliError("INPUT_ERROR", "Patch lane must be literals or tokens.", 2);
      const pack = await loadStylePack(options.style);
      const bundle = await detectRepository(repositoryPath);
      const patch = await generateDryRunPatch(bundle, pack, options.lane);
      io.stdout(options.json ? `${JSON.stringify(patch, null, 2)}\n` : patch.diff);
      if (!options.json) io.stderr("DRY-RUN / REVIEW_REQUIRED: no files changed; runtime behavior and contrast unverified.\n");
    });

  addPathArgument(
    program.command("verify").description("Statically verify a patch in an isolated analysis copy; no target code execution"),
  )
    .option("--style <id>", "style pack id", "neutral-modern")
    .option("--lane <kind>", "separate static review lane: literals or tokens", "literals")
    .option("--json", "emit machine-readable JSON")
    .action(async (repositoryPath: string, options: { style: string; lane: string; json?: boolean }) => {
      if (options.lane !== "literals" && options.lane !== "tokens") throw new CliError("INPUT_ERROR", "Verification lane must be literals or tokens.", 2);
      const pack = await loadStylePack(options.style), bundle = await detectRepository(repositoryPath);
      const result = await verifyMigration(bundle, pack, { lane: options.lane });
      io.stdout(options.json ? `${JSON.stringify(result, null, 2)}\n` : [
        "Guose Static Verification", ...result.checks.map(({ id, status, reason }) => `${status} ${id}: ${reason}`),
        "Runtime (no target commands executed)", ...result.runtime.map(({ name, status, discovery }) => `${name}: ${status} (${discovery})`),
        `RESULT: ${result.result}`, "Static evidence only; not tests pass, build passes, or project runtime verified.", "",
      ].join("\n"));
      if (result.result === "FAILED") throw new CliError("STATIC_VERIFICATION_FAILED", "Static verification failed; see the report.", 4);
    });

  return program;
}

function writeJsonError(io: CliIo, code: string, message: string): void {
  io.stderr(`${JSON.stringify({ error: { code, message } })}\n`);
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = processIo,
): Promise<number> {
  const jsonMode = argv.includes("--json");
  const commanderIo: CliIo = jsonMode
    ? { stdout: io.stdout, stderr: () => undefined }
    : io;
  const program = createProgram(commanderIo);
  for (const command of [program, ...program.commands]) command.exitOverride();

  if (jsonMode && (argv.includes("--help") || argv.includes("-h"))) {
    const requestedCommand = argv.find((argument) =>
      program.commands.some((command) => command.name() === argument),
    );
    const target =
      program.commands.find((command) => command.name() === requestedCommand) ??
      program;
    io.stdout(
      `${JSON.stringify({
        help: {
          command: target.name(),
          description: target.description(),
          usage: target.usage(),
          options: target.options.map((option) => ({
            flags: option.flags,
            description: option.description,
          })),
        },
      })}\n`,
    );
    return 0;
  }

  try {
    await program.parseAsync([...argv]);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      if (jsonMode) writeJsonError(io, error.code, error.message);
      else io.stderr(`Error: ${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return 0;
      }
      if (jsonMode) writeJsonError(io, "USAGE_ERROR", "Invalid CLI usage.");
      else io.stderr("Invalid CLI usage.\n");
      return error.exitCode;
    }

    const message = error instanceof RepositorySafetyError ? error.message : "Repository input could not be safely analyzed.";
    if (jsonMode) writeJsonError(io, error instanceof RepositorySafetyError ? error.code : "INPUT_ERROR", message);
    else io.stderr(`Error: ${message}\n`);
    return 2;
  }
}
