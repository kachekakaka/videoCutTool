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

**Safe Range**:
The keyframe-aligned time interval computed outward from a user range, strictly adhering to the safety principle: expanding boundaries outward to previous/following keyframes so that no kept content is truncated.
_Avoid_: Keyframe range, expanded slice, snapped boundary

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
The zero-installer, single-file binary distribution (Motrix-inspired) that bundles the application runtime and media toolchain, runnable directly from any user location.
_Avoid_: Green package, zip distribution, installer package

**Execution Status**:
The persistent lifecycle state of a plan record, explicitly distinguishing `ready` (pending cut), `processing` (actively executing in background), `completed` (losslessly exported with artifact path), and `failed` (execution error).
_Avoid_: Run state, task progress, finish flag

**Output Directory Policy**:
The automated rule determining where exported videos and plan records are written (e.g., source directory, source subfolder, or fixed dedicated directory).
_Avoid_: Export path rule, save target

