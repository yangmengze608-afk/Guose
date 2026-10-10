import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { compileTransformationPlan, type CompileTransformationRequest } from "../transformation/compiler.js";
import { transformationPlanSchema, type TransformationPlan } from "../transformation/schema.js";
import { deepFreeze } from "../utils/deep-freeze.js";
import { executionFingerprint, readExecutionBaseline } from "./baseline.js";

const git = promisify(execFile);
const ownedDemo = fileURLToPath(new URL("../../examples/guose-demo-app", import.meta.url));
const reviewSchema = z.object({ status: z.literal("APPROVED"), planHash: z.string(), briefHash: z.string(), bindingHash: z.string(),
  operations: z.array(z.object({ number: z.number().int(), id: z.string(), type: z.string(), role: z.string(), humanClassification: z.enum(["CORRECT", "REASONABLE"]) })),
  target: z.object({ baselineCommit: z.string().regex(/^[a-f0-9]{40}$/u), baselineTree: z.string().regex(/^[a-f0-9]{40}$/u) }),
});
export type ExecutionAuthorization = Readonly<{ status: "AUTHORIZED_ONCE"; planHash: string; executionAllowed: true }>;
type State = { request: CompileTransformationRequest; plan: TransformationPlan; baseline: Map<string, string>; root: string; used: boolean; issuedAt: number };
const issued = new WeakMap<object, State>();

/** Only an explicit current trusted-host event can issue this short-lived, single-use
 * capability. Audit JSON alone, including a serialized capability, is insufficient. */
export async function authorizeDemoExecution(input: { request: CompileTransformationRequest; plan: unknown; humanReview: unknown;
  event: { decision: "EXECUTE_APPROVED_PLAN_IN_ISOLATED_DEMO"; displayedPlanHash: string; actor: string } }): Promise<ExecutionAuthorization> {
  const plan = transformationPlanSchema.parse(input.plan), review = reviewSchema.parse(input.humanReview);
  if (input.event.decision !== "EXECUTE_APPROVED_PLAN_IN_ISOLATED_DEMO" || !input.event.actor.trim() || input.event.displayedPlanHash !== plan.contentFingerprint) throw new Error("UNAPPROVED_EXECUTION");
  if (review.planHash !== plan.contentFingerprint || review.briefHash !== plan.source.briefHash || review.bindingHash !== plan.source.bindingHash || review.operations.length !== plan.operations.length) throw new Error("STALE_PLAN_REVIEW");
  review.operations.forEach((r, i) => { const op = plan.operations[i]; if (!op || r.number !== i + 1 || r.id !== op.id || r.type !== op.type || r.role !== op.target.role) throw new Error("UNAPPROVED_OPERATION"); });
  const request = input.request, binding = request.confirmedBinding as { repoIdentity: { root: string; targetPath: string; baselineCommit: string; baselineTree: string } };
  if (await realpath(path.resolve(binding.repoIdentity.root, binding.repoIdentity.targetPath)) !== await realpath(ownedDemo)) throw new Error("TRUSTED_DEMO_ONLY");
  if (binding.repoIdentity.baselineCommit !== review.target.baselineCommit || binding.repoIdentity.baselineTree !== review.target.baselineTree) throw new Error("STALE_BASELINE");
  for (const ref of [review.target.baselineCommit, "HEAD"]) {
    const { stdout } = await git("git", ["rev-parse", `${ref}:${binding.repoIdentity.targetPath}`], { cwd: binding.repoIdentity.root });
    if (stdout.trim() !== review.target.baselineTree) throw new Error("STALE_BASELINE");
  }
  await git("git", ["diff", "--quiet", review.target.baselineCommit, "--", binding.repoIdentity.targetPath], { cwd: binding.repoIdentity.root });
  const untracked = await git("git", ["ls-files", "--others", "--exclude-standard", "--", binding.repoIdentity.targetPath], { cwd: binding.repoIdentity.root });
  if (untracked.stdout.trim()) throw new Error("STALE_BASELINE_UNTRACKED");
  const root = await realpath(ownedDemo), baseline = await readExecutionBaseline(root);
  if ((await compileTransformationPlan(request)).contentFingerprint !== plan.contentFingerprint) throw new Error("STALE_PLAN");
  const capability = deepFreeze({ status: "AUTHORIZED_ONCE" as const, planHash: plan.contentFingerprint, executionAllowed: true as const });
  issued.set(capability, { request: { ...request, briefApproval: structuredClone(request.briefApproval), confirmedBinding: structuredClone(request.confirmedBinding) }, plan: deepFreeze(plan), baseline, root, used: false, issuedAt: Date.now() });
  return capability;
}
export async function consumeAuthorization(capability: ExecutionAuthorization) {
  const state = issued.get(capability);
  if (!state || state.used || Date.now() - state.issuedAt > 300_000) throw new Error("UNAPPROVED_OR_EXPIRED_EXECUTION");
  state.used = true;
  if ((await compileTransformationPlan(state.request)).contentFingerprint !== state.plan.contentFingerprint) throw new Error("STALE_PLAN");
  if (executionFingerprint(await readExecutionBaseline(state.root)) !== executionFingerprint(state.baseline)) throw new Error("STALE_EXECUTION_SOURCE");
  return state;
}
