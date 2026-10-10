# Guose v0.1 Security Model

## Trust Boundaries

Repository files/configuration are untrusted data. Guose-owned parsers, bundled
validated neutral-modern policy, and fixed Git metadata argv are the implementation
boundary. No target imports, config loaders, lifecycle scripts or tool binaries run.
This is a bounded static analyzer, not an executable sandbox.

EvidenceBundle `repository.root` is always `.`. Only a successfully scanned,
frozen object has a private WeakMap capability containing canonical root/dev/ino.
Filesystem APIs schema-validate first, then check the original object's capability
and directory identity. There is no public arbitrary bind, fingerprint lookup or
cwd fallback. JSON/parse/spread/structuredClone loses filesystem permission:
re-scan before patch/verify. Pure recover/plan/freshness may consume validated JSON.
Hashes represent content equivalence, not authenticity or directory-location identity.

## Threat Model

Malformed repositories, path traversal, encoded/absolute paths, symlinks, extreme
layouts, binary text impersonation, parser failures, credential-bearing inputs,
untrusted config/scripts, stale/forged patch metadata and unsafe cleanup.
The root-privacy architecture change received a narrow CRITICAL_RISK_GATE; ordinary
Phase L implementation does not trigger routine expert review.

## Supported Protections / Resource Limits

| Boundary | Limit / behavior |
| --- | --- |
| Traversal | 32 nested directory levels; 20,000 visited entries; 10,000 eligible files |
| File reads | 8 MiB each; sequential bounded allocation; 128 MiB aggregate per read phase |
| Source parser | 1 MiB input; 20,000 `{ } [ ] ( ) ; < >` characters; lexical bracket depth 128 |
| Git metadata | Each fixed subprocess timeout 2 seconds; failures become GIT_UNAVAILABLE |
| Copy | Analysis files only; 0700 unique root, 0600 source copies; existing J size limits |

Inventory/file/aggregate overflow rejects with explicit LIMIT_EXCEEDED; no successful
scan artifact. Noncore parser-budget overflow isolates the file with LIMIT_EXCEEDED
UNKNOWN; core package.json parser overflow rejects. These exclusions block migration
candidates and contrast conclusions; they cannot silently imply a complete scan.
Parser lexical limits are deliberately conservative, not syntax-aware quotas:
brackets in strings/comments may reject an otherwise valid large source.
Binary NUL/invalid UTF-8 and recognized-sensitive source are excluded with UNKNOWN
scope; source text is never rewritten while retaining old offsets/digests.
Ordinary malformed CSS/TSX/config files produce file-level UNKNOWN; unexpected
parser exceptions are isolated with fixed diagnostics. Malformed core package.json
degrades detection to UNSUPPORTED/UNKNOWN. No raw exception/source snippets are logged.
The budgets are not hard CPU/RSS deadlines or proof against every parser DoS.

## Symlink Policy

Do not follow source/directory symlinks, including loops and outside links. Reject
a symlink root; canonicalize permitted roots. Source paths must be relative, with
no empty/dot/dot-dot segments, percent escapes, backslashes, drive prefix or controls.
Each read rechecks path components/containment and opens O_NOFOLLOW/O_NONBLOCK,
requiring a regular file. Root replacement is rejected by dev/ino identity.
Hostile concurrent filesystem TOCTOU confinement is not established.

## Execution Policy / Config Trust

scan/recover/plan/patch --dry-run/static verify never execute target modules,
Tailwind/Next config, package manager scripts, shell, npm/npx/yarn/pnpm/bun or plugins.
TS hosts are Guose-owned in-memory syntactic analysis; CSS is parsed without plugins.
Guose schemas validate data and style pack; no .repotruth or executable config added.
The one process site is fixed Git metadata reading through execa (not shell).
Minimal environment disables inherited configuration, hooks, fsmonitor, submodule
recursion and clean/process/smudge filters; metadata failure fails closed. Branches,
remotes and commit messages are neither execution inputs nor output facts.
Metadata traversal is bounded and streaming. Parent Git discovery, gitfile/worktree
indirection, metadata symlinks/special files, alternates/commondir, configuration
includes and recognized-sensitive Git config are rejected as GIT_UNAVAILABLE.
This intentionally restricts subdirectory/worktree Git identity support; static
content scanning remains available, and missing Git certainty is not invented.
When inventory contains recognized sensitive paths, Git inspection is skipped as
GIT_UNAVAILABLE too: status/index refresh must not indirectly read excluded secrets.

