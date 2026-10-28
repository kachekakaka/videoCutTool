# 领域术语

本文只定义业务概念及其边界。处理规则、模块职责与数据归属见[架构](docs/架构.md)，字段、枚举和默认值见 [types.ts](src/shared/types.ts)。下列英文名称是代码与文档使用的统一术语；“避免”列出的别名不用于指代同一概念。

## Core Editing Concepts

### Cut Point
用户插入时间轴的毫秒时间点，将一个连续区间分为相邻两段。修改切点会调整相邻分段边界，并受相邻切点约束；拖动、吸附与时间输入的交互见 [Timeline](src/renderer/components/Timeline.tsx)。
避免：Marker、split point、tag、divider。

### Segment
由媒体边界或 Cut Point 围成的连续时间区间。
避免：Clip、slice、part、chunk。

### Retention Decision
用户对 Segment 作出的保留 `keep` 或舍弃 `discard` 决定。
避免：Flag、status、label、toggle。

### Retention Draft
正在编辑的内存草稿，包含原片、切点、保留决定、画面处理和输出分组；页面切换保留草稿。切点变化须维持编辑不变量，例如合并区间时安全保留已有的保留决定。它不是已落盘的 Plan Record。
避免：Workspace state、project、draft file。

### Retention Plan
从草稿计算出的不可变执行规格，描述导出精度、实际处理区间、目的文件与拼接关系。具体边界策略见 Export Precision。
避免：Export config、cut recipe、job。

### Output File Group
共同产生一个输出文件的保留片段集合。成员可不相邻，按原片时间顺序拼接；文件按首个成员排序。界面称“文件 N”，合成文件与删除切点是两种操作。分组归属随切点编辑后的区间延续，并随草稿和方案保存。

### Plan Title
用户赋予方案的语义标签，用于识别方案及产物命名，不决定输出目录。
避免：Plan name、job label、tag name。

### Safe Range
关键帧模式下为保全所选内容生成的规划区间：起点取不晚于所选起点的关键帧，规划终点保持所选终点，不向后吸附。规划范围不保证等同于实际成片边界，产物余量见[导出模式](docs/架构.md#导出模式)。
避免：Keyframe range、expanded slice、snapped boundary。

### Export Precision
裁剪方案的边界策略：`keyframe` 使用 Safe Range；`frame` 对应“精确导出”，包含起点显示帧、不包含终点显示帧。精度与输出文件分组独立；编码行为和适用限制见[导出模式](docs/架构.md#导出模式)。

### Scrub Thumbnail Preview
拖动切点时显示目标时刻的独立缩略预览，不驱动主播放器定位。
避免：Video hover tooltip、slice popup、mini player。

### Spatial Crop
以矩形选择保留画面区域，裁掉区域外画面并改变输出尺寸；比例锁定约束该矩形缩放时的宽高比。
避免：Video crop、region cut、picture cut、frame slice。

### Region Mask
用黑块、模糊或马赛克遮挡指定矩形区域，保持原画布尺寸。
避免：Blackout box、sticker、cover box、censor box。

### Watermark Delogo
利用矩形周边像素修补静态台标或水印区域；不是 AI 内容恢复。
避免：Watermark erase、AI inpaint、logo remover、de-watermark。

### Spatial Scope
画面配置的作用范围：没有单段覆盖的片段使用全局配置；单段首次编辑时，以当时的全局配置为基础建立整份独立覆盖，包含裁剪框与全部遮罩。后续全局修改不再传入该段，切点变化后的配置继承由 [RetentionDraft](src/shared/RetentionDraft.ts)维护。

## Management & Execution Concepts

### Media Cutting Engine
负责后台执行 Retention Plan 的处理模块，协调媒体处理、产物发布与执行状态。实现入口与队列边界见[模块与契约](docs/架构.md#模块与契约)。
避免：Export queue、worker thread、task runner、ffmpeg wrapper。

### Plan Manager
创建、查看、修改、删除及提交执行已保存方案的管理模块。
避免：Task queue、history list、plan store。

### Plan Record
针对单个源视频持久保存的方案记录，包含处理意图、输出位置与最近执行状态，分为裁剪与整片压缩两类。裁剪记录关联已确认的源版本和共享索引。
避免：Task、job record、cut file。

### Media Index
与具体源文件版本绑定的定位与时间轴信息，不包含视音频内容，也不替代原片。同一视频的多个方案共享索引；完整索引持久保留，解除方案引用或闲置不会自动删除。源文件变化或索引失效后不能继续据此定位，失效不等于删除。
避免：视频副本、整片播放缓存。

### Data Directory
用户选定的持久数据目录，与程序目录及运行缓存分开；具体资产归属见[数据与产物归属](docs/架构.md#数据与产物归属)。
避免：Workspace folder、cache dir、project folder。

### Application Configuration
Data Directory 中的运行配置，管理工具、执行与通知等设置；字段及默认值以代码为准。
避免：Preferences、options、ini file。

### Initial Data Setup
启动时没有有效数据目录绑定而出现的初始化流程，引导用户选择或建立 Data Directory。

### Standalone Portable Executable
无需安装的便携目录发行方式，由根启动器、工作区指针与完整运行目录共同组成；不能仅复制一个启动文件。它不承诺固定启动耗时。
避免：Green package、installer package、single-file SFX。

### Execution Status
方案持久保存的执行阶段：`ready` 未提交，`queued` 已接受并等待，`processing` 后台处理中，`completed` 导出完成并记录产物，`failed` 执行失败或上次中断、可重试。状态与恢复操作的实现边界见[模块与契约](docs/架构.md#模块与契约)。
避免：Run state、task progress、finish flag。

### Execution Progress
单次执行的当前处理阶段与整项完成比例，是临时运行信息，与 Execution Status、播放准备进度和剩余时间估算不同。只有产物发布和完成状态保存均成功时才达到 100%，失败或重试不是完成。
避免：Preview progress、segment progress、elapsed-time ratio。

### Compression Preset
智能降码使用的编码参数组合，包含质量、尺寸与编码器选择；预设和自定义参数以 [compressPresets](src/shared/compressPresets.ts) 为准。精确导出不借用此概念描述其边界策略。
避免：Transcode profile、export preset、quality mode。

### Batch Compression
对多份源视频应用同一套初始压缩参数，为每份视频分别创建独立的 Plan Record，创建后各记录独立编辑和执行。批量描述创建方式，不表示合并视频或建立多源方案；可编辑范围见[界面与范围边界](docs/架构.md#界面与范围边界)。
避免：批量剪辑、合并压缩、多文件方案。

### Visual Compression Preview
最终导出前，对代表性采样画面实际编码并与原画面作 A/B 对比，用于观察画质，不保证最终文件体积。
避免：Sample viewer、quality test、transcode check。

### Preview Sample Point
专用于画质对比的毫秒时间点，与 Cut Point 独立，增删采样点不改变视频分段和保留决定。
避免：Cut marker、test cut、compare marker、sample slice。

### Letterbox Normalization
把不同尺寸的已裁剪片段缩放并居中填充到统一画布，使同一输出文件中的画面尺寸一致。
避免：Canvas fit、auto pad、dimension align。
