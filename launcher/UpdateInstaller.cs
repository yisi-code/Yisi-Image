using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Yisi.ImageTool
{
    /// <summary>
    /// 替换正在运行的 EXE：先退出当前进程，再由一个隐藏的 PowerShell 脚本
    /// 等待退出、备份、覆盖、重启。脚本失败时用备份恢复，避免把程序更新坏。
    /// </summary>
    internal static class UpdateInstaller
    {
        internal static void CleanupOldFiles()
        {
            try
            {
                string folder = UpdateFolder();
                if (!Directory.Exists(folder))
                {
                    return;
                }

                DateTime cutoff = DateTime.UtcNow.AddDays(-7);
                foreach (string file in Directory.GetFiles(folder, "*.ps1"))
                {
                    try
                    {
                        if (File.GetLastWriteTimeUtc(file) < cutoff)
                        {
                            File.Delete(file);
                        }
                    }
                    catch
                    {
                        // 清理失败不影响主流程。
                    }
                }
            }
            catch
            {
                // 忽略清理异常。
            }
        }

        internal static void Launch(string newExePath)
        {
            if (string.IsNullOrWhiteSpace(newExePath) || !File.Exists(newExePath))
            {
                throw new UpdateException("下载的安装包不存在，无法安装。");
            }
            if (!LooksLikeExecutable(newExePath))
            {
                throw new UpdateException("下载的文件不是有效的 Windows 程序。");
            }

            string target = Path.GetFullPath(Application.ExecutablePath);
            string targetFolder = Path.GetDirectoryName(target);
            if (string.IsNullOrWhiteSpace(targetFolder))
            {
                throw new UpdateException("无法确定程序所在目录。");
            }
            EnsureWritable(targetFolder);

            string folder = UpdateFolder();
            Directory.CreateDirectory(folder);
            string scriptPath = Path.Combine(
                folder,
                "apply-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture) +
                "-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".ps1");
            string backupPath = Path.Combine(folder, "previous-version.exe");
            string logPath = Path.Combine(folder, "update.log");

            string script = BuildScript(
                Process.GetCurrentProcess().Id,
                Path.GetFullPath(newExePath),
                target,
                backupPath,
                logPath,
                scriptPath);
            File.WriteAllText(scriptPath, script, new UTF8Encoding(true));

            string powershell = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe");
            if (!File.Exists(powershell))
            {
                powershell = "powershell.exe";
            }

            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = powershell;
            info.Arguments =
                "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" +
                scriptPath + "\"";
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WorkingDirectory = folder;
            Process.Start(info);
        }

        private static string BuildScript(
            int oldProcessId,
            string source,
            string target,
            string backup,
            string log,
            string scriptPath)
        {
            string safeSource = Quote(source);
            string safeTarget = Quote(target);
            string safeBackup = Quote(backup);
            string safeLog = Quote(log);
            string safeScript = Quote(scriptPath);

            return
                "$ErrorActionPreference = 'Stop'\r\n" +
                "$oldPid = " + oldProcessId.ToString(CultureInfo.InvariantCulture) + "\r\n" +
                "$source = " + safeSource + "\r\n" +
                "$target = " + safeTarget + "\r\n" +
                "$backup = " + safeBackup + "\r\n" +
                "$log = " + safeLog + "\r\n" +
                "function Write-UpdateLog([string]$message) {\r\n" +
                "  try { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('s') + ' ' + $message) -Encoding UTF8 } catch { }\r\n" +
                "}\r\n" +
                "try {\r\n" +
                "  $deadline = (Get-Date).AddMinutes(2)\r\n" +
                "  while (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {\r\n" +
                "    if ((Get-Date) -gt $deadline) { throw '等待旧进程退出超时' }\r\n" +
                "    Start-Sleep -Milliseconds 250\r\n" +
                "  }\r\n" +
                "  if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination $backup -Force }\r\n" +
                "  Copy-Item -LiteralPath $source -Destination $target -Force\r\n" +
                "  Start-Process -FilePath $target\r\n" +
                "  Write-UpdateLog 'OK'\r\n" +
                "  Start-Sleep -Milliseconds 800\r\n" +
                "  Remove-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue\r\n" +
                "} catch {\r\n" +
                "  Write-UpdateLog ('FAIL ' + $_.Exception.Message)\r\n" +
                "  if (Test-Path -LiteralPath $backup) {\r\n" +
                "    try {\r\n" +
                "      Copy-Item -LiteralPath $backup -Destination $target -Force\r\n" +
                "      Start-Process -FilePath $target\r\n" +
                "      Write-UpdateLog 'RESTORED'\r\n" +
                "    } catch { Write-UpdateLog ('RESTORE_FAIL ' + $_.Exception.Message) }\r\n" +
                "  }\r\n" +
                "}\r\n" +
                "try { Start-Process -WindowStyle Hidden -FilePath $env:ComSpec -ArgumentList '/c', ('ping 127.0.0.1 -n 3 >nul & del /f /q \"' + " + safeScript + " + '\"') } catch { }\r\n";
        }

        private static string Quote(string value)
        {
            return "'" + (value ?? string.Empty).Replace("'", "''") + "'";
        }

        private static bool LooksLikeExecutable(string path)
        {
            try
            {
                using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    int first = stream.ReadByte();
                    int second = stream.ReadByte();
                    return first == 'M' && second == 'Z';
                }
            }
            catch
            {
                return false;
            }
        }

        private static void EnsureWritable(string folder)
        {
            string probe = Path.Combine(
                folder,
                ".yisi-write-test-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                using (FileStream stream = new FileStream(
                    probe,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None))
                {
                    stream.WriteByte(0);
                }
                File.Delete(probe);
            }
            catch (Exception ex)
            {
                throw new UpdateException(
                    "程序所在目录没有写入权限，无法自动安装。请把程序放到可写入的目录后再试。\n" +
                    ex.Message);
            }
            finally
            {
                try
                {
                    if (File.Exists(probe))
                    {
                        File.Delete(probe);
                    }
                }
                catch
                {
                    // 忽略探测文件清理失败。
                }
            }
        }

        private static string UpdateFolder()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "YisiImageTool",
                "updates");
        }
    }
}
