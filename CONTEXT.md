# Video Cut Tool (视频裁剪工具)

A lightweight, cross-platform desktop application and embeddable module for lossless video trimming, featuring a Motrix-inspired interface, decoupled planning engine, and protocol compatibility with JA_WORKSPACE.

## Language

### Core Editing Concepts

**Cut Point**:
A discrete millisecond timestamp inserted by the operator on the timeline that splits a video or segment into two adjacent segments.
_Avoid_: Marker, split point, tag, divider

**Segment**:
A contiguous interval of video playback time bounded by the media boundaries or user-inserted cut points.
_Avoid_: Clip, slice, part, chunk

**Retention Decision**:
The operator's explicit classification of a segment as either `keep` (retained in output) or `discard` (cut out).
_Avoid_: Flag, status, label, toggle

**Retention Draft**:
The editable, in-progress state of an ongoing timeline session, containing the source media path, cuts, and per-segment retention decisions. Maintains editing invariants across cut mutations (safely preserving 'keep' decisions upon segment consolidation) and persists in-memory across view navigation.
_Avoid_: Workspace state, project, draft file

**Retention Plan**:
The immutable, keyframe-aligned execution specification computed from a draft, containing exact physical slice boundaries, destinations, and concatenation rules.
_Avoid_: Export config, cut recipe, job

**Plan Title**:
The operator-assigned semantic label designating an editing draft or retention plan, persisted in the plan record and injected into the exported media artifact filename as a bracketed prefix (`[Title]`).
_Avoid_: Plan name, job label, tag name

**Safe Range**:
The keyframe-aligned time interval computed outward from a user range, strictly adhering to the safety principle: expanding boundaries outward to previous/following keyframes so that no kept content is truncated.
_Avoid_: Keyframe range, expanded slice, snapped boundary

**Cut Point Mutation & Snapping**:
The operator-driven relocation of an existing cut point via 300ms long-press drag or direct timecode editing, strictly bounded by neighboring cut points (>=200ms collision barrier) and optionally magnetizing to adjacent physical keyframes.
_Avoid_: Marker moving, split shift, point sliding

**Scrub Thumbnail Preview**:
A lightweight, decoupled floating video thumbnail card rendered directly above the active cut point during drag operations, displaying the exact target frame without interrupting or seeking the primary playback canvas.
_Avoid_: Video hover tooltip, slice popup, mini player

**In-place Timecode Editing**:
Direct keyboard text entry and validation of a cut point's timestamp via double-click on the timeline or single-click on the segment card, updating the retention draft with instant millisecond precision.
_Avoid_: Time dialog, manual timestamp entry, direct box

**Spatial Crop**:
An operator-defined rectangular canvas boundary applied to a segment or full media, retaining enclosed visual content while discarding outer areas and adjusting export resolution accordingly.
_Avoid_: Video crop, region cut, picture cut, frame slice

**Crop Aspect Ratio Lock**:
The optional geometric constraint fixing the proportional dimensions (e.g. 16:9, 9:16, 1:1, or native source aspect) of a Spatial Crop bounding box during interactive resizing.
_Avoid_: Ratio snap, fixed shape, size lock


**Region Mask**:
An operator-defined rectangular overlay obscuring targeted on-screen content (such as logos, watermarks, or sensitive data) via solid blackout, blur, or pixelation, strictly preserving original canvas dimensions.
_Avoid_: Blackout box, sticker, cover box, censor box

**Watermark Delogo**:
The targeted elimination of static on-screen logos, identifiers, or watermarks within an operator-defined rectangular boundary using surrounding-pixel edge interpolation (FFmpeg delogo) to achieve smooth, dependency-free background restoration without inflating binary footprint.
_Avoid_: Watermark erase, AI inpaint, logo remover, de-watermark

**Global Box Propagation**:
The one-way batch replication of a designated segment's spatial crop or mask parameters across all other segments within the active retention draft.
_Avoid_: Apply to all, global sync, copy crop

**Dual-Mode Workbench Decoupling**:
The interaction architecture dividing the workspace into two mutually exclusive visual modes within the workbench: Temporal Cut Mode (pure timeline segmentation with zero on-canvas handles) and Spatial Edit Mode (canvas-focused cropping and masking with paused timeline), saving into a unified retention plan.
_Avoid_: Split editor, dual window, multi-screen mode

**Global-First Spatial Scope**:
The scoping policy where spatial crops and masks apply globally across the entire media by default, while permitting optional segment-level overrides for tailored regional edits.
_Avoid_: Default all, global override, segment-first



### Management & Execution Concepts

**Media Cutting Engine**:
The dedicated background processing subsystem responsible for asynchronously executing retention plans, orchestrating FFmpeg lossless stream copies, collision-free output naming, temporary slice lifecycle, and plan execution state updates.
_Avoid_: Export queue, worker thread, task runner, ffmpeg wrapper

**Plan Manager**:
The central repository and UI module for creating, viewing, updating, deleting (CRUD), and executing saved retention plans.
_Avoid_: Task queue, history list, plan store

**Plan Record**:
针对单个源视频持久化保存的方案记录，包含输出位置、保留决策、处理参数与最近执行状态。批量压缩创建的记录限定为整片压缩，允许准确时长尚未确认，独立编辑和执行，不与同次创建的其他记录保持参数联动；保存成功表示处理意图已持久化，不代表素材已通过完整媒体检查。
_Avoid_: Task, job record, cut file

