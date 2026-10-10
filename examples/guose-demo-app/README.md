# Guose trusted demo baseline

自有本地 React 首页，虚构产品 Flowboard。蓝紫 hero、rounded Card、明显阴影是用户明确要求的 Before baseline，不是故意写坏代码，也不是 Guose 已实现的 After。无虚假用户、评价、品牌背书、账号或后端。

## 运行
```sh
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
```

React 19 / Vite 7 / Tailwind 3；版本与 lockfile 固定。components.json、src/components/ui、CVA Button、cn 与 CSS semantic tokens 为 shadcn-compatible 结构；组件由本项目编写，不声称官方 shadcn registry 生成或完整 Radix 支持。MIT 继承 Guose 根 LICENSE。

## 可验证行为
任务勾选、任务添加/空值校验、CTA 聚焦工作区、导航锚点。刷新恢复示例。所有运行数据在内存，没有 fetch、外部字体、图片或持久化。

## 冻结边界
首页 main 的背景、Button/Card、间距/padding、局部颜色/radius/shadow/border 才是后续候选范围。Navbar/Footer、区块顺序、md 两列 hero / 三列 features、信息结构、交互/业务逻辑受保护。全局 token 或共享组件不自动获准修改；必须证明有效影响范围，不仅查看文件名。

这是 Guose monorepo 子项目，不创建嵌套 Git 仓库。baseline identity 使用父仓库真实 commit + subtree tree object + Guose 工作树内容 fingerprint。扫描器不向上发现 Git，因此子目录 scan.gitHead 可能为 null/NOT_GIT_REPOSITORY，必须如实保留。

D0 创建 baseline，不运行旧 migration plan，不生成 transformation、After 或 patch。Target Binding 要单独 CONFIRM TARGET；规划授权与执行/导出授权独立。
