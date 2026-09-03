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
The editable, in-progress state of an ongoing timeline session, containing the source path, cuts, and per-segment retention decisions.
_Avoid_: Workspace state, project, draft file

**Retention Plan**:
The immutable, keyframe-aligned execution specification computed from a draft, containing exact physical slice boundaries, destinations, and concatenation rules.
_Avoid_: Export config, cut recipe, job

**Safe Range**:
The keyframe-aligned time interval computed outward from a user range, strictly adhering to the safety principle: expanding boundaries outward to previous/following keyframes so that no kept content is truncated.
_Avoid_: Keyframe range, expanded slice, snapped boundary

### Management & Configuration Concepts

**Plan Manager**:
The central repository and UI module for creating, viewing, updating, deleting (CRUD), and executing saved retention plans.
_Avoid_: Task queue, history list, plan store

**Plan Record**:
A persisted retention plan document recording the source media path, output destination, segment decisions, and last execution state.
_Avoid_: Task, job record, cut file

**Application Configuration**:
The persistent settings file (`config.json`) placed alongside the executable binary, governing default output paths, toolchain discovery, and execution preferences.
_Avoid_: Preferences, options, ini file

**Execution Status**:
The persistent lifecycle state of a plan record, explicitly distinguishing `ready` (pending cut) from `completed` (losslessly exported with generated artifact path and completion timestamp).
_Avoid_: Run state, task progress, finish flag

**Output Directory Policy**:
The automated rule determining where exported videos and plan records are written (e.g., source directory, source subfolder, or fixed dedicated directory).
_Avoid_: Export path rule, save target
