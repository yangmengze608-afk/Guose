import { evidenceBundleSchema, currentDesignSystemSchema, migrationPlanSchema, verificationResultSchema, stylePackSchema } from "../schemas/index.js";
import { dryRunPatchSchema } from "../patch/index.js";
import { deepFreeze } from "../utils/deep-freeze.js";

export type ArtifactKind = "recovery" | "plan" | "patch" | "verification";
export type FreshnessCheck = { dependency: string; status: "MATCH" | "CHANGED" | "UNKNOWN" };

/** Pure identity comparison, not artifact authorization, correctness or runtime proof.
 * A baseline bundle is required because recovery/plan bind its facts by fingerprint.
 * The caller supplies a newly scanned bundle; this function executes no target code.
 */
export function assessArtifactFreshness(kind: ArtifactKind, artifact: unknown, baseline: unknown, current: unknown, currentPack?: unknown) {
  const checks: FreshnessCheck[] = [];
  const finish = () => deepFreeze({ status: checks.some(({ status }) => status === "CHANGED") ? "STALE" as const
    : checks.some(({ status }) => status === "UNKNOWN") ? "UNKNOWN" as const : "FRESH" as const, checks,
    limitations: ["Freshness compares validated content identities, not authenticity, inference correctness or runtime behavior.",
      "Timestamps do not determine freshness. Recovery has no style-pack dependency.",
      "Public root is relative; identical content across different locations is content-equivalent, not filesystem location identity or authorization."] });
  const old = evidenceBundleSchema.safeParse(baseline), now = evidenceBundleSchema.safeParse(current);
  const parsed = { recovery: currentDesignSystemSchema, plan: migrationPlanSchema, patch: dryRunPatchSchema, verification: verificationResultSchema }[kind]?.safeParse(artifact);
  if (!old.success || !now.success || !parsed?.success) {
    checks.push({ dependency: "validated-artifact-and-bundles", status: "UNKNOWN" }); return finish();
  }
  const compare = (dependency: string, left: unknown, right: unknown) => checks.push({ dependency, status: JSON.stringify(left) === JSON.stringify(right) ? "MATCH" : "CHANGED" });
  const item = parsed.data;
  const source = "baseline" in item ? item.baseline : item.source;
  compare("artifact-evidence-binding", source.evidenceFingerprint, old.data.contentFingerprint);
  compare("artifact-tree-binding", source.workingTreeFingerprint, old.data.snapshot.workingTreeFingerprint);
  compare("repository", old.data.repository.root, now.data.repository.root);
  for (const dependency of ["workingTreeFingerprint", "configHash", "guoseVersion"] as const) compare(dependency, old.data.snapshot[dependency], now.data.snapshot[dependency]);
  if (old.data.snapshot.gitStateReason === "GIT_UNAVAILABLE" || now.data.snapshot.gitStateReason === "GIT_UNAVAILABLE") checks.push({ dependency: "gitHead", status: "UNKNOWN" });
  else compare("gitHead", [old.data.snapshot.gitHead, old.data.snapshot.gitStateReason], [now.data.snapshot.gitHead, now.data.snapshot.gitStateReason]);
  compare("evidenceFingerprint", old.data.contentFingerprint, now.data.contentFingerprint);
  if ("configHash" in source) {
    compare("artifact-config-binding", source.configHash, old.data.snapshot.configHash);
  }
  if ("guoseVersion" in source) compare("artifact-version-binding", source.guoseVersion, old.data.snapshot.guoseVersion);
  if ("gitHead" in source) compare("artifact-head-binding", source.gitHead, old.data.snapshot.gitHead);
  if ("freshness" in item && item.freshness !== "FRESH") checks.push({ dependency: "verification-original-freshness", status: item.freshness === "STALE" ? "CHANGED" : "UNKNOWN" });
  if (kind !== "recovery") {
    const pack = stylePackSchema.safeParse(currentPack);
    const identity = migrationPlanSchema.shape.source.shape.stylePack.safeParse("stylePack" in source ? source.stylePack : undefined);
    if (!pack.success || !identity.success) checks.push({ dependency: "stylePack", status: "UNKNOWN" });
    else {
      compare("stylePack.id", identity.data.id, pack.data.id);
      compare("stylePack.version", identity.data.version, pack.data.version);
      compare("stylePack.contentFingerprint", identity.data.contentFingerprint, pack.data.contentFingerprint);
    }
  }
  return finish();
}
