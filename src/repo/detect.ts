import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";
import { z } from "zod";

import { extractDesignEvidence } from "../extraction/index.js";
import { createProvenanceGraph } from "../provenance/index.js";
import {
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  evidenceBundleSchema,
  type ObservedEvidence,
  type ReadonlyEvidenceBundle,
  type UnknownFinding,
} from "../schemas/index.js";
import { deepFreeze } from "../utils/deep-freeze.js";
import { repositoryInventory, RepositorySafetyError, sensitivePath } from "./safety.js";
import {
  createBundleContentFingerprint,
  createEvidenceSnapshot,
  readBinaryEntries,
  readTextEntries,
} from "./snapshot.js";

const locations = new WeakMap<object, { root: string; dev: number; ino: number }>();
export async function readValidatedRepository(input: ReadonlyEvidenceBundle) {
  try {
    const bundle = deepFreeze(evidenceBundleSchema.parse(input));
    const location = locations.get(input);
    if (!location) throw new RepositorySafetyError("UNSAFE_INPUT");
    const info = await lstat(location.root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== location.dev || info.ino !== location.ino) throw new RepositorySafetyError("UNSAFE_INPUT");
    return { bundle, root: location.root };
  } catch { throw new RepositorySafetyError("UNSAFE_INPUT"); }
}

type PackageMap = Record<string, string>;

const packageManifestSchema = z
  .object({
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

type PackageManifest = z.infer<typeof packageManifestSchema>;

function lineAndColumn(source: string, offset: number): {
  line: number;
  column: number;
} {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

function sourceForRange(
  file: string,
  source: string,
  start: number,
  end: number,
): ObservedEvidence["source"] {
  const startPosition = lineAndColumn(source, start);
  const endPosition = lineAndColumn(source, end);

  return {
    type: "SPAN",
    file,
    startLine: startPosition.line,
    startColumn: startPosition.column,
    endLine: endPosition.line,
    endColumn: endPosition.column,
  };
}

function dependencyLocations(
  source: string,
  wantedDependencies: ReadonlySet<string>,
): Map<string, ObservedEvidence["source"]> {
  const sourceFile = ts.createSourceFile(
    "package.json",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSON,
  );
  const locations = new Map<string, ObservedEvidence["source"]>();

  const statement = sourceFile.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isObjectLiteralExpression(statement.expression)) return locations;
  // Match JSON.parse's last property and allDependencies' section precedence.
  // Nested overrides/resolutions are not dependency declarations.
  const sections = new Map<string, ts.ObjectLiteralExpression>();
  for (const property of statement.expression.properties) {
    if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) && ts.isObjectLiteralExpression(property.initializer)) sections.set(property.name.text, property.initializer);
  }
  for (const section of ["peerDependencies", "devDependencies", "dependencies"]) {
    for (const property of sections.get(section)?.properties ?? []) {
      if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) && ts.isStringLiteral(property.initializer) && wantedDependencies.has(property.name.text)) {
        locations.set(property.name.text, sourceForRange("package.json", source, property.name.getStart(sourceFile), property.name.getEnd()));
      }
    }
  }
  return locations;
}

function allDependencies(manifest: PackageManifest): PackageMap {
  return {
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
    ...manifest.dependencies,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasShadcnSignature(source: string): boolean {
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed)) return false;

  const schema = parsed.$schema;
  if (typeof schema === "string" && schema.includes("ui.shadcn.com/schema")) {
    return true;
  }

  const aliases = parsed.aliases;
  return (
    typeof parsed.style === "string" &&
    isRecord(aliases) &&
    typeof aliases.ui === "string"
  );
}

function observation(
  id: string,
  signal: string,
  value: unknown,
  source: ObservedEvidence["source"],
): ObservedEvidence {
  return {
    id,
    status: "OBSERVED",
    kind: "repository_signal",
    value: { signal, value },
    source,
  };
}

function firstMarker(source: string): { marker: string; offset: number } | null {
  const markers = ["@import \"tailwindcss\"", "@import 'tailwindcss'", "@tailwind"];

  for (const marker of markers) {
    const offset = source.indexOf(marker);
    if (offset >= 0) return { marker, offset };
  }

  return null;
}

