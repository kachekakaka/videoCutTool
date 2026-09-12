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

### Management & Execution Concepts

**Media Cutting Engine**:
The dedicated background processing subsystem responsible for asynchronously executing retention plans, orchestrating FFmpeg lossless stream copies, collision-free output naming, temporary slice lifecycle, and plan execution state updates.
_Avoid_: Export queue, worker thread, task runner, ffmpeg wrapper

**Plan Manager**:
The central repository and UI module for creating, viewing, updating, deleting (CRUD), and executing saved retention plans.
_Avoid_: Task queue, history list, plan store

**Plan Record**:
A persisted retention plan document recording the source media path, output destination, segment decisions, and last execution state.
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

**Output Directory Policy**:
The automated rule determining where exported videos and plan records are written (e.g., source directory, source subfolder, or fixed dedicated directory).
_Avoid_: Export path rule, save target

**Output Naming Policy**:
The deterministic rule governing generated output filenames, assembling a leading task start timestamp (`YYYYMMDD_HHmm`), optional bracketed plan title (`[Title]`), original media basename, and per-segment index.
_Avoid_: Export filename rule, cut name format, naming template

**Collision Avoidance**:
The automated filesystem protection mechanism that appends an incremental numeric suffix (`_01`, `_02`) whenever a target output path already exists on disk, guaranteeing zero overwrite of previously exported media.
_Avoid_: Overwrite prevention, deduplication, auto-rename

**Compression Preset**:
The curated encoding profile (`high_quality`, `balanced`, `high_compression`, `scale_1080p`) governing rate control (CRF), resolution limits, and encoder selection while strictly preserving original audio via stream copy.
_Avoid_: Transcode profile, export preset, quality mode

**Visual Compression Preview**:
The rapid on-demand A/B verification interface extracting representative keyframe samples from kept media intervals, presenting interactive split-slider and side-by-side comparisons between original and encoded frames prior to final rendering.
_Avoid_: Sample viewer, quality test, transcode check

**Preview Sample Point**:
A discrete millisecond timestamp designated specifically for the Visual Compression Preview, indicating an exact video frame sampled for original vs compressed quality inspection. Strictly decoupled from Cut Points, it does not alter media segmentation or retention decisions, supports timeline double-click or timecode entry for addition, and can be removed via scene capsule interaction without leaving clutter on the primary timeline.
_Avoid_: Cut marker, test cut, compare marker, sample slice