## Patch Safety

v0.1 remains dry-run and REVIEW_REQUIRED. Recomputed canonical plan, source digests,
precise declaration/value ranges, nonproduction deny rules, exact/reverse diffs,
freshness and supplied-artifact equality constrain the patch. No lockfile or binary
edit lane exists. node_modules is not scanned; vendor/generated candidates are
excluded. Whole source is privacy screened, including diff context, before output.
Unbound/forged artifacts cannot select another root. Static verification changes
only its owned analysis copy; runtime status is always UNVERIFIED.

## Artifact Privacy / Secret Detection Boundaries

No absolute locator is serialized or hashed. Errors do not echo caller paths,
canonical root, temp root, environment values, script bodies or raw parser errors.
Skip .env/.env.*, credentials*, private-key extensions, id_rsa/id_ed25519,
.ssh/.aws/.npmrc/.netrc before content reads. Exclusion names are repo-relative scope.
Recognized home-path literals, private-key markers, bounded credential URLs,
common token prefixes and explicit credential assignments exclude whole source.
Digests of analyzed content remain true digests; no fake redacted provenance.
Sensitive paths are also excluded from eligible working-tree fingerprint: changing
their contents is outside Guose's identity scope. Exclusion presence remains recorded.
Artifact/CLI strings are JSON-escaped or fixed diagnostics; control-bearing filenames
are rejected. Developer external-validation summaries also use root `.`.
This is not complete secret scanning or a promise that artifacts contain no secrets:
custom credentials, relative filenames, ordinary source context, design values and
unrecognized personal information may remain. Review artifacts before sharing.

## Temp Workspace / Known Limitations / Non-Goals

Fresh random directory per verification. Success/failure use ownership marker,
inode/dev and parent guard; uncertain cleanup is retained and reported rather than
deleting an untrusted path. Setup errors are handled by the same failure path.
Abrupt termination/SIGKILL or a failed ownership guard may leave a copy; no guarantee
of cleanup after process death. No global signal-handler lifecycle was introduced.
No malware scanner, OS sandbox, network containment, executable clone, runtime
verification, accessibility certification, automatic application or source upload.
Guose product paths have no network access; development dependency metadata review
does not add a runtime networking feature.

## Production Dependency Review — 2026-10-03

Installed metadata and code paths reviewed; no new dependencies. Removed unused
fast-glob after bounded inventory replaced glob traversal (16 packages removed).

| Dependency | Installed / license | Purpose / execution risk |
| --- | --- | --- |
| commander | 14.0.3 / MIT | CLI data parsing; error echoes suppressed |
| execa | 9.6.1 / MIT | Fixed Git metadata only; process API is a sensitive boundary |
| postcss | 8.5.28 / MIT | CSS parser only; no target plugins loaded |
| postcss-value-parser | 4.2.0 / MIT | Value parsing only, not evaluation |
| typescript | 5.9.3 / Apache-2.0 | Static AST/in-memory host; no target tsc/config execution |
| zod | 4.6.5 / MIT | Strict artifact/config data validation |

Read-only npm registry time.modified snapshots: commander 2026-09-02, execa
2026-07-31, postcss 2026-09-03, value-parser 2026-06-04, TypeScript and Zod
2026-10-02. Metadata changes are not proof of maintainer responsiveness or safety.
Package developer scripts are not invoked by product analysis; own installs should
use --ignore-scripts. License metadata does not substitute for future OSS release
license/notice review. No automatic vulnerability service was integrated.
