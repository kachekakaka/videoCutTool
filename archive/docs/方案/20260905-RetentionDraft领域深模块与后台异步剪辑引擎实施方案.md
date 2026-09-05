> **实施状态**：已完成归档\n> **完成日期**：2026-09-05\n> **验证结论**：全量单元测试 9 项全部通过（RetentionPlanner 2 项 + RetentionDraft 7 项），生产构建（Vite + TypeScript + esbuild）0 报错。核心领域深模块 RetentionDraft、后台异步串行执行引擎 MediaCuttingEngine、工作台秒级移交后台与跨 Tab 草稿常驻、全局浮动完成通知与设置偏好全部闭环落地。\n\n# RetentionDraft 领域深模块与后台异步剪辑引擎实施方案

- **方案编号**：20260905-RetentionDraft领域深模块与后台异步剪辑引擎实施方案
- **创建日期**：2026-09-05
- **关联 ADR**：[ADR-0003](../../docs/adr/0003-retention-draft-and-background-cut-engine.md)、[ADR-0001](../../docs/adr/0001-motrix-shell-and-plan-management.md)、[ADR-0002](../../docs/adr/0002-portable-distribution-and-user-data-setup.md)
- **真源词汇**：[CONTEXT.md](../../CONTEXT.md)

---

## 1. 问题陈述 (Problem Statement)

在目前视频裁剪工具的使用过程中，操作员面临着两项严重损害使用体验与数据确定性的痛点：

1. **切点删改引发的隐蔽保留决策漂移**：
   在现行实现中，时间轴的切点（`cuts`）与片段保留决策（`decisions`）是平铺解耦在前端 React 状态中的。当操作员在较长的视频中打了多个标记后，若中途删除其中某个不再需要的切点，系统会重新对后续片段从 0 编号。这导致用户原本仔细标记的“丢弃”或“保留”状态与重算后的片段发生错位，甚至导致用户期望保留的重要正片在最终导出时被意外裁掉。
2. **前台同步阻塞与切片执行双轨制**：
   目前在剪辑工作台点击“立即执行剪辑”时，界面会处于长时间的阻塞等待状态（大视频切片与合并需要持续占用前端进程与操作焦点）。同时，工作台即时切片与方案管理中心的批量切片各自维护了一套剪辑流程与数据落盘逻辑（前者在前端手动算路径、调 FFmpeg 并反向写库，后者在主进程处理），不仅无法连续处理下一部视频，还存在命名冲突避让规则不一致的隐患。

---

## 2. 解决方案 (Solution)

1. **核心领域深模块 `RetentionDraft`**：
   引入自包含、无外部 UI 依赖的高内聚草稿管理深模块。内部强制执行边界防护（200ms 距离不变量），建立稳定的段落身份维护机制；在删除切点导致两个相邻段落合并时，严格贯彻“安全优先、保留正片”原则（只要有一段为 keep，融合段落即为 keep）；对外暴露极简的不可变方案生成接口 `.toPlan()`。
2. **主进程统一后台异步剪辑引擎 `MediaCuttingEngine`**：
   将切片执行、路径防重避让、临时切片生命周期 GC 以及方案状态机（`ready` ➔ `processing` ➔ `completed` / `failed`）完全收拢至主进程。建立**单任务串行 FIFO 队列**，同一时间只运行单一 FFmpeg 进程，确保系统平稳；工作台点击“立即执行”时一秒移交后台并轻量提示，画面不中断，支持立即投入下一个视频的高频粗剪。
3. **全局完成通知与偏好开关**：
   后台切片完成后，通过主进程事件向渲染层广播结果，弹出全局 Toast 提示并支持一键定位产物；在“设置”页提供通知开关，满足免打扰需求。

---

## 3. 用户故事 (User Stories)

1. 作为一名**视频粗剪操作员**，我希望在删除时间轴上的多余切点时，已有分段的保留/丢弃决策绝对不发生错乱，以便于我能够放心调整切点位置，无需重新核对整片所有分段。
2. 作为一名**高效率视频剪辑师**，我希望在点击“立即执行剪辑”后，任务立即交由后台静默处理，当前工作台不被转码过程锁死，以便于我能立刻打开下一部视频继续打标，实现流水线式连贯作业。
3. 作为一名**注重系统流畅度的用户**，我希望多个后台剪辑任务按顺序依次执行，以便于不会因多路 FFmpeg 并发而卡死电脑或导致前台视频播放卡顿。
4. 作为一名**方案批量管理者**，我希望在方案中心清晰看到哪些方案正在后台处理中（`processing`），哪些已经顺利完成，以便于掌控批量剪辑进度。
5. 作为一名**桌面端用户**，我希望在后台任务完成时能收到明确通知并能一键打开目标文件夹，同时在需要专注时能在设置中关闭该通知，以便于按需掌控通知打扰程度。

---

## 4. 实现决策 (Implementation Decisions)

### 4.1 核心领域深模块：`RetentionDraft`
- **模块位置**：`src/shared/RetentionDraft.ts`
- **核心契约设计**：
  ```typescript
  export interface DraftSegment {
    readonly id: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly durationMs: number;
    decision: RetentionDecision;
  }

  export class RetentionDraft {
    constructor(mediaPath: string, totalDurationMs: number);
    
    // 不变量修改方法（返回是否变更成功）
    addCut(timeMs: number): boolean;
    removeCut(timeMs: number): boolean;
    setDecision(segmentId: string, decision: RetentionDecision): void;
    nudgeBoundary(segmentIndex: number, deltaMs: number, edge: 'start' | 'end'): boolean;
    
    // 查询与状态访问
    getCuts(): ReadonlyArray<number>;
    getSegments(): ReadonlyArray<DraftSegment>;
    
    // 生成不可变物理切片计划
    toPlan(keyframes: number[], options: { outputPath: string; concatSingleFile?: boolean; stripOriginalCover?: boolean }): MediaRetentionPlan;
    
    // 快照导出与恢复（用于方案持久化与回载）
    toRecord(title?: string): PlanRecord;
    static fromRecord(record: PlanRecord, totalDurationMs: number): RetentionDraft;
  }
  ```
