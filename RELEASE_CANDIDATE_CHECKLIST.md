# Local public candidate checklist

v0.1.0-rc.1；bounded public source candidate。npm publish 与 production 使用不在本清单批准范围。

- [x] Public history starts at candidate; private development history not copied.
- [x] Explicit source/docs/examples/CI/assets allowlist; no private gzip/output/receipts.
- [x] Root source-map-js compatible patch fixes runtime HIGH.
- [x] Residual demo build risks triaged individually; see DEPENDENCY_RISK_REGISTER.
- [x] PUBLIC_HISTORY_PRIVACY = PASS (repo-local GitHub noreply author; sanitized public history).
- [x] PRIVATE_REPORTING_CHANNEL = CONFIGURED (verified maintainer email in SECURITY/Conduct).
- [x] HUMAN_FRESH_SUCCESS = PASS (real human fresh checkout on `9fa487b`; approvals were not scripted).
- [x] TARGETED_RELEASE_GATE_REVIEW = PASS (2026-10-11; see RELEASE_GATE_REPORT.md).
- [x] ENABLE_PRIVATE_VULNERABILITY_REPORTING_AFTER_REMOTE_CREATION.

README screenshots are earlier human-guided After, not the P2 4/34/1 executor output.
No current process or serialized receipt can replace a fresh human review.
Candidate initial author identity is a separate human decision; no global config changes.
