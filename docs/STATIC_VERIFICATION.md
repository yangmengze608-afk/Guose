# v0.1 static verification

正式产品边界：`StaticVerificationBackend`，不执行任何目标代码。
没有 Docker dependency、容器支持声明、stub command 或任意 executor。
只有真正出现第二个 backend 时才提取公共 runtime 抽象。

```sh
guose verify <path> --style neutral-modern --lane literals --json
guose verify <path> --style neutral-modern --lane tokens
```

两条 lane 不合并；没有 `--yes`、`--apply` 或 runtime 执行选项。
目标 package.json 的 test/typecheck/lint/build 仅静态发现，输出 DISCOVERED /
ABSENT / UNKNOWN，但运行状态永远 UNVERIFIED，executionCount（目标命令）=0。
script 内容不会作为命令执行或回显；建议命令仅用于显示，不证明工具已安装。

## 验证流程与事实边界

1. 完整校验并冻结 EvidenceBundle / StylePack clone，核对当前 HEAD、working-tree、
   project config、Guose 与 pack 身份。非 Git 目录的 null HEAD 不冒充历史验证；
   安全读取不到 Git metadata 则显式 UNVERIFIED。
2. 从唯一事实 bundle 重算 MigrationPlan 与 canonical patch。即使外来 artifact
   自洽重算 hash，也不能增加文件/hunk、位置、格式化、角色、target 或 provenance。
3. 精确复制 snapshot analysis files 到随机、0700 临时工作区。不是完整 executable
   clone：不复制 Git、node_modules、非分析 assets；已识别 secrets 排除并记录。
   拒绝 symlink / 非普通文件、单文件 >8 MiB、总量 >128 MiB、文件数 >10000。
4. 每个原文件绑定 digest；按 UTF-16 exact source offsets 应用计划 value slices。
   一一核对 operations、允许文件与位置、before/after hash、canonical unified hunks、
   无 collateral formatting、完整 mapping provenance；逐项反向恢复到原始内容。
5. 只在副本写 proposed content；源 CSS、JS/TS、JSON/JSONC configs 由 Guose-owned
   parser 静态解析。不会加载 target modules/config/plugins、执行 tsc 或 npm。
6. 核对 var() target 在副本声明中存在。仅支持 canonical CSS edits，不产生动态
   Tailwind 改动。存在声明不是完整 cascade / alias / runtime semantics 证明。
7. 对可确定的声明色对重新计算 contrast；最后核对原仓 identity 未变，使用临时
   root inode/dev、父目录、随机 marker ownership guard 清理。guard 失败宁可保留。

Git metadata 命令是固定 argv、无 shell 的 Guose-owned read，禁 fsmonitor /
hooks、submodule recursion、继承 Git 配置与可执行 clean/process/smudge filters。
无法安全界定 filter metadata 时不检查 status，降为 GIT_UNAVAILABLE。

## Contrast 的有限含义

只检查唯一、无条件 `:root` 中的 opaque #RGB / #RRGGBB role 对：
foreground/background、primary-foreground/primary、secondary-foreground/secondary、
destructive-foreground/destructive。多主题、alias、透明度、非 hex、外部 CSS
dependency、缺少一侧等均 UNVERIFIED。

普通文本参考阈值 4.5:1、ratio 不四舍五入判定，使用 sRGB relative luminance。
来源：[W3C WCAG 2.2 contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)。
这是声明色对检查；没有解析真实字号、组合、渲染或例外适用性，不声称 WCAG
compliance，也不制造 Accessibility Score。低于参考值会失败，不能当作已证明
真实页面违反标准；已存在失败与 regression 可从 before/after ratio 区分。

## 结果与证据

| Result | 准确含义 |
| --- | --- |
| STATICALLY_VERIFIED | 全部选中操作与支持的静态检查通过；runtime 仍 UNVERIFIED |
| PARTIALLY_VERIFIED | 静态 operation integrity 通过，但 contrast / coverage 等仍未知 |
| UNVERIFIED | baseline stale/unknown，或没有 migration operations 可验证 |
| FAILED | 静态 integrity、copy、syntax、target、contrast 等检查失败 |
| RUNTIME_VERIFIED | 仅保留枚举；v0.1 schema 和实现禁止返回 |

结果包含 baseline HEAD / tree / config / evidence、plan hash、patch hash、
Guose / pack version+hash、verified / failed operation IDs、静态 checks、
unverified checks（含全部 runtime）、timestamp、cleanup 状态与内容 fingerprint。
Operation ledger 是 exact patch integrity 的记录；contrast 等检查独立列出，
最终结果由显式 deterministic policy 推导。hash 不是授权签名。

UNKNOWN、omitted operations 和被排除内容不会被静默升级为完成。
只读前后 fingerprint 不建立 filesystem lock，也不证明恶意并发 filesystem
TOCTOU confinement。没有目标进程运行，更没有将副本称为运行安全 sandbox。

## Runtime roadmap

Runtime execution isolation is intentionally deferred. 只有 threat model 完成、
真实 backend/canary 验证、resource/network/filesystem policies 明确、独立
Red Team + Security gate 通过后才考虑加入。不会为了 v0.1 READY 裸跑命令。
