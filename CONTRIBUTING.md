# Contributing

Start with Node 24, Git, `npm ci --ignore-scripts`, then README development checks.
The repository is local; no public issue/PR destination or adoption exists yet.

## Frozen boundaries

No new framework, whole-repo transformation, screenshot engine, model integration,
automatic approval or third-party execution in this candidate. Analysis never
runs target code; executor writes only an approved isolated owned-demo copy.
Keep changes small; preserve provenance, conflicts and UNKNOWN. Never equate
heuristic confidence with probability or permission.

## Real extension points

- Detector: `src/repo/detect.ts`; resource/path safeguards: `src/repo/safety.ts`.
  Add licensed positive and unsupported/dynamic fixtures and exact source spans.
- Recovery: `src/extraction/`, `src/recovery/`, `src/confidence/`. Test false
  positives, negative evidence and UNKNOWN, not just a happy path.
- Transformation rule: `src/transformation/strategy.ts`, compiler/targets/schema.
  Add a bounded intent mapping, exact declaration, scope/provenance/negative tests.
  Adding a compiler rule does not grant executor support; review emitter separately.
- Execution/verification: `src/execution/`, `src/verification/`; include stale,
  tamper, protected source, rejected authority and conditional-undo tests.
- Style strategies, framework adapters, Grill/model adapters: future contributor
  surfaces requiring scope agreement, **not** stable implemented plugin APIs.
  Existing Grill adapter is `src/intent/`; upstream skill remains third-party.

Report wrong plans with sanitized source, operation ID, exact provenance and the
expected UNKNOWN/conflict result. Unsafe transformations belong to SECURITY's
private route, not an exploit-bearing issue. Never attach private source or secrets.

## Submit

Run lint/typecheck/test/build/test:locale/test:grill and `git diff --check`.
Include commands and exit codes, a minimal licensed fixture and stated limits.
Do not mutate baseline demo for an unrelated contribution, execute third-party
scripts, add telemetry or claim unrun checks. Dependencies need license/security
review. Contributions are MIT; confirm rights to every fixture.

Public workflow is source-checkout-only: npm tarball currently contains the
analysis CLI/libraries, not an independently authorized transformation target.
