using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Yisi.ImageTool
{
    /// <summary>
    /// 配置读写失败时给页面看的错误；Message 直接显示给用户，不以句号结尾。
    /// </summary>
    internal sealed class ConfigException : Exception
    {
        public ConfigException(string message)
            : base(message)
        {
        }

        public ConfigException(string message, Exception innerException)
            : base(message, innerException)
        {
        }
    }

    /// <summary>
    /// 页面设置的配置文件。默认放在 EXE 所在目录，可在设置页改到其他目录。
    /// 自定义目录记在 EXE 目录的位置文件里；EXE 目录不可写（如 Program Files）时改记到
    /// %LOCALAPPDATA%\YisiImageTool。设置字段由页面校验，这里只保证是 JSON 对象、大小受限、原子写入。
    /// </summary>
    internal static class ConfigStore
    {
        internal const string SettingsFileName = "yisi-image-tool.settings.json";
        internal const int MaxSettingsBytes = 64 * 1024;
        private const string LocationFileName = "yisi-image-tool.config-dir.txt";
        private static readonly object Sync = new object();

        internal static string DefaultDirectory
        {
            get
            {
                return NormalizeDirectory(
                    Path.GetDirectoryName(Path.GetFullPath(Application.ExecutablePath)));
            }
        }

        /// <summary>位置记录文件：主位置在 EXE 目录，EXE 目录不可写时用 %LOCALAPPDATA%\YisiImageTool。</summary>
        private static string PrimaryLocationFile(string locationFileName)
        {
            return Path.Combine(DefaultDirectory, locationFileName);
        }

        private static string FallbackLocationFile(string locationFileName)
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "YisiImageTool",
                locationFileName);
        }

        internal static string CurrentDirectory()
        {
            return ReadCustomDirectory(LocationFileName) ?? DefaultDirectory;
        }

        /// <summary>
        /// 读取某个位置记录文件里的自定义目录；没有记录时返回 null。配置目录与 AI 模型目录共用这套记录方式。
        /// </summary>
        internal static string ReadCustomDirectory(string locationFileName)
        {
            // 备用位置文件只在 EXE 目录写不进去时才会生成，且主位置写成功时会删掉它，所以它存在就代表最新。
            string custom = ReadLocationFile(FallbackLocationFile(locationFileName));
            if (custom == null)
            {
                custom = ReadLocationFile(PrimaryLocationFile(locationFileName));
            }
            return custom;
        }

        /// <summary>GET /api/config 的完整响应：设置原文（规范化后的 JSON 或 null）与位置信息。</summary>
        internal static string BuildSnapshotJson()
        {
            lock (Sync)
            {
                string settings = ReadSettingsJson();
                return "{\"ok\":true,\"settings\":" + (settings ?? "null") +
                    ",\"location\":" + DescribeJson() + "}";
            }
        }

        internal static string DescribeJson()
        {
            string dir = CurrentDirectory();
            string defaultDir = DefaultDirectory;
            string file = Path.Combine(dir, SettingsFileName);
            Dictionary<string, object> location = new Dictionary<string, object>();
            location["dir"] = dir;
            location["file"] = file;
            location["defaultDir"] = defaultDir;
            location["isDefault"] = SameDirectory(dir, defaultDir);
            location["exists"] = File.Exists(file);
            return new JavaScriptSerializer().Serialize(location);
        }

        internal static void WriteSettingsJson(string json)
        {
            if (json == null || Encoding.UTF8.GetByteCount(json) > MaxSettingsBytes)
            {
                throw new ConfigException("设置内容过大");
            }
            if (Canonicalize(json) == null)
            {
                throw new ConfigException("设置内容不是有效的 JSON 对象");
            }

            lock (Sync)
            {
                WriteAtomic(Path.Combine(CurrentDirectory(), SettingsFileName), json);
            }
        }

        /// <summary>
        /// 把配置文件移到 targetDirectory（null 或空表示移回 EXE 所在目录）。
        /// 先写新位置、再改位置记录、最后删旧文件；记录写失败时撤销新位置的改动。
        /// 返回 false 表示目标就是当前目录，什么都没做。
        /// </summary>
        internal static bool MoveTo(string targetDirectory)
        {
            lock (Sync)
            {
                string defaultDir = DefaultDirectory;
                string targetDir = string.IsNullOrWhiteSpace(targetDirectory)
                    ? defaultDir
                    : ValidateTarget(targetDirectory);
                string currentDir = CurrentDirectory();
                if (SameDirectory(targetDir, currentDir))
                {
                    return false;
                }

                string currentFile = Path.Combine(currentDir, SettingsFileName);
                string targetFile = Path.Combine(targetDir, SettingsFileName);
                string json = null;
                if (File.Exists(currentFile))
                {
                    string text = File.ReadAllText(currentFile, Encoding.UTF8);
                    if (Canonicalize(text) != null)
                    {
                        json = text;
                    }
                }

                // 目标目录已有同名配置时先备份，避免把别处留下的配置直接覆盖掉。
                string backupFile = targetFile + ".bak";
                bool hadTargetFile = File.Exists(targetFile);
                if (hadTargetFile)
                {
                    try
                    {
                        File.Copy(targetFile, backupFile, true);
                    }
                    catch (Exception ex)
                    {
                        throw new ConfigException("无法备份目标目录里已有的配置文件：" + ex.Message, ex);
                    }
                }

                if (json != null)
                {
                    WriteAtomic(targetFile, json);
                }
                else
                {
                    EnsureWritable(targetDir);
                }

                try
                {
                    SaveCustomDirectory(LocationFileName, SameDirectory(targetDir, defaultDir) ? null : targetDir);
                }
                catch
                {
                    RollbackTarget(targetFile, backupFile, hadTargetFile, json != null);
                    throw;
                }

                if (File.Exists(currentFile))
                {
                    try
                    {
                        File.Delete(currentFile);
                    }
                    catch
                    {
                        // 旧文件删不掉不影响使用：位置记录已指向新目录，旧文件不会再被读取。
                    }
                }
                return true;
            }
        }

        internal static void OpenInExplorer()
        {
            string dir = CurrentDirectory();
            string file = Path.Combine(dir, SettingsFileName);
            if (File.Exists(file))
            {
                Process.Start("explorer.exe", "/select,\"" + file + "\"");
                return;
            }
            if (Directory.Exists(dir))
            {
                Process.Start("explorer.exe", "\"" + dir + "\"");
                return;
            }
            throw new ConfigException("配置目录不存在：" + dir);
        }

        /// <summary>
        /// 读取当前配置文件并规范化成标准 JSON；内容损坏时改名保留，返回 null 让页面按默认值重建。
        /// </summary>
        private static string ReadSettingsJson()
        {
            string file = Path.Combine(CurrentDirectory(), SettingsFileName);
            if (!File.Exists(file))
            {
                return null;
            }

            string text;
            try
            {
                text = File.ReadAllText(file, Encoding.UTF8);
            }
            catch (Exception ex)
            {
                throw new ConfigException("无法读取配置文件：" + ex.Message, ex);
            }

            string canonical = Canonicalize(text);
            if (canonical != null)
            {
                return canonical;
            }

            try
            {
                File.Move(
                    file,
                    file + ".corrupt-" +
                    DateTime.Now.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture));
            }
            catch
            {
                // 改名失败时下次保存会直接覆盖损坏内容。
            }
            return null;
        }

        /// <summary>是 JSON 对象时返回重新序列化的标准 JSON，否则返回 null。</summary>
        private static string Canonicalize(string text)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                return null;
            }
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                object parsed = serializer.DeserializeObject(text);
                return parsed is Dictionary<string, object> ? serializer.Serialize(parsed) : null;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>校验用户选的目录：必须是完整路径、不是文件、能创建；返回规范化后的路径。</summary>
        internal static string ValidateTarget(string target)
        {
            string trimmed = target.Trim();
            bool isAbsolute =
                (trimmed.Length >= 3 && trimmed[1] == ':' &&
                 (trimmed[2] == '\\' || trimmed[2] == '/')) ||
                trimmed.StartsWith(@"\\", StringComparison.Ordinal);
            if (!isAbsolute)
            {
                throw new ConfigException("请选择完整的目录路径：" + trimmed);
            }

            string full;
            try
            {
                full = NormalizeDirectory(trimmed);
            }
            catch (Exception ex)
            {
                throw new ConfigException("目录路径无效：" + trimmed, ex);
            }

            if (File.Exists(full))
            {
                throw new ConfigException("这是一个文件，不是目录：" + full);
            }
            try
            {
                Directory.CreateDirectory(full);
            }
            catch (Exception ex)
            {
                throw new ConfigException("无法创建目录：" + full + "（" + ex.Message + "）", ex);
            }
            return full;
        }

        /// <summary>写位置记录；customDirectory 为 null 表示恢复默认目录（删掉记录）。</summary>
        internal static void SaveCustomDirectory(string locationFileName, string customDirectory)
        {
            string primary = PrimaryLocationFile(locationFileName);
            string fallbackFile = FallbackLocationFile(locationFileName);
            if (customDirectory == null)
            {
                DeleteQuietly(primary);
                DeleteQuietly(fallbackFile);
                return;
            }

            try
            {
                File.WriteAllText(primary, customDirectory, new UTF8Encoding(false));
                DeleteQuietly(fallbackFile);
                return;
            }
            catch (UnauthorizedAccessException)
            {
                // EXE 目录不可写，改记到当前用户目录。
            }
            catch (IOException)
            {
                // 同上。
            }

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(fallbackFile));
                File.WriteAllText(fallbackFile, customDirectory, new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                throw new ConfigException("无法记录新的目录位置：" + ex.Message, ex);
            }
        }

        private static void RollbackTarget(
            string targetFile,
            string backupFile,
            bool hadTargetFile,
            bool wroteTarget)
        {
            if (!wroteTarget)
            {
                return;
            }
            try
            {
                if (hadTargetFile)
                {
                    File.Copy(backupFile, targetFile, true);
                }
                else
                {
                    File.Delete(targetFile);
                }
            }
            catch
            {
                // 回滚失败时保留新文件；位置记录没变，程序仍读旧目录。
            }
        }

        private static string ReadLocationFile(string path)
        {
            try
            {
                if (!File.Exists(path))
                {
                    return null;
                }
                string text = File.ReadAllText(path, Encoding.UTF8).Trim();
                if (text.Length == 0 || !Path.IsPathRooted(text))
                {
                    return null;
                }
                return NormalizeDirectory(text);
            }
            catch
            {
                return null;
            }
        }

        private static void WriteAtomic(string file, string text)
        {
            string dir = Path.GetDirectoryName(file);
            string temp = file + ".tmp";
            try
            {
                Directory.CreateDirectory(dir);
                File.WriteAllText(temp, text, new UTF8Encoding(false));
                if (File.Exists(file))
                {
                    try
                    {
                        File.Replace(temp, file, null);
                    }
                    catch (IOException)
                    {
                        // 部分文件系统（网络盘、FAT）不支持 Replace，退回覆盖复制。
                        File.Copy(temp, file, true);
                        File.Delete(temp);
                    }
                }
                else
                {
                    File.Move(temp, file);
                }
            }
            catch (UnauthorizedAccessException ex)
            {
                DeleteQuietly(temp);
                throw new ConfigException("没有写入权限：" + dir, ex);
            }
            catch (IOException ex)
            {
                DeleteQuietly(temp);
                throw new ConfigException("写入配置文件失败：" + ex.Message, ex);
            }
        }

        private static void EnsureWritable(string dir)
        {
            string probe = Path.Combine(dir, ".yisi-write-test-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                File.WriteAllText(probe, string.Empty);
            }
            catch (Exception ex)
            {
                throw new ConfigException("没有写入权限：" + dir, ex);
            }
            finally
            {
                DeleteQuietly(probe);
            }
        }

        private static void DeleteQuietly(string path)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch
            {
                // 忽略清理失败。
            }
        }

        internal static string NormalizeDirectory(string path)
        {
            string full = Path.GetFullPath(path);
            string root = Path.GetPathRoot(full);
            if (string.Equals(full, root, StringComparison.OrdinalIgnoreCase))
            {
                return full;
            }
            return full.TrimEnd('\\', '/');
        }

        internal static bool SameDirectory(string left, string right)
        {
            return string.Equals(
                NormalizeDirectory(left),
                NormalizeDirectory(right),
                StringComparison.OrdinalIgnoreCase);
        }
    }
}
