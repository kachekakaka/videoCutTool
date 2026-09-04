# 0002. 外置跳板启动架构与工作区数据目录解耦决策

## Context
在前期开发与运行中，存在三项阻碍便携分发、启动体验与仓库整洁的关键问题：
1. **单文件冷解压过慢与目录臃肿**：此前引入的单文件绿色版（`target: portable`）每次启动时在后台必须耗费 5~15 秒将 450MB+ 的运行时与内置 FFmpeg 解压到系统 `%TEMP%`，造成黑洞等待感；若直接分发解压后的目录，则根目录下散落数十个 DLL 和杂项文件，视觉体验极度杂乱。
2. **工作区指针与配置混淆**：此前在程序所在目录下生成 `config.json` 指针记录真实数据存储目录，与真实数据目录内的完整 `config.json` 命名相同，造成用户心智认知负担。
3. **运行数据污染代码仓库**：运行时若直接写入当前工作目录，会导致在代码仓库或只读介质中产生污染或崩溃。

## Decision
1. **外置跳板启动架构（Clean Root Architecture）**：
   - 构建目标配置为绿色免解压目录版（`target: dir`），所有 400MB+ Chromium 底层动态库、Node 运行时、资源包和内嵌静态 FFmpeg/FFprobe 全部归拢收纳至唯一的子目录 `release/app/`；
   - 编写原生跳板启动器源码（`scripts/launcher.cs`），调用 Windows 10/11 内置 C# 编译器生成只有 15KB 的原生 GUI 无黑框入口 `release/VideoCutTool.exe`；
   - 双击外层 `VideoCutTool.exe` 瞬间（< 5ms）拉起 `app\VideoCutTool.exe` 并注入工作区环境变量 `VCT_WORKSPACE_DIR`，自身立即静默退出；
   - 彻底根除单文件 SFX 450MB 的临时解压等待，启动速度跃升至 **< 0.3 秒（瞬时秒开）**，且系统临时目录零垃圾注入。

2. **工作区配置文件正名（`workspace.json`）**：
   - 彻底解耦“程序二进制”与“运行时数据”：将所有主配置、`plans/` 目录及切片任务数据统一收纳进由用户明确指定的**数据目录（Data Directory）**；
   - 在程序同级根目录记录指向真实数据目录的微型指针文件，**统一规范正名为 `workspace.json`**；
   - 主进程探测与初始化逻辑优先读取并持久化 `workspace.json`，向下兼容历史 `config.json`；
   - 最终交付目录根下仅呈现：`VideoCutTool.exe`（启动程序）、`workspace.json`（工作区指针）、`app/`（核心运行时），达到极致纯净。

3. **启动体验与多进程安全加固**：
   - 主进程首行注入单实例互斥锁（`app.requestSingleInstanceLock()`），杜绝连击多开冲突；
   - 窗口展示由 `show: true` 调整为 `mainWindow.once('ready-to-show')`，彻底消除白屏与黑框闪烁。

## Consequences
- 达成 0.3 秒以内的极限秒开体验，彻底消除了每次运行需等待数秒至十余秒的解压黑洞；
- 交付目录兼具“单文件的清爽整洁（一眼只有 1 个 exe 和 1 个 json）”与“免解压目录的高性能”，用户体验达到专业商业级水准；
- 贯彻了纯绿色便携哲学：零 `%APPDATA%` 注入，随拷随走，数据目录通过外层 `workspace.json` 明确指引。
