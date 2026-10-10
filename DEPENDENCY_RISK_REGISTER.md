# Dependency risk register

日期：2026-10-10。范围：v0.1.0-rc.1 **source release**，不代表 npm/production批准。
证据：npm audit --json、npm audit --omit=dev --json、npm explain、registry version、
lockfile、实际源码输入路径及重新运行工程验证。npm audit 非零绝不记为 AUDIT_PASS。

## 结论

root production/runtime HIGH=0；root full audit=0（source-map-js兼容patch修复）。
demo production audit=0；demo full audit仍5 HIGH /2 MODERATE。
**DEPENDENCY_RISK_DECISION = ACCEPTABLE_FOR_BOUNDED_SOURCE_RELEASE**：
剩余项逐项 RISK_ACCEPTED_WITH_EVIDENCE，不是“dev因此安全”。
适用前提：仅运行自有trusted demo，固定已审查配置/源代码，不构建第三方输入，
不允许外部上传配置/selector/glob；CI不带secrets、只读permissions、15分钟timeout。
此前任一前提变化则风险决定失效，需要重新triage。Gate仍未调用。

## 1. source-map-js

- package: source-map-js；severity: HIGH；direct/transitive: transitive。
- prod/dev: root production经postcss，同时Vitest/Vite dev链复用。
- introduced_by: postcss8.5.28 → source-map-js^1.2.1。
- affected_versions: >=1.0.0 <1.2.2；installed_before1.2.1 → after1.2.2。
- fix_available: YES；fix_requires_major: NO，兼容patch lock更新。
- runtime_reachability: Guose使用postcss.parse做语法分析，未加载外部source map；
  仍按production依赖修复，不用未触达推断代替修补。
- published-package-reachability: npm包依赖会安装postcss链，虽非bundled仍相关。
- trusted-demo-only: NO（root runtime dependency）。
- recommended_action: FIXED；重新npm ci、全量测试/构建/pack。
- advisory: [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)。

## 2. braces

- package: braces3.0.3；severity: HIGH；direct/transitive: transitive；prod/dev: demo dev。
- introduced_by: Tailwind3.4.19 → chokidar3.6.0 / micromatch4.0.8 → braces。
- affected_versions: <=3.0.3（audit聚合range*）；fix_available: only offered via
  Tailwind4.3.3；fix_requires_major: YES；registry最新braces仍3.0.3。
- runtime_reachability: 构建/watch时glob expansion确实可达；深度嵌套恶意pattern可导致
  stack exhaustion。实际配置只有"./index.html"和"./src/**/*.{ts,tsx}"，无递归brace、
  网络配置、用户提供glob或第三方目录。不是说此库不可达。
- published-package-reachability: root dependency graph不含此库；pack不含demo，
  浏览器bundle不包含构建链。source checkout安装demo dev时确实携带。
- trusted-demo-only: YES（当前许可执行边界）。
- recommended_action: RISK_ACCEPTED_WITH_EVIDENCE for bounded source release，
  不blind升Tailwind major；更换/扩展构建输入即失效。
- advisory: [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)。

## 3. chokidar

- package: chokidar3.6.0；severity: HIGH（via braces，不是独立新漏洞）。
- direct/transitive: transitive；prod/dev: demo dev；introduced_by: Tailwind3.4.19。
- affected_versions:2.0.0–3.6.0；fix_available: Tailwind4.3.3；
  fix_requires_major:YES。chokidar自身major override不能保证Tailwind API兼容。
- runtime_reachability: Vite/Tailwind开发watch实际使用固定owned路径，brace攻击前提同#2；
  本地dev仅loopback监听，不从HTTP请求接受glob。
- published-package-reachability: 不在root runtime graph/pack/browserbundle；demo dev安装有。
- trusted-demo-only:YES；recommended_action:RISK_ACCEPTED_WITH_EVIDENCE，
  同#2的固定输入边界，不能用于任意第三方watch/上传目录。

## 4. micromatch

- package: micromatch4.0.8；severity: HIGH（via braces）。
- direct/transitive: transitive；prod/dev: demo dev；
  introduced_by: Tailwind及fast-glob3.3.3。
- affected_versions:>=0.2.0（本次audit聚合）；fix_available:Tailwind4.3.3；
  fix_requires_major:YES，未有本链兼容且解除braces依赖的版本证据。
