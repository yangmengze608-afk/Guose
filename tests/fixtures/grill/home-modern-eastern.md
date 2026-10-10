# Grill: Guose 自有 demo 首页的现代东方视觉改造
Date: 2026-10-06

## Intent
保留原页面的功能和结构，但视觉上明显从“AI SaaS 模板感”切换到“现代、克制、有东方气质”的新系统。

## Constraints
- 页面结构、信息层级和操作方式保持熟悉，业务逻辑不变。
- 颜色、圆角、阴影、边框、留白和整体密度都可以有明显变化，但不要改成另一个产品。
- 区块顺序、栅格列数、主要组件位置关系和内容结构保持不变；不通过重新布局制造设计感。
- 允许调整组件内边距、卡片之间的间距、区块上下留白，页面稍微变长可以接受；过松时适度回收。
- Navbar 和 Footer 先不动；未指定部分不改。
- 共享 Button / Card 的变化不得默认扩散到其他页面；优先页面级覆盖、局部 variant 或局部 token。
- 不牺牲层级和可用性，不需要全扁平化，不把所有 Card 做成相同的灰白方框。
- 第一阶段不使用蓝紫渐变、大红、金色、书法字体、传统纹样或水墨背景。
- 灰绿色不做成很森系或很日式的感觉；整体偏克制的现代东方，可以稍微靠近黛青。
- T2 只澄清需求，不创建或修改 demo；本阶段不做 Plan、Transform 或 Before/After。

## Key decisions
- Decision: 先用 Guose 自有 demo 首页。Reason: 不想第一轮拿真实项目冒险，先跑通完整闭环。Alternative considered: 已有真实项目首页，demo 验证后再做第二阶段。
- Decision: 范围仅为首页的页面背景、Button、Card、区块上下间距、组件内部 padding。Reason: 先验证清晰的 Before / After，再决定是否扩大到整个 Design System。Alternative considered: 全站或整个 Design System，本阶段不做。
- Decision: 色彩使用偏灰、不过分发黄的暖白底色、炭灰文字、低饱和黛青 / 灰绿色作为主要强调色。Reason: 从蓝紫 AI SaaS 模板感转向现代、克制、有一点东方气质。Alternative considered: 保留蓝紫品牌色；当前蓝紫没有必须保留的品牌意义，可以一起换掉。
- Decision: 用细边框、留白和明暗层次区分 Card，不靠大阴影和渐变；主按钮用更深的强调色保持主次关系。Reason: 克制不等于整个页面灰蒙蒙。Alternative considered: 大阴影、渐变、所有卡片都浮起来。
- Decision: 风格感受为克制、安静、有留白、有层次。Reason: 希望页面有自己的气质，而不是一眼像 AI 模板拼出来。
- Decision: 改造力度为中高强度，约 70% 的视觉语言变化，但 0% 的业务逻辑变化。Reason: 不希望只是轻微润色，要一眼看出换了一套视觉语言。Alternative considered: 轻度精修、改成另一个产品、极端扁平化。
- Decision: 具体色值现在不定死，后续依据实际页面效果选择。Reason: 已确认色彩方向，但尚未创建 demo。
- Decision: 后续 demo 使用我们自己控制的 React + Tailwind/shadcn 首页；验证视觉变化、Brief 遵守、批准范围、功能、diff 和回滚。Reason: demo 通过以后再用真实项目验证。

## Surfaced assumptions
- “现代东方”不依赖毛笔字、祥云、水墨背景、大红大金等直接传统元素，主要通过颜色、留白、边框和整体节奏体现。
- 明显视觉改造与保留页面骨架并不矛盾；留白和密度调整不代表重排布局。
- “约 70%”是用户对视觉力度的主观描述，不是代码覆盖率、概率、传统风格强度或可验证的精确变化比例。
- 上述意图不是 DesignBrief CONFIRM，也不是操作 APPROVE、导出批准或当前阶段的代码修改授权。

## Open questions
- traditionalStrength 的 0–1 意图值尚未提供，不能从“约 70% 视觉变化”推导。
- intensity 的 low / medium / high 枚举映射尚未确认；原话是“中高强度”。

## Out of scope
- 创建或修改 demo、生成 Plan、Transform、Before/After、运行 demo、进入 T3。
- 全站迁移、改变 Navbar / Footer、共享样式默认扩散、重新布局、业务逻辑变化。
- 传统色数据库、Spark-X2.5、默认传统装饰、Web UI 或 Vue/Svelte 扩展。
