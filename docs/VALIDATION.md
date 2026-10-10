# 验证证据与边界

## Human-guided trusted-demo loop

真实完成 Grill → Approved Brief → Bound Target → Approved Plan → scoped real code
transformation → runtime verification → Before/After → human visual approval →
rollback。CORE LOOP VALIDATED **仅 owned demo + native-host 人工闭环**。
公开截图是该次批准产物，不是 P2 自动输出。

## P1 compiler

39 operation；人工 34 CORRECT / 5 REASONABLE；WRONG / UNAUTHORIZED / UNSAFE 均 0。
接受的 5 组缺口：内部状态表面、grid/header 间距、hero accent、hover、mobile
overrides。不因此自动批准或扩大 scope。

## P2 executor

4 APPLIED / 34 SKIPPED_UNKNOWN / 1 SKIPPED_SCOPE。四项为 hero background 及三个
区块 spacing；shared cn/cva、配色组合和 root cascade 未理解则跳过。
两次输出 hash/diff 一致，original demo modification 0，undo 恢复 baseline。
不能等同于视觉 After、完整 plan execution 或生产安全。

## 独立核验

README 开发命令运行确定性测试；transformation/execution tests 验证编译、隔离、
skip、tamper、undo、cleanup。测试绑定/批准是合成事件，不是新的用户批准。
Public helper 要求重新人工确认，不读取 ignored 历史执行收据。
scan/recover 的第三方只读验证不是第三方 transformation/runtime 验证。

最新 fresh-copy、隐私/许可/pack、gate 见
[blocker closure report](../RELEASE_BLOCKER_CLOSURE_REPORT.md)。
未运行 GitHub-hosted CI；本地同命令通过不能冒充远程 CI 通过。
没有真实外部 usage/adoption 证据。
