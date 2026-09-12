# Video Cut Tool (视频裁剪工具)

轻量、极简的跨平台无损视频裁剪桌面工具。采用 **Motrix** 现代暗黑设计质感，基于关键帧保全的 FFmpeg 流拷贝（Stream Copy）引擎，实现秒级导出、画质零损耗、正片零截断与播放不花屏。

---

## 文档导航

本项目遵循“一项事实一个真源”，所有核心文档与资产职责划分如下：

| 文档 / 目录 | 唯一职责 |
| :--- | :--- |
| [`docs/prototypes/prototype.html`](./docs/prototypes/prototype.html) | **交互原型**：Motrix 风格可交互活体原型，双击即可本地浏览器预览，后续新页面原地追加 |
| [`CONTEXT.md`](./CONTEXT.md) | **领域词汇真源**：核心剪辑概念、方案管理与配置命名统一字典，禁止自造别名 |
| [`docs/方案/视频裁剪工具架构与实施方案.md`](./docs/方案/视频裁剪工具架构与实施方案.md) | **技术实施方案**：系统架构、数据契约、极简算法单测与工程实施细则 |
| [`docs/adr/`](./docs/adr/) | **重大架构决策**：记录难以逆转且有真实取舍的长期工程决定（如侧边栏路由与排版基准） |
| [`docs/方案/`](./docs/方案/) / [`archive/docs/方案/`](./archive/docs/方案/) | **方案生命周期**：活动方案在前者，实施并验收完成后记录结论并移至后者 |
| [`AGENTS.md`](./AGENTS.md) | **协作与行为约束**：面向 Agent 的授权红线、Git 规范、原型维护与反过度治理纪律 |
| `../videoCutTool_tmp/` | **外部临时空间**：仓库同级独立目录，用于隔离存放任务跟踪草稿、临时日志与测试缓存，保持代码仓库纯净 |

---

## 核心设计原则

1. **关键帧保全铁律（Floor to Keyframe）**：
   - 裁切起点自动向左吸附至前一个 I 帧（关键帧），严格遵守：
     $$\text{safeRange.startMs} \le \text{userRange.startMs} \quad \text{且} \quad \text{safeRange.endMs} \ge \text{userRange.endMs}$$
   - 无损模式使用流复制；智能降码在无损裁剪后重新编码视频，全部保留音轨继续流复制。

2. **Motrix 极简体验与 1360px 统一垂直对齐轴线**：
   - 采用 Motrix 经典左侧 68px 紧凑功能侧边栏；
   - 全局界面视图严格对齐于 `1360px` 垂直容器，消除漂移与错位。

3. **轻量实用，杜绝过度治理**：
   - 坚决不引入重型测试体系（无 UI E2E、无组件渲染测试、无 CI 门禁），UI 与交互由人工直观验收；
   - 仅对底层关键帧计算纯数学算法保留极简单测（< 50 行），杜绝算法回归风险。

---

## 开发与协作约束

所有参与本项目的开发者与 AI Agent 须严格遵守 [`AGENTS.md`](./AGENTS.md) 所定义的协作红线（包括原型演进方式、未获授权不改代码、Windows 下 Git 提交防乱码规范等）。

Windows 便携构建入口为 [`scripts/build-portable.ps1`](./scripts/build-portable.ps1)，通过 `PATH` 中的 PowerShell 7 执行；原有 BAT 入口继续转发到该脚本。使用 `-BuildOnly` 只验证候选包。构建资源可通过 `VCT_FFMPEG_PATH`、`VCT_FFPROBE_PATH` 指定完整路径，解析及验证规则见 [`scripts/electron-builder.cjs`](./scripts/electron-builder.cjs)。候选包验证通过后才切换正式目录，构建失败保留旧版本；正式使用时保留根启动器和 `app/` 的完整目录结构。
