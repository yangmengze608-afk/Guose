# Human fresh-checkout test

这份说明给实际使用者，不由Codex代答、点击批准或标记通过。
只有维护者已确认candidate author并创建初始commit后才开始；若无commit，停止报告，
不要自己补fixture commit或跳过fresh-checkout。真正新意图的Grill需要支持该Skill的宿主；
本次最小helper只适配已有owned-demo sample，不能变成任意Brief输入工具。

## 1. Fresh checkout

在同时包含Guose-public-candidate的父目录打开新终端：

```sh
git clone --no-hardlinks Guose-public-candidate Guose-human-checkout
cd Guose-human-checkout
date -u
git status --short
git log -1 --oneline
node --version
npm --version
```

使用Node24。只读README，记下开始时间及第一次不清楚的地方。
clone目的目录如果已存在，停止报告，不覆盖旧目录。
不从原开发仓库复制node_modules、.guose-local、旧binding或approval。

## 2. Install and inspect

```sh
npm ci --ignore-scripts
npm run build
node dist/cli/index.js --help
node dist/cli/index.js scan examples/guose-demo-app --json
node dist/cli/index.js recover examples/guose-demo-app --json
npm run demo:workflow -- --inspect
```

确认inspect显示DRAFT、planningAllowed=false、executionAllowed=false。
允许采用sample现代克制东方意图，但必须把它作为**你这次的新决定**来审核，
不是过去用户批准自动恢复。不适合你的意图时拒绝，不为了测试通过迁就它。
若要不同目标/风格，先在支持Skill的宿主按README调用grill-me；
当前helper不接受任意新session，不允许用旧receipt冒充新意图。该情况记录为能力限制。

## 3. Review, approve and execute

```sh
npm run demo:workflow -- --interactive
```

实际阅读当前完整Brief。只有符合你的意图才输入显示的CONFIRM BRIEF hash。
阅读绑定的Home路径、allowed/protected、baseline commit/tree与fingerprints，
符合才CONFIRM TARGET。阅读完整plan及UNKNOWN，逐条自行判CORRECT/REASONABLE；
有WRONG、UNSAFE、UNAUTHORIZED或无法判断就取消并记录，不让Codex替你分类。
批准exact plan hash后，另一次EXECUTE ISOLATED才执行。批准plan不自动执行。
预期保守结果4 APPLIED /34 SKIPPED_UNKNOWN /1 SKIPPED_SCOPE，不代表完整视觉After。

## 4. Inspect isolated diff and checks

保持第一终端进程不退出。读diff与临时workspace；只应改Home scope/import与局部CSS。
不要自动认为safe；核对Navbar/Footer、共享组件、逻辑和页面骨架均没变。
如需运行build/test，在第二终端手动进入第一终端打印的临时workspace（这是唯一需要
使用运行时路径的步骤；不是硬编码的本机路径）：

```sh
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
```

该运行授权只对owned demo，不运行第三方代码。完整audit可能仍非零，查看风险注册表。
不要修改副本source来“帮助通过”；若有后来编辑，undo应拒绝而不是覆盖。

## 5. Undo and record

回第一终端，读完diff后按Enter让live-process执行conditional undo/cleanup。
检查显示恢复baseline及cleanup REMOVED；不要杀进程后声称undo成功。
在checkout根目录再执行：

```sh
git status --short
git diff -- examples/guose-demo-app
date -u
```

原demo应无diff。手工记录以下真实结果并回复维护者：

- Start/end time:
- Commit / Node/npm versions:
- Commands actually followed and exit codes:
- Where I hesitated:
- Errors:
- README ambiguities:
- Brief/target/plan review accepted or cancelled, why:
- Execution counts and files:
- Diff inspection:
- Undo/cleanup and original demo status:
- HUMAN_FRESH_SUCCESS: PASS / FAIL / CANCELLED (由实际完成结果判断)

命令失败时停止该步骤、记录完整错误。不要跳步、替换批准、借用旧收据或接受Codex
模拟结果。尚未人工跑完前状态一直PENDING_HUMAN，不是成功。