**Data Directory**:
The user-designated persistent directory hosting the runtime application configuration (`config.json`), saved plan records (`plans/`), and localized user data, completely isolated from application source code.
_Avoid_: Workspace folder, cache dir, project folder

**Application Configuration**:
The persistent settings file (`config.json`) governing default output paths, toolchain discovery, background notification preferences, and execution options, stored directly within the active Data Directory.
_Avoid_: Preferences, options, ini file

**Initial Data Setup**:
The interactive prompt presented upon application startup when no configuration file is detected in the program directory, prompting the operator to specify or initialize their Data Directory.
_Avoid_: Install wizard, first-run guide, path dialog

**Standalone Portable Executable**:
The zero-installer, instant-launch distribution employing a Clean Root architecture: a root native micro-launcher (`VideoCutTool.exe`), workspace pointer (`workspace.json`), and consolidated runtime directory (`app/`), running without system installation or temporary unpack delays.
_Avoid_: Green package, zip distribution, installer package, single-file SFX

**Execution Status**:
The persistent lifecycle state of a plan record: `ready`（未提交）、`queued`（已接受并等待执行）、`processing`（后台处理中）、`completed`（导出完成并记录产物路径）与 `failed`（执行失败或上次执行中断，可重试）。状态保存成功后才确认接受任务和广播变更；同一 ID 在排队、执行及结果保存期间只接受一次。处理中不能删除或覆盖保存；排队记录删除时同步移出队列。恢复快照和删除标记属于 Data Directory 中的长期用户恢复数据。
_Avoid_: Run state, task progress, finish flag

**Execution Progress**:
方案单次执行期间的当前处理阶段与整项任务完成比例，涵盖裁剪、合并、转码及交付收尾；它是临时运行信息，与持久化的 Execution Status、兼容播放预览进度及剩余时间估算不同。只有产物发布和完成状态保存均成功时才达到 100%，失败或重试不能被解释为任务完成。
_Avoid_: Preview progress, segment progress, elapsed-time ratio

**Output Directory Policy**:
产物固定保存在原视频所在目录下：裁剪方案（含裁剪后压缩）的产物放入 `cut_方案名/`，整片压缩产物统一放入 `压缩/`，不按方案分目录。裁剪未命名时使用原文件主名作为目录名中的方案名。已有产物不搬迁，方案记录仍存放在 Data Directory 中。
_Avoid_: Export path rule, save target

**Output Naming Policy**:
产物文件名依次由可选方案标签 `[Title]`、原文件主名、分段编号（或默认 `_cut` 标记）、处理日期时间 `YYYYMMDD_HHmm` 组成，日期位于扩展名前；同名时在日期后追加递增序号。裁剪与整片压缩共用此命名规则，已有文件不重命名。
_Avoid_: Export filename rule, cut name format, naming template

**Collision Avoidance**:
The automated filesystem protection mechanism that appends an incremental numeric suffix (`_01`, `_02`) whenever a target output path already exists on disk, guaranteeing zero overwrite of previously exported media.
_Avoid_: Overwrite prevention, deduplication, auto-rename

**Compression Preset**:
The curated encoding profile (`high_quality`, `balanced`, `high_compression`, `scale_1080p`) governing rate control (CRF), resolution limits, and encoder selection while strictly preserving original audio via stream copy.
_Avoid_: Transcode profile, export preset, quality mode

**Batch Compression（批量压缩）**:
对多个源视频整片应用同一套压缩参数，一次保存为每个源视频各自独立的 Plan Record，再由 Plan Manager 执行；创建和保存仅进行快速基础检查，准确时长可以待确认，耗时的完整媒体检查归属执行阶段，创建及单条编辑不包含播放预览、画质对比、分段裁剪或画面处理。批量只描述方案的创建方式，不代表将多个视频合并为一个产物，也不新增包含多个视频的方案记录。
_Avoid_: 批量剪辑, 合并压缩, 多文件方案

**Visual Compression Preview**:
The rapid on-demand A/B verification interface extracting representative keyframe samples from kept media intervals, presenting interactive split-slider and side-by-side comparisons between original and encoded frames prior to final rendering.
_Avoid_: Sample viewer, quality test, transcode check

**Preview Sample Point**:
A discrete millisecond timestamp designated specifically for the Visual Compression Preview, indicating an exact video frame sampled for original vs compressed quality inspection. Strictly decoupled from Cut Points, it does not alter media segmentation or retention decisions, supports timeline double-click or timecode entry for addition, and can be removed via scene capsule interaction without leaving clutter on the primary timeline.
_Avoid_: Cut marker, test cut, compare marker, sample slice

**Transcode Auto-Escalation**:
The automated pipeline policy that upgrades an export job from lossless stream copy to the compression and re-encoding engine whenever spatial cropping, masking, or visual filters are configured.
_Avoid_: Force compress, auto transcode, transcode bump

**Letterbox Normalization**:
The automatic visual alignment mechanism that embeds cropped segments with disparate resolutions onto a uniform canvas using letterbox padding and centered scaling during single-file concatenation.
_Avoid_: Canvas fit, auto pad, dimension align

