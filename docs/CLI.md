# 命令行压缩与无损剪切

Windows x64 便携包根目录的 `VideoCutTool-cli.exe` 提供无窗口处理入口。保留旁边完整的 `app/`，无需另装 Node.js。每次调用处理一个原片、生成一个成品，并等待收尾结束。桌面入口仍为 `VideoCutTool.exe`。

## 使用

```powershell
.\VideoCutTool-cli.exe compress --input "D:\素材\原片.mp4" --output "E:\成品\压缩.mp4" --data-dir "D:\VCT-CLI数据" --encoder cpu
.\VideoCutTool-cli.exe compress --input "D:\素材\原片.mp4" --output "E:\成品\自定义.mp4" --data-dir "D:\VCT-CLI数据" --preset custom --crf 24 --max-height 1080
.\VideoCutTool-cli.exe cut --input "D:\素材\原片.mp4" --output "E:\成品\剪切.mp4" --data-dir "D:\VCT-CLI数据" --range 10000:30000 --range 60000:90000
.\VideoCutTool-cli.exe --help
.\VideoCutTool-cli.exe --version
```

`--input`、`--output`、`--data-dir` 必填且必须是绝对路径。输出参数是完整文件名，父目录必须已存在且可写；目标不能已存在，也不能是原片的别名或硬链接。不覆盖、不自动改名。容器后缀必须符合[格式解析器](../src/main/services/MediaFormatResolver.ts)选择，例如原 FLV 无损剪切沿用 `.flv`，不能要求直接输出 `.mp4`。

压缩默认 `balanced` 预设、`auto` 编码器；预设和参数范围以[共享校验](../src/main/services/ProcessingValidation.ts)及[预设实现](../src/shared/compressPresets.ts)为准。`--crf` 和 `--max-height` 只在 `--preset custom` 时允许。`--encoder` 可选 `auto/cpu/nvenc/qsv`，成功结果返回实际编码器。显式硬件编码器不可用时失败；自动选择沿用引擎的探测及回退规则。

剪切的 `--range 起点:终点` 使用非负整数毫秒，可重复，最多 5000 个。起点必须小于终点，区间须递增、不重叠且不超过有效时长。多个保留区间按原片顺序合成一个文件。当前仅提供关键帧无损剪切：实际起点可能提前、片尾可能扩出，扩展后的区间可能重叠，不承诺逐帧精确。具体规则见[导出模式](架构.md#导出模式)。剪切不接受压缩参数。

默认沿用当前导出的封面去除策略；`--keep-cover` 请求保留。流与容器不兼容时明确失败。未知选项、缺值、除 `--range` 外的重复选项均报错。帮助和版本输出普通文本，不创建业务数据和运行目录。

## 调用结果

业务命令的 stdout 仅一行 UTF-8 JSON；进度与诊断写 stderr。请同时读取两个标准流，并等待进程退出，核对退出码。不要把“进程启动成功”视为任务成功，也不要只凭目标文件存在判断任务完成。

```json
{"ok":true,"taskId":"任务ID","operation":"compress","status":"completed","outputPaths":["E:\\成品\\压缩.mp4"],"resolvedEncoder":"cpu","warnings":[]}
```

失败结果含 `ok:false`、`status`、`error.code`、`error.message` 和 `outputPaths`。任务创建前可能没有 `taskId`。`outputPaths` 只列已确认发布的完整成品；存储失败也可能包含成品，不能盲目重试。异常退出或强制收尾时，`outcomeUnknown:true` 与 `requestedOutputPath` 表示产物状态未确认，不能据此推断不存在成品。

| 退出码 | 含义 |
| --- | --- |
| 0 | 处理成功，或帮助/版本正常输出 |
| 2 | 命令或参数错误 |
| 3 | 路径、原片、工具、编码器、容器或已有目标等前置问题 |
| 4 | CLI 数据目录或目标侧任务根占用 |
| 5 | 执行、存储、进程通信或收尾失败 |
| 130 | 用户取消且正常收尾 |

常见错误包括 `INVALID_ARGUMENT`、`INPUT_INVALID`、`INPUT_OUTPUT_SAME`、`OUTPUT_EXISTS`、`CONTAINER_UNSUPPORTED`、`TOOL_UNAVAILABLE`、`ENCODER_UNAVAILABLE`、`DIRECTORY_BUSY`、`STORAGE_FAILED`、`PROCESS_EXITED`、`CLEANUP_TIMEOUT`。完整契约见[公共任务类型](../src/shared/processingTask.ts)和[命令解析](../src/main/cli/arguments.ts)。

## 取消、数据与并发

Ctrl+C 请求取消并等待收尾；重复取消不会重复执行清理。取消前已持久化成功的结果仍保持成功，已发布成品保留。取消期间存储或清理失败返回 5。收到取消后 15 秒仍未完成收尾，启动器结束本次专属进程树，返回 `CLEANUP_TIMEOUT`，不按进程名称结束其他程序。正常媒体处理没有这个总时限。

启动器独占子进程标准输入，调用方无需也不能向其 stdin 发送业务请求。内部取消管道断开时子进程停止工作。启动器被外部强杀时无法再发送 JSON，调用方须按非正常退出/缺失回执处理；Windows Job 会结束所属子进程，不能认定任务成功。

首次使用请选择独立空数据目录；已有未标记非空目录不会被直接认领。CLI 与桌面数据目录不能互用；同一 CLI 目录（包括大小写或目录别名）同时只允许一个调用。不同目录可并行，但共享成品目录的活动任务根仍互斥，不承诺资源调度。

CLI 历史记录仅用于诊断，不自动恢复或重跑历史任务。存储故障立即停止本次调用，不自动重试保存或重新执行媒体处理。桌面继续支持人工重试保存。配置、索引、维护登记、运行目录和媒体中间文件的归属见[架构](架构.md#命令行运行边界)。当前不提供覆盖、后台脱离、HTTP、独立 JSON 请求文件或公共 stdin 协议。
