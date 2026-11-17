using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// 控制台传输适配：业务由 Electron 服务执行；本进程只管理归属、标准流和最终回执。
internal static class CliLauncher {
    const uint CREATE_SUSPENDED = 4, CREATE_NO_WINDOW = 0x08000000, STARTF_USESTDHANDLES = 0x100;
    const uint WAIT_TIMEOUT = 258, INFINITE = 0xffffffff;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
    static int cancelRequested;
    static string requestedOutput;
    static string operation;
    static string protocolFailure;
    static StreamWriter control;
    static readonly object ControlSync = new object();
    [StructLayout(LayoutKind.Sequential)] struct SA { public int size; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI {
        public int size; public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xCount, yCount, fill, flags;
        public short show, reservedSize; public IntPtr reservedPointer, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC {
        public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking;
        public uint active; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC basic; public IO io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SA attributes, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref SI startup, out PI process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref LIMIT data, int length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool success, string action) { if (!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), action); }
    static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    // 遵循 CommandLineToArgvW 的反斜杠/引号规则，空参数与尾部反斜杠也可往返。
    internal static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    static void Cancel() {
        if (Interlocked.Exchange(ref cancelRequested, 1) != 0) return;
        lock (ControlSync) { try { if (control != null) { control.WriteLine("VCT_CANCEL"); control.Flush(); } } catch (Exception e) { Console.Error.WriteLine(e.Message); } }
    }
    static int Failure(string code, string message, bool unknown) {
        var result = new Dictionary<string, object> { { "ok", false }, { "status", "failed" }, { "operation", operation }, { "outputPaths", new string[0] }, { "error", new { code = code, message = message } } };
        if (unknown) { result["requestedOutputPath"] = requestedOutput; result["outcomeUnknown"] = true; }
        Console.Out.WriteLine(Json.Serialize(result)); return 5;
    }
    static int ExpectedCode(Dictionary<string, object> result) {
        if (!(result["ok"] is bool) || !(result["status"] is string) || !(result["outputPaths"] is object[])) throw new Exception("回执字段无效");
        bool ok = (bool)result["ok"]; string status = (string)result["status"];
        if (ok) { if (status != "completed" || ((object[])result["outputPaths"]).Length != 1) throw new Exception("成功回执缺少完整产物"); return 0; }
        var error = result["error"] as Dictionary<string, object>;
        if (error == null || !(error["code"] is string) || !(error["message"] is string)) throw new Exception("错误回执无效");
        string code = (string)error["code"];
        if (status == "cancelled") { if (code != "CANCELLED") throw new Exception("取消回执矛盾"); return 130; }
        if (status != "failed") throw new Exception("失败状态无效");
        if (code == "INVALID_ARGUMENT") return 2;
        if (code == "DIRECTORY_BUSY") return 4;
        return new[] { "STORAGE_FAILED", "PROCESS_EXITED", "PROTOCOL_ERROR", "CLEANUP_TIMEOUT", "CLEANUP_FAILED", "EXECUTION_FAILED" }.Contains(code) ? 5 : 3;
    }
    public static int Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        operation = args.Length > 0 ? args[0] : null;
        for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "--output") requestedOutput = args[i + 1];
        bool text = args.Length == 1 && (args[0] == "--help" || args[0] == "--version");
        IntPtr job = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero, inRead = IntPtr.Zero, inWrite = IntPtr.Zero;
        PI child = new PI(); bool started = false, assigned = false;
        string runtimeDirectory = null;
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string exe = Path.Combine(root, "app", "VideoCutTool.exe");
            if (!File.Exists(exe)) throw new FileNotFoundException("缺少 app/VideoCutTool.exe，请保留便携包完整结构", exe);
            job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "无法建立进程归属控制");
            var limit = new LIMIT(); limit.basic.flags = 0x2000;
            Check(SetInformationJobObject(job, 9, ref limit, Marshal.SizeOf(typeof(LIMIT))), "无法设置进程树退出策略");
            var sa = new SA { size = Marshal.SizeOf(typeof(SA)), inherit = 1 };
            Check(CreatePipe(out outRead, out outWrite, ref sa, 0), "stdout 管道失败");
            Check(CreatePipe(out errRead, out errWrite, ref sa, 0), "stderr 管道失败");
            Check(CreatePipe(out inRead, out inWrite, ref sa, 0), "控制管道失败");
            foreach (IntPtr handle in new[] { outRead, errRead, inWrite }) Check(SetHandleInformation(handle, 1, 0), "管道归属设置失败");
            var si = new SI { size = Marshal.SizeOf(typeof(SI)), flags = STARTF_USESTDHANDLES, input = inRead, output = outWrite, error = errWrite };
            Environment.SetEnvironmentVariable("VCT_WORKSPACE_DIR", root.TrimEnd(Path.DirectorySeparatorChar));
            string runtimeId = Guid.NewGuid().ToString();
            Environment.SetEnvironmentVariable("VCT_CLI_RUNTIME_ID", runtimeId);
            runtimeDirectory = Path.GetFullPath(Path.Combine(root, "..", "videoCutTool_tmp", "cli-runtime", runtimeId));
            var command = new StringBuilder(Quote(exe) + " --vct-cli " + String.Join(" ", args.Select(Quote)));
            Console.CancelKeyPress += (sender, e) => { e.Cancel = true; Cancel(); };
            Check(CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, root, ref si, out child), "子进程启动失败");
            started = true;
            Check(AssignProcessToJobObject(job, child.process), "子进程无法加入专属 Job"); assigned = true;
            Close(ref outWrite); Close(ref errWrite); Close(ref inRead);
            control = new StreamWriter(new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write), new UTF8Encoding(false)); inWrite = IntPtr.Zero;
            var stdout = new StreamReader(new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read), new UTF8Encoding(false, true)); outRead = IntPtr.Zero;
            var stderr = new StreamReader(new FileStream(new SafeFileHandle(errRead, true), FileAccess.Read), new UTF8Encoding(false)); errRead = IntPtr.Zero;
            string output = null;
            var outThread = new Thread(() => {
                try {
                    var buffer = new StringBuilder(); var chars = new char[4096]; int count;
                    while ((count = stdout.Read(chars, 0, chars.Length)) > 0) {
                        if (buffer.Length + count > 1024 * 1024) { protocolFailure = "stdout 超过 1 MiB 上限"; Cancel(); break; }
                        buffer.Append(chars, 0, count);
                    }
                    output = buffer.ToString();
                } catch (Exception e) { protocolFailure = "stdout 读取失败：" + e.Message; Cancel(); }
                finally { stdout.Dispose(); }
            });
            var errThread = new Thread(() => {
                try { var chars = new char[4096]; int count; while ((count = stderr.Read(chars, 0, chars.Length)) > 0) { Console.Error.Write(chars, 0, count); Console.Error.Flush(); } }
                catch (Exception e) { protocolFailure = "stderr 转发失败：" + e.Message; Cancel(); }
                finally { stderr.Dispose(); }
            });
            outThread.IsBackground = true; errThread.IsBackground = true; outThread.Start(); errThread.Start();
            if (cancelRequested != 0) { control.WriteLine("VCT_CANCEL"); control.Flush(); }
            Check(ResumeThread(child.thread) != 0xffffffff, "无法恢复子进程"); Close(ref child.thread);
            var deadline = new Stopwatch(); bool timedOut = false;
            while (WaitForSingleObject(child.process, 50) == WAIT_TIMEOUT) {
                if (cancelRequested != 0 && !deadline.IsRunning) deadline.Start();
                if (deadline.ElapsedMilliseconds >= 15000) { timedOut = true; Check(TerminateJobObject(job, 5), "终止本次进程树失败"); WaitForSingleObject(child.process, INFINITE); break; }
            }
            uint code; Check(GetExitCodeProcess(child.process, out code), "读取退出码失败");
            // 主进程已退出后关闭 Job，阻止异常残留后代继续占用管道和媒体文件。
            Close(ref job);
            string cleanupError = null;
            try { if (Directory.Exists(runtimeDirectory)) Directory.Delete(runtimeDirectory, true); }
            catch (Exception e) { cleanupError = "Electron 运行目录清理失败：" + e.Message; }
            if (!outThread.Join(15000) || !errThread.Join(15000)) return Failure("CLEANUP_TIMEOUT", "标准流或进程树收尾超时", true);
            if (timedOut) return Failure("CLEANUP_TIMEOUT", "取消后 15 秒未完成收尾，已终止本次进程树", true);
            if (protocolFailure != null) return Failure("PROTOCOL_ERROR", protocolFailure, true);
            if (text && code == 0) { Console.Out.Write(output); return 0; }
            if (String.IsNullOrWhiteSpace(output)) return Failure("PROCESS_EXITED", "子进程退出但没有最终回执；退出码 " + code, true);
            try {
                string[] lines = output.Trim().Split(new[] { '\n' }, StringSplitOptions.None);
                if (lines.Length != 1) throw new Exception("stdout 必须只有一行最终 JSON");
                var result = Json.DeserializeObject(lines[0]) as Dictionary<string, object>;
                if (result == null || ExpectedCode(result) != code) throw new Exception("最终回执与退出码矛盾");
                if (cleanupError != null) {
                    var error = result.ContainsKey("error") ? result["error"] as Dictionary<string, object> : null;
                    if (error != null && (string)error["code"] == "STORAGE_FAILED") error["details"] = new[] { cleanupError };
                    else result["error"] = new { code = "CLEANUP_FAILED", message = cleanupError };
                    result["ok"] = false; result["status"] = "failed";
                    Console.Out.WriteLine(Json.Serialize(result)); return 5;
                }
                Console.Out.WriteLine(lines[0].TrimEnd('\r')); return (int)code;
            } catch (Exception e) { Console.Error.WriteLine(output); return Failure("PROCESS_EXITED", "无法确认最终结果：" + e.Message, true); }
        } catch (Exception e) {
            Console.Error.WriteLine(e.ToString());
            if (started) { if (assigned) TerminateJobObject(job, 5); else TerminateProcess(child.process, 5); WaitForSingleObject(child.process, 15000); }
            return Failure(started ? "PROCESS_EXITED" : "LAUNCH_FAILED", e.Message, started);
        } finally {
            lock (ControlSync) { if (control != null) { control.Dispose(); control = null; } }
            Close(ref child.thread); Close(ref child.process); Close(ref job);
            Close(ref outRead); Close(ref outWrite); Close(ref errRead); Close(ref errWrite); Close(ref inRead); Close(ref inWrite);
            try { if (runtimeDirectory != null && Directory.Exists(runtimeDirectory)) Directory.Delete(runtimeDirectory, true); }
            catch (Exception e) { Console.Error.WriteLine("运行目录保留待检查：" + e.Message); }
        }
    }
}