async function detectRepositoryUnchecked(
  inputPath: string,
): Promise<ReadonlyEvidenceBundle> {
  let root = path.resolve(inputPath);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    throw new RepositorySafetyError("UNSAFE_INPUT");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new RepositorySafetyError("UNSAFE_INPUT");
  }
  root = await realpath(root);
  const inventory = await repositoryInventory(root);
  const workingTreeFiles = inventory.files;
  const configFiles = workingTreeFiles.filter((file) => /^(?:package\.json|components\.json|tsconfig\.json|tailwind\.config\.(?:js|cjs|mjs|ts|cts|mts)|next\.config\.(?:js|cjs|mjs|ts))$/u.test(file));
  const cssFiles = workingTreeFiles.filter((file) => file.endsWith(".css"));
  const sourceFiles = workingTreeFiles.filter((file) => /\.(?:js|jsx|ts|tsx|cjs|mjs|cts|mts)$/u.test(file));
  // Glob traversal completion order is not a repository fact. Stabilize every
  // source list before creating observations or content-addressed artifacts.
  configFiles.sort();
  cssFiles.sort();
  sourceFiles.sort();
  const relevantFiles = [
    ...new Set([...configFiles, ...cssFiles, ...sourceFiles]),
  ].sort();
  const excludedText = new Map<string, string>();
  const entries = await readTextEntries(root, relevantFiles, (file, reason) => excludedText.set(file, reason));
  const workingTreeEntries = await readBinaryEntries(
    root,
    workingTreeFiles.sort(),
  );
  const entryMap = new Map(entries);
  const observations: ObservedEvidence[] = [];
  const unknowns: UnknownFinding[] = [];
  for (const file of [...inventory.skipped, ...relevantFiles.filter((file) => !entryMap.has(file))]) unknowns.push({
    id: `unknown:unsafe-file:${file}`, status: "UNKNOWN", kind: "security_exclusion", reasonCode: "UNSUPPORTED",
    reason: `${excludedText.get(file) ?? "Symlink, special-file or sensitive-path policy"}; content was not extracted.`,
    scope: `Excluded repository-relative entry: ${file}`, relatedEvidenceIds: [],
  });
  const frameworks = new Set<string>();
  const stylingSystems = new Set<string>();

  const packageSource = entryMap.get("package.json");
  let dependencies: PackageMap = {};
  if (packageSource !== undefined) {
    try {
      const parsed: unknown = JSON.parse(packageSource);
      const manifest = packageManifestSchema.safeParse(parsed);
      if (!manifest.success) {
        unknowns.push({
          id: "unknown:package-json-format",
          status: "UNKNOWN",
          kind: "package_manifest",
          reasonCode: "INVALID_FORMAT",
          reason: "package.json dependency sections must map package names to string versions.",
          relatedEvidenceIds: [],
          source: { type: "FILE", file: "package.json" },
        });
      } else {
        dependencies = allDependencies(manifest.data);
      }
      const wanted = new Set([
        "react",
        "next",
        "tailwindcss",
        "vue",
        "@sveltejs/kit",
        "@angular/core",
      ]);
      const locations = dependencyLocations(packageSource, wanted);
      for (const name of wanted) {
        const location = locations.get(name);
        if (dependencies[name] !== undefined && location !== undefined) {
          observations.push(
            observation(
              `package-dependency:${name}`,
              "package_dependency",
              { name, version: dependencies[name] },
              location,
            ),
          );
        }
      }
    } catch {
      unknowns.push({
        id: "unknown:package-json",
        status: "UNKNOWN",
        kind: "package_manifest",
        reasonCode: "PARSE_FAILED",
        reason: "package.json could not be parsed as JSON; source text is not included in diagnostics.",
        relatedEvidenceIds: [],
        source: { type: "FILE", file: "package.json" },
      });
    }
  } else {
    unknowns.push({
      id: "unknown:package-json",
      status: "UNKNOWN",
      kind: "package_manifest",
      reasonCode: "ABSENT",
      reason: "No package.json was found at the repository root.",
      relatedEvidenceIds: [],
      scope: "repository root package.json",
    });
  }

  if (dependencies.react !== undefined) frameworks.add("react");
  if (dependencies.next !== undefined) frameworks.add("nextjs");
  if (dependencies.vue !== undefined) frameworks.add("vue");
  if (dependencies["@sveltejs/kit"] !== undefined) frameworks.add("sveltekit");
  if (dependencies["@angular/core"] !== undefined) frameworks.add("angular");
  if (dependencies.tailwindcss !== undefined) stylingSystems.add("tailwind");

  for (const file of configFiles) {
    if (!entryMap.has(file)) continue;
    if (file.startsWith("tailwind.config.")) {
      stylingSystems.add("tailwind");
      observations.push(
        observation(`config:${file}`, "config_file", "tailwind", {
          type: "FILE",
          file,
        }),
      );
    }
    if (file === "components.json") {
      const source = entryMap.get(file);
      try {
        if (source !== undefined && hasShadcnSignature(source)) {
          stylingSystems.add("shadcn");
          observations.push(
            observation("config:components.json", "config_file", "shadcn", {
              type: "FILE",
              file,
            }),
          );
        }
      } catch {
        unknowns.push({
          id: "unknown:components-json",
          status: "UNKNOWN",
          kind: "shadcn_detection",
          reasonCode: "PARSE_FAILED",
          reason: "components.json could not be parsed; source text is not included in diagnostics.",
          relatedEvidenceIds: [],
          source: { type: "FILE", file: "components.json" },
        });
      }
    }
  }

  for (const file of cssFiles) {
    const source = entryMap.get(file);
    if (source === undefined) continue;
    const marker = firstMarker(source);
    if (marker !== null) {
      stylingSystems.add("tailwind");
      observations.push(
        observation(
          `css-tailwind:${file}`,
          "css_marker",
          marker.marker,
          sourceForRange(file, source, marker.offset, marker.offset + marker.marker.length),
        ),
      );
    }
    const variableOffset = source.search(/--[a-zA-Z0-9_-]+\s*:/u);
    if (variableOffset >= 0) {
      stylingSystems.add("css-variables");
      observations.push(
        observation(
          `css-variables:${file}`,
          "css_custom_property",
          "present",
          sourceForRange(file, source, variableOffset, variableOffset + 2),
        ),
      );
    }
  }

  const extracted = extractDesignEvidence(entries, {
    tailwind: stylingSystems.has("tailwind"),
  });
  observations.push(...extracted.observations);
  unknowns.push(...extracted.unknowns);
  const analyzedPaths = new Set(entries.map(([file]) => file));
  for (const evidence of extracted.observations) {
    if (evidence.kind !== "css_dependency_reference" || typeof evidence.value !== "object" || evidence.value === null ||
        !("specifier" in evidence.value) || typeof evidence.value.specifier !== "string") continue;
    const dependency = evidence.value.specifier;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(evidence.source.file), dependency));
    if (dependency.startsWith(".") && analyzedPaths.has(resolved)) continue;
    unknowns.push({ id: `unknown:css-dependency:${evidence.id}`, status: "UNKNOWN", kind: "css_dependency",
      reasonCode: "UNSUPPORTED", reason: `CSS dependency ${dependency} was not resolved inside the selected analysis root. Imported design tokens and cascade remain unknown; dependency code is not executed or followed.`,
      relatedEvidenceIds: [evidence.id], source: evidence.source });
  }

  const unsupportedFrameworks = ["vue", "sveltekit", "angular"].filter((name) =>
    frameworks.has(name),
  );
  const hasReact = frameworks.has("react") || frameworks.has("nextjs");
  const hasTailwind = stylingSystems.has("tailwind");
  const supportStatus =
    unsupportedFrameworks.length > 0 || !hasReact
      ? "UNSUPPORTED"
      : hasTailwind
        ? "SUPPORTED"
        : "PARTIAL";

  if (unsupportedFrameworks.length > 0) {
    unknowns.push({
      id: "unknown:mixed-or-unsupported-framework",
      status: "UNKNOWN",
      kind: "framework_support",
      reasonCode: "UNSUPPORTED",
      reason: `Unsupported framework evidence found: ${unsupportedFrameworks.join(", ")}.`,
      relatedEvidenceIds: unsupportedFrameworks.map(
        (name) => `package-dependency:${name === "sveltekit" ? "@sveltejs/kit" : name === "angular" ? "@angular/core" : name}`,
      ),
    });
  } else if (hasReact && !hasTailwind) {
    unknowns.push({
      id: "unknown:tailwind",
      status: "UNKNOWN",
      kind: "styling_system_support",
      reasonCode: "INSUFFICIENT_EVIDENCE",
      reason: "React was detected, but no Tailwind dependency, config, or CSS marker was found.",
      relatedEvidenceIds: ["package-dependency:react"],
    });
  } else if (!hasReact) {
    unknowns.push({
      id: "unknown:react",
      status: "UNKNOWN",
      kind: "framework_support",
      reasonCode: "INSUFFICIENT_EVIDENCE",
      reason: "No React or Next.js React dependency was found at the repository root.",
      relatedEvidenceIds: [],
      scope: "root package.json dependencies, devDependencies, and peerDependencies",
    });
  }

  const configEntries = entries.filter(([file]) => configFiles.includes(file));
  const snapshot = await createEvidenceSnapshot(
    root,
    entries,
    configEntries,
    workingTreeEntries,
    !inventory.skipped.some(sensitivePath),
  );

  const payload = {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    snapshot,
    repository: {
      root: "." as const,
      frameworks: [...frameworks].sort(),
      stylingSystems: [...stylingSystems].sort(),
      supportStatus,
    },
    observations,
    inferences: [],
    unknowns,
    provenance: createProvenanceGraph({
      observations,
      inferences: [],
      unknowns,
    }),
  };
  const bundle = evidenceBundleSchema.parse({
    ...payload,
    contentFingerprint: createBundleContentFingerprint({
      ...payload,
      snapshot: { ...snapshot, createdAt: "" },
    }),
  });

  const frozen = deepFreeze(bundle);
  locations.set(frozen, { root, dev: rootStat.dev, ino: rootStat.ino });
  return frozen;
}

export async function detectRepository(inputPath: string): Promise<ReadonlyEvidenceBundle> {
  try { return await detectRepositoryUnchecked(inputPath); }
  catch (error) { throw error instanceof RepositorySafetyError ? error : new RepositorySafetyError("UNSAFE_INPUT"); }
}
