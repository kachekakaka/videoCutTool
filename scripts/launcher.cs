using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace VideoCutToolLauncher
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string targetExe = Path.Combine(baseDir, "app", "VideoCutTool.exe");

                if (!File.Exists(targetExe))
                {
                    MessageBox.Show(
                        "未找到 VideoCutTool 核心程序：\n" + targetExe + "\n\n请确保 app 文件夹存在且内容完整。",
                        "启动失败 - VideoCutTool",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                    return;
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = targetExe;
                psi.WorkingDirectory = Path.Combine(baseDir, "app");
                psi.Arguments = string.Join(" ", args);
                psi.UseShellExecute = false;
                psi.EnvironmentVariables["VCT_WORKSPACE_DIR"] = baseDir;

                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "启动 VideoCutTool 核心程序异常：\n" + ex.Message,
                    "启动错误 - VideoCutTool",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }
    }
}