- **核心业务不变量**：
  1. 切点与视频两端（0 及 totalDurationMs）及相邻切点必须保持 `>= 200ms` 间隔，否则静默拒绝或告警；
  2. 当调用 `removeCut` 时，左右两段融合：若原段落中存在任一 `decision === 'keep'`，新合并段落的 `decision` 强制判定为 `'keep'`；
  3. 切换 Tab 期间，`RetentionDraft` 实例由 `App.tsx` 或工作区 Hook 持有，不因组件 unmount 而丢失。

### 4.2 后台异步剪辑引擎：`MediaCuttingEngine`
- **模块位置**：`src/main/services/MediaCuttingEngine.ts`（重构替代并深化 `FFmpegExecutor.ts`）
- **核心队列与状态机制**：
  1. 内置 `queue: string[]`（等待执行的 planId 队列）与 `activePlanId: string | null`；
  2. 提交任务 `submitPlan(record: PlanRecord): Promise<void>`：
     - 若当前无任务在执行，立即标记为 `processing` 并启动 FFmpeg；
     - 若已有任务在执行，先将方案落盘为 `ready`，排入队列末端；
  3. 执行完毕（无论成功或失败）：
     - 成功：原子跃迁状态为 `completed`，记录物理 `outputPath` 与 `completedAt`，落盘；
     - 失败：状态更新为 `failed`，记录 `error` 信息，落盘；
     - 广播 IPC 事件通知渲染层（`plan:statusChanged` 与 `plan:completed`）；
     - 自动从队列头部弹出下一个任务并继续执行。
- **IPC Seam 收敛**：
  - 移除前端细粒度的 `cut:execute`、`plan:save` 反向拼装；
  - 新增单一粗粒度指令：`ipcRenderer.invoke('engine:submitDraft', draftRecord)`；
  - 保留方案中心的批量触发：`ipcRenderer.invoke('engine:submitBatch', planIds)`。

### 4.3 渲染层工作台与通知体系
- **`CutterPage.tsx` 瘦身**：
  - 移除内部 10 余个关于切点加减、微调正则、分段推导的零散计算，统一委派给 `RetentionDraft` 实例；
  - 点击“立即执行”：调用 `draft.toRecord()`，提交给后台引擎，底部显示 Toast：“方案已提交至后台队列正在执行”，画面保持停留在当前视频；
- **全局通知中心与设置**：
  - 在 `src/shared/types.ts` 的 `AppConfig` 中增加 `notifyOnExportComplete: boolean`（默认 `true`）；
  - `App.tsx` 顶层监听 `plan:completed` 事件：若配置为开启，弹出右上角优雅浮层，带【定位产物】按钮；
  - `SettingsPage.tsx` 增加对应的偏好切换复选框。

---

## 5. 测试决策 (Testing Decisions)

- **良好测试标准**：
  只测试外部公开行为与数学/业务不变量，不测试组件内部状态与样式；严格遵循项目测试红线（不引入重型 UI/E2E 体系，仅编写高杠杆纯逻辑单测）。
- **关键测试覆盖点**：
  - 文件：`tests/RetentionDraft.test.ts`
  - 测试用例：
    1. **切点间距与首尾防护**：校验 `< 200ms` 或首尾边界处插点被拒绝的不变量；
    2. **删除切点合并时的决策安全保全**：校验“保留 + 丢弃”融合后必然判定为“保留”，绝不错删正片；
    3. **段落快照序列化与反序列化一致性**：校验 `toRecord` 与 `fromRecord` 双向转换无精度与决策丢失；
    4. **不可变 Plan 输出**：校验生成的 `MediaRetentionPlan` 符合关键帧向左吸附数学不变量。
- **现有测试先例**：
  复用 `tests/RetentionPlanner.test.ts` 的 Vitest 极速断言模式（执行时间 < 10ms）。

---

## 6. 范围外说明 (Out of Scope)

- **非无损转码**：不引入需重编码画质的有损转码管道，全流程严格锁定 `-c copy` 无损物理流复制；
- **复杂多轨道编辑**：不引入多音轨分离、画中画或字幕轨道编辑；
- **并发切片竞争**：本次明确拒绝多路并发 FFmpeg 执行，坚持单任务串行队列，保障单机磁盘 IO 稳定性。

---

## 7. 实施计划与验收标准

| 阶段 | 改动文件 | 核心交付物 | 验收验证标准 |
| :--- | :--- | :--- | :--- |
| **Phase 1** | `src/shared/RetentionDraft.ts`<br>`tests/RetentionDraft.test.ts` | 领域深模块与单测 | `npm test` 纯函数单测全部通过（包含决策安全合并校验） |
| **Phase 2** | `src/main/services/MediaCuttingEngine.ts`<br>`src/main/services/PlanManager.ts`<br>`electron/main.ts`<br>`electron/preload.ts` | 后台异步队列与状态机 | 点击执行后主进程后台排队执行，正确跃迁 `processing` ➔ `completed` |
| **Phase 3** | `src/renderer/components/CutterPage.tsx`<br>`src/App.tsx`<br>`src/renderer/components/SettingsPage.tsx` | 工作台瘦身、Toast 与全局通知 | 工作台连贯作业不中断；切点删除无错位；完成后浮层通知且支持开关 |
| **Phase 4** | 整体构建验证 | 全量编译与打包 | TypeScript 零报错，Vite 编译通过，启动脚本正常运行 |