using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace Yisi.ImageTool
{
    /// <summary>
    /// 一次可用的更新信息。版本已归一化为四段，便于和当前程序集版本比较。
    /// </summary>
    internal sealed class UpdateInfo
    {
        internal Version Version;
        internal string VersionText;
        internal string Notes;
        internal string ReleaseUrl;
        internal string DownloadUrl;
        internal long Size;
        internal string Sha256;
        internal string Source;
    }

    internal sealed class UpdateException : Exception
    {
        internal UpdateException(string message)
            : base(message)
        {
        }
    }

    /// <summary>
    /// 从 GitHub / Gitee Release 读取最新版本，并下载、校验安装包。
    /// 只读取公开接口，不需要账号或令牌。
    /// </summary>
    internal static class UpdateService
    {
        private const string GitHubLatestUrl =
            "https://api.github.com/repos/yisi-code/Yisi-Image/releases/latest";
        private const string GiteeLatestUrl =
            "https://gitee.com/api/v5/repos/yisi-code/yisi-image/releases/latest";
        private const string UserAgent = "YisiImageTool-Updater/1.0";
        private static string customSourceRoot;

        /// <summary>
        /// 仅用于本地自动化验证：把更新源指向一个返回 github.json / gitee.json 的目录。
        /// 正常启动不会调用。
        /// </summary>
        internal static void UseCustomSource(string root)
        {
            if (string.IsNullOrWhiteSpace(root))
            {
                return;
            }

            customSourceRoot = root.TrimEnd('/');
        }

        internal static Version CurrentVersion()
        {
            Version version = typeof(UpdateService).Assembly.GetName().Version;
            return NormalizeVersion(version);
        }

        internal static string FormatVersion(Version version)
        {
            if (version == null)
            {
                return "0.0.0";
            }

            return version.Major + "." + version.Minor + "." + Math.Max(version.Build, 0);
        }

        /// <summary>
        /// 返回比当前版本新的最高版本；没有更新返回 null。
        /// 两个源都失败时抛出 UpdateException，便于界面区分“已是最新”和“网络失败”。
        /// </summary>
        internal static UpdateInfo CheckForUpdate()
        {
            Version current = CurrentVersion();
            string[] errors = new string[2];
            bool anySourceWorked = false;
            UpdateInfo best = null;

            string githubUrl = customSourceRoot == null
                ? GitHubLatestUrl
                : customSourceRoot + "/github.json";
            string giteeUrl = customSourceRoot == null
                ? GiteeLatestUrl
                : customSourceRoot + "/gitee.json";

            try
            {
                UpdateInfo info = ReadRelease(githubUrl, "GitHub");
                anySourceWorked = true;
                if (info != null && info.Version > current)
                {
                    best = info;
                }
            }
            catch (Exception ex)
            {
                errors[0] = "GitHub：" + ex.Message;
            }

            try
            {
                UpdateInfo info = ReadRelease(giteeUrl, "Gitee");
                anySourceWorked = true;
                if (info != null && info.Version > current &&
                    (best == null || info.Version > best.Version))
                {
                    best = info;
                }
            }
            catch (Exception ex)
            {
                errors[1] = "Gitee：" + ex.Message;
            }

            if (!anySourceWorked)
            {
                throw new UpdateException(
                    "无法连接更新服务器。\n" +
                    errors[0] + "\n" + errors[1]);
            }

            return best;
        }

        private static UpdateInfo ReadRelease(string url, string source)
        {
            string json = GetString(url);
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 4 * 1024 * 1024;
            Dictionary<string, object> root =
                serializer.DeserializeObject(json) as Dictionary<string, object>;
            if (root == null)
            {
                throw new UpdateException("更新接口返回格式不正确。");
            }

            string tag = GetString(root, "tag_name");
            if (string.IsNullOrWhiteSpace(tag))
            {
                throw new UpdateException("更新信息缺少版本号。");
            }

            Version version = ParseVersion(tag);
            if (version == null)
            {
                throw new UpdateException("无法识别版本号：" + tag);
            }

            string body = GetString(root, "body");
            string releaseUrl = GetString(root, "html_url");
            if (string.IsNullOrWhiteSpace(releaseUrl))
            {
                releaseUrl = source == "GitHub"
                    ? "https://github.com/yisi-code/Yisi-Image/releases"
                    : "https://gitee.com/yisi-code/yisi-image/releases";
            }

            object[] assets = GetArray(root, "assets");
            Dictionary<string, object> asset = FindWindowsAsset(assets);
            if (asset == null)
            {
                throw new UpdateException("发布中没有找到 Windows 安装包。");
            }

            string downloadUrl = GetString(asset, "browser_download_url");
            if (string.IsNullOrWhiteSpace(downloadUrl))
            {
                downloadUrl = GetString(asset, "download_url");
            }
            if (string.IsNullOrWhiteSpace(downloadUrl))
            {
                throw new UpdateException("安装包缺少下载地址。");
            }

            downloadUrl = new Uri(new Uri(url), downloadUrl).ToString();
            string sha = FindSha256(body);
            if (string.IsNullOrWhiteSpace(sha))
            {
                sha = FindSha256(GetString(asset, "digest"));
            }

            return new UpdateInfo
            {
                Version = version,
                VersionText = FormatVersion(version),
                Notes = string.IsNullOrWhiteSpace(body) ? "本次更新没有附说明。" : body.Trim(),
                ReleaseUrl = releaseUrl,
                DownloadUrl = downloadUrl,
                Size = GetLong(asset, "size"),
                Sha256 = sha,
                Source = source,
            };
        }

        private static Dictionary<string, object> FindWindowsAsset(object[] assets)
        {
            if (assets == null || assets.Length == 0)
            {
                return null;
            }

            Dictionary<string, object> firstExe = null;
            foreach (object value in assets)
            {
                Dictionary<string, object> asset = value as Dictionary<string, object>;
                if (asset == null)
                {
                    continue;
                }

                string name = GetString(asset, "name");
                if (string.IsNullOrWhiteSpace(name) ||
                    !name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (firstExe == null)
                {
                    firstExe = asset;
                }
                if (string.Equals(name, "YisiImageTool.exe", StringComparison.OrdinalIgnoreCase))
                {
                    return asset;
                }
            }

            return firstExe;
        }

        /// <summary>
        /// 下载到本地更新目录，边下边回报百分比；完成后再校验 SHA-256。
        /// 没有发布校验值的版本会被拒绝自动安装。
        /// </summary>
        internal static string Download(
            UpdateInfo info,
            Action<int, long, long> progress,
            Func<bool> isCanceled)
        {
            if (info == null)
            {
                throw new UpdateException("没有可下载的更新。");
            }
            if (string.IsNullOrWhiteSpace(info.Sha256))
            {
                throw new UpdateException("该版本没有提供 SHA-256 校验值，已停止自动安装。");
            }

            string folder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "YisiImageTool",
                "updates");
            Directory.CreateDirectory(folder);

            string safeVersion = Regex.Replace(info.VersionText, "[^0-9.]", string.Empty);
            string target = Path.Combine(folder, "YisiImageTool-" + safeVersion + ".exe");
            if (File.Exists(target) && VerifySha256(target, info.Sha256))
            {
                if (progress != null)
                {
                    progress(100, 1, 1);
                }
                return target;
            }

            string partial = target + ".part";
            if (File.Exists(partial))
            {
                File.Delete(partial);
            }

            HttpWebRequest request = CreateRequest(info.DownloadUrl, 30000, 30000);
            try
            {
                using (WebResponse response = request.GetResponse())
                using (Stream input = response.GetResponseStream())
                using (FileStream output = new FileStream(
                    partial,
                    FileMode.Create,
                    FileAccess.Write,
                    FileShare.None))
                {
                    long total = response.ContentLength > 0
                        ? response.ContentLength
                        : info.Size;
                    long received = 0;
                    byte[] buffer = new byte[81920];
                    int lastPercent = -1;

                    while (true)
                    {
                        if (isCanceled != null && isCanceled())
                        {
                            throw new UpdateException("已取消下载。");
                        }

                        int read = input.Read(buffer, 0, buffer.Length);
                        if (read <= 0)
                        {
                            break;
                        }

                        output.Write(buffer, 0, read);
                        received += read;
                        if (progress != null)
                        {
                            int percent = total > 0
                                ? (int)Math.Min(100, received * 100 / total)
                                : 0;
                            if (percent != lastPercent)
                            {
                                lastPercent = percent;
                                progress(percent, received, total);
                            }
                        }
                    }
                }

                long actualSize = new FileInfo(partial).Length;
                if (info.Size > 0 && actualSize != info.Size)
                {
                    throw new UpdateException(
                        "安装包大小不一致：应为 " + info.Size + " 字节，实际 " +
                        actualSize + " 字节。");
                }
                if (!VerifySha256(partial, info.Sha256))
                {
                    throw new UpdateException("安装包 SHA-256 校验失败，文件可能不完整。");
                }

                if (File.Exists(target))
                {
                    File.Delete(target);
                }
                File.Move(partial, target);
                if (progress != null)
                {
                    progress(100, actualSize, actualSize);
                }
                return target;
            }
            catch
            {
                if (File.Exists(partial))
                {
                    try
                    {
                        File.Delete(partial);
                    }
                    catch
                    {
                        // 清理失败不影响把原始异常返回给界面。
                    }
                }
                throw;
            }
        }

        private static bool VerifySha256(string file, string expected)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = new FileStream(
                file,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read))
            {
                byte[] hash = sha.ComputeHash(stream);
                StringBuilder text = new StringBuilder(hash.Length * 2);
                foreach (byte value in hash)
                {
                    text.Append(value.ToString("x2", CultureInfo.InvariantCulture));
                }
                return string.Equals(
                    text.ToString(),
                    expected.Trim(),
                    StringComparison.OrdinalIgnoreCase);
            }
        }

        private static string GetString(string url)
        {
            HttpWebRequest request = CreateRequest(url, 12000, 12000);
            using (WebResponse response = request.GetResponse())
            using (Stream stream = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        private static HttpWebRequest CreateRequest(
            string url,
            int timeoutMilliseconds,
            int readWriteTimeoutMilliseconds)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.UserAgent = UserAgent;
            request.Accept = "application/json, application/octet-stream, */*";
            request.Timeout = timeoutMilliseconds;
            request.ReadWriteTimeout = readWriteTimeoutMilliseconds;
            request.AllowAutoRedirect = true;
            return request;
        }

        private static Version ParseVersion(string tag)
        {
            string text = tag.Trim();
            if (text.StartsWith("v", StringComparison.OrdinalIgnoreCase))
            {
                text = text.Substring(1);
            }

            int dash = text.IndexOf('-');
            if (dash >= 0)
            {
                text = text.Substring(0, dash);
            }

            Version version;
            if (!Version.TryParse(text, out version))
            {
                return null;
            }
            return NormalizeVersion(version);
        }

        private static Version NormalizeVersion(Version version)
        {
            return new Version(
                version.Major,
                version.Minor,
                Math.Max(version.Build, 0),
                Math.Max(version.Revision, 0));
        }

        private static string FindSha256(string text)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                return null;
            }

            Match match = Regex.Match(
                text,
                @"(?im)^\s*(?:[-*]\s*)?SHA-?256\s*[:：]\s*([a-f0-9]{64})\s*$");
            if (match.Success)
            {
                return match.Groups[1].Value;
            }

            match = Regex.Match(text, @"(?i)\bsha256:([a-f0-9]{64})\b");
            return match.Success ? match.Groups[1].Value : null;
        }

        private static string GetString(Dictionary<string, object> dictionary, string key)
        {
            object value;
            if (dictionary == null || !dictionary.TryGetValue(key, out value) || value == null)
            {
                return string.Empty;
            }
            return Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        private static object[] GetArray(Dictionary<string, object> dictionary, string key)
        {
            object value;
            if (dictionary == null || !dictionary.TryGetValue(key, out value))
            {
                return null;
            }
            return value as object[];
        }

        private static long GetLong(Dictionary<string, object> dictionary, string key)
        {
            object value;
            if (dictionary == null || !dictionary.TryGetValue(key, out value) || value == null)
            {
                return 0;
            }

            try
            {
                return Convert.ToInt64(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return 0;
            }
        }
    }

    /// <summary>
    /// 更新相关的本地状态：上次检查时间、已提示过的版本。
    /// </summary>
    internal static class UpdateSettings
    {
        private static string Folder
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "YisiImageTool");
            }
        }

        private static string LastCheckFile
        {
            get { return Path.Combine(Folder, "last-update-check.txt"); }
        }

        private static string PromptedFile
        {
            get { return Path.Combine(Folder, "prompted-update.txt"); }
        }

        internal static bool ShouldAutoCheck()
        {
            try
            {
                if (!File.Exists(LastCheckFile))
                {
                    return true;
                }

                string text = File.ReadAllText(LastCheckFile, Encoding.UTF8).Trim();
                long ticks;
                if (!long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out ticks))
                {
                    return true;
                }

                DateTime last = new DateTime(ticks, DateTimeKind.Utc);
                return DateTime.UtcNow - last >= TimeSpan.FromHours(24);
            }
            catch
            {
                return true;
            }
        }

        internal static void MarkChecked()
        {
            try
            {
                Directory.CreateDirectory(Folder);
                File.WriteAllText(
                    LastCheckFile,
                    DateTime.UtcNow.Ticks.ToString(CultureInfo.InvariantCulture),
                    Encoding.UTF8);
            }
            catch
            {
                // 状态文件写入失败只影响下次是否自动检查，不影响更新本身。
            }
        }

        internal static string PromptedVersion()
        {
            try
            {
                return File.Exists(PromptedFile)
                    ? File.ReadAllText(PromptedFile, Encoding.UTF8).Trim()
                    : string.Empty;
            }
            catch
            {
                return string.Empty;
            }
        }

        internal static void MarkPrompted(string version)
        {
            try
            {
                Directory.CreateDirectory(Folder);
                File.WriteAllText(PromptedFile, version ?? string.Empty, Encoding.UTF8);
            }
            catch
            {
                // 忽略状态写入失败。
            }
        }
    }
}