- runtime_reachability: glob match/brace expansion在trusted content构建可达，
  不来自网络/任意项目。micromatch源码确实require braces，不宣称无使用。
- published-package-reachability:root runtime/pack/browserbundle不含；demo dev包含。
- trusted-demo-only:YES；recommended_action:RISK_ACCEPTED_WITH_EVIDENCE，
  与#2同前提；不得只引用dev标签。

## 5. fast-glob

- package: fast-glob3.3.3；severity: HIGH（via micromatch→braces）。
- direct/transitive:transitive；prod/dev:demo dev；introduced_by:Tailwind3.4.19。
- affected_versions:*（聚合）；fix_available:audit标true，但修复根因需移除/升级
  braces链；fix_requires_major:当前可用完整remediation是Tailwind major。
- runtime_reachability:源码generateTasks启用brace expansion时调用
  expandPatternsWithBraceExpansion；固定平浅content glob，非外部glob输入。
- published-package-reachability:root runtime/pack/browserbundle不含；demo dev包含。
- trusted-demo-only:YES；recommended_action:RISK_ACCEPTED_WITH_EVIDENCE，
  不把fixAvailable=true误读成存在已证实兼容patch。

## 6. postcss-selector-parser

- package:postcss-selector-parser6.1.4；severity:MODERATE；
  direct/transitive:transitive；prod/dev:demo dev。
- introduced_by:Tailwind3.4.19及postcss-nested6.2.0，要求^6.x。
- affected_versions:<7.1.6；fix_available:YES7.1.6；
  fix_requires_major:YES（parser6→7；npm推荐Tailwind4.3.3）。
- runtime_reachability:Tailwind prefix/generateRules及postcss-nested解析selector确实可达；
  恶意超长flat selector导致quadratic CPU。当前输入仅版本化owned CSS/TSX，
  没有上传第三方selector；CI超时提供资源停止点但不证明没有DoS。
- published-package-reachability:不在root runtime（postcss parser不是此包）/
  pack/browserbundle；demo dev包含。
- trusted-demo-only:YES；recommended_action:RISK_ACCEPTED_WITH_EVIDENCE；
  后续major升级独立做兼容验证，不绕过依赖range强制override。
- advisory:[GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf)。

## 7. postcss-nested

- package:postcss-nested6.2.0；severity:MODERATE（via selector parser）。
- direct/transitive:transitive；prod/dev:demo dev；introduced_by:Tailwind3.4.19。
- affected_versions:2.0.3–6.2.0；fix_available:audit true，经7.x链；
  fix_requires_major:YES，当前Tailwind依赖^6.2.0不能自动接受major7。
- runtime_reachability:处理trusted demo authored CSS，可达性与恶意selector前提同#6。
- published-package-reachability:root runtime/pack/browserbundle不含；demo dev安装有。
- trusted-demo-only:YES；recommended_action:RISK_ACCEPTED_WITH_EVIDENCE，
  同#6，不把dev作为唯一依据。

## 8. tailwindcss

- package:tailwindcss3.4.19；severity:HIGH（5high/2moderate为上游+传播节点计数，
  不是7个独立根因）。
- direct/transitive:direct；prod/dev:demo dev；introduced_by:owned demo package.json。
- affected_versions:本次audit0.5.0–3.4.19等聚合范围；fix_available:4.3.3；
  fix_requires_major:YES；最新3.x仍3.4.19。
- runtime_reachability:仅owned demo build/dev调用，不由Guose scan/recover/plan加载，
  execution authorization拒绝第三方路径并校验baseline bytes/tree。
- published-package-reachability:不在root依赖/pack/browser生产运行；source demo dev有。
- trusted-demo-only:YES；recommended_action:RISK_ACCEPTED_WITH_EVIDENCE，
  保持Tailwind3 baseline，不为audit数字改框架/全局tokens/功能。
  若开放第三方runtime、用户配置或自动build，此决定立即作废。

## Residual risk

恶意修改本地demo源码/构建配置的人仍可造成DoS甚至执行其自写配置；Guose不声称
npm或Vite是sandbox。陌生PR需要先审查构建配置，CI仅隔离临时runner且只读权限、
无deploy/publish/secrets任务。release prep没有把这些已知风险变成零。
安装文档保留--ignore-scripts；source release前仍必须满足private contact及真人流程。
