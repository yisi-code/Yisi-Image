using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Yisi.ImageTool
{
    /// <summary>模型下载、删除、换目录失败时给页面看的错误；Message 直接显示给用户。</summary>
    internal sealed class ModelException : Exception
    {
        public ModelException(string message)
            : base(message)
        {
        }

        public ModelException(string message, Exception innerException)
            : base(message, innerException)
        {
        }
    }

    /// <summary>AI 模型（修瑕、清晰化）要用的一个文件：本地文件名、字节数、SHA-256 和按顺序尝试的下载地址。</summary>
    internal sealed class ModelFile
    {
        internal readonly string Name;
        internal readonly long Size;
        internal readonly string Sha256;
        internal readonly string ContentType;
        internal readonly string[] Urls;

        internal ModelFile(string name, long size, string sha256, string contentType, string[] urls)
        {
            Name = name;
            Size = size;
            Sha256 = sha256;
            ContentType = contentType;
            Urls = urls;
        }
    }

    /// <summary>一个可选的 AI 模型：运行库 + 模型文件，两者都下载完才能用。</summary>
    internal sealed class ModelEntry
    {
        internal readonly string Id;
        internal readonly ModelFile Runtime;
        internal readonly ModelFile Model;

        internal ModelEntry(string id, ModelFile runtime, ModelFile model)
        {
            Id = id;
            Runtime = runtime;
            Model = model;
        }

        internal ModelFile[] Files
        {
            get { return new ModelFile[] { Runtime, Model }; }
        }
    }

    /// <summary>
    /// AI 修瑕模型的下载与存放。默认放在 EXE 目录下的 models 文件夹，可在设置页换目录。
    /// 同一时间只下载一个模型，其余排队；下载写到 .part 文件，暂停后再下载用 HTTP Range 续传，
    /// 下完按 SHA-256 校验通过才改成正式文件名。文件名、大小、哈希固定在这里，
    /// 下载地址都是公开的镜像，内容靠哈希保证与官方一致。
    /// </summary>
    internal static class ModelStore
    {
        private const string LocationFileName = "yisi-image-tool.models-dir.txt";
        private const string PartSuffix = ".part";
        private const int MaxRedirects = 8;

        /// <summary>onnxruntime-web 1.31.1 的 wasm 运行库；与页面里打包的 onnxruntime-web 版本必须一致。</summary>
        private static readonly ModelFile RuntimeFile = new ModelFile(
            "ort-wasm-simd-threaded-1.31.1.wasm",
            14848852,
            "4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d",
            "application/wasm",
            new string[]
            {
                "https://registry.npmmirror.com/onnxruntime-web/1.31.1/files/dist/ort-wasm-simd-threaded.wasm",
                "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.wasm",
                "https://unpkg.com/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.wasm",
            });

        private static readonly ModelFile MiganFile = new ModelFile(
            "migan_pipeline_v2.onnx",
            28079181,
            "6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b",
            "application/octet-stream",
            new string[]
            {
                "https://hf-mirror.com/andraniksargsyan/migan/resolve/406830d0fa60666da0071c342ad2fbc8f30c5c64/migan_pipeline_v2.onnx",
                "https://huggingface.co/andraniksargsyan/migan/resolve/406830d0fa60666da0071c342ad2fbc8f30c5c64/migan_pipeline_v2.onnx",
            });

        private static readonly ModelFile LamaFile = new ModelFile(
            "lama_fp32.onnx",
            208044816,
            "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
            "application/octet-stream",
            new string[]
            {
                "https://hf-mirror.com/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx",
                "https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx",
            });

        /// <summary>
        /// Real-ESRGAN General x4v3（SRVGGNetCompact）的 ONNX 导出，用于 AI 清晰化；BSD-3-Clause。
        /// 输入 float32 [1,3,h,w] RGB 0–1，输出 [1,3,4h,4w]，宽高可变。
        /// </summary>
        private static readonly ModelFile RealEsrganFile = new ModelFile(
            "realesr-general-x4v3.onnx",
            4866396,
            "924ebad6532777303582d4ce7811849b88869231a3ae7093e0f21200249df8d5",
            "application/octet-stream",
            new string[]
            {
                "https://hf-mirror.com/jonathanst29/tinier-upscale-models/resolve/899dc1e4b22bbf1955c2f1739c085edc080cb366/realesr-general-x4v3.onnx",
                "https://huggingface.co/jonathanst29/tinier-upscale-models/resolve/899dc1e4b22bbf1955c2f1739c085edc080cb366/realesr-general-x4v3.onnx",
            });

        private static readonly ModelEntry[] Entries = new ModelEntry[]
        {
            new ModelEntry("migan", RuntimeFile, MiganFile),
            new ModelEntry("lama", RuntimeFile, LamaFile),
            new ModelEntry("realesrgan", RuntimeFile, RealEsrganFile),
        };

        private static readonly object Sync = new object();
        private static readonly List<string> Queue = new List<string>();
        private static readonly Dictionary<string, string> Errors = new Dictionary<string, string>();
        private static readonly ManualResetEvent Idle = new ManualResetEvent(true);
        private static string activeId;
        private static bool activeVerifying;
        private static volatile bool cancelRequested;
        private static Thread worker;

        internal static string DefaultDirectory
        {
            get { return Path.Combine(ConfigStore.DefaultDirectory, "models"); }
        }

        internal static string CurrentDirectory()
        {
            return ConfigStore.ReadCustomDirectory(LocationFileName) ?? DefaultDirectory;
        }

        /// <summary>GET /api/models 与各操作的响应：目录信息和每个模型的状态。</summary>
        internal static string DescribeJson()
        {
            lock (Sync)
            {
                string dir = CurrentDirectory();
                string defaultDir = DefaultDirectory;
                List<object> items = new List<object>();
                foreach (ModelEntry entry in Entries)
                {
                    long downloaded = 0;
                    long modelDownloaded = 0;
                    long total = 0;
                    bool allReady = true;
                    bool anyPart = false;
                    foreach (ModelFile file in entry.Files)
                    {
                        total += file.Size;
                        string final = Path.Combine(dir, file.Name);
                        string part = final + PartSuffix;
                        long fileBytes = 0;
                        if (IsComplete(final, file))
                        {
                            fileBytes = file.Size;
                        }
                        else
                        {
                            allReady = false;
                            if (File.Exists(part))
                            {
                                anyPart = true;
                                fileBytes = Math.Min(file.Size, SafeLength(part));
                            }
                        }
                        downloaded += fileBytes;
                        if (file == entry.Model)
                        {
                            modelDownloaded = fileBytes;
                        }
                    }

                    string state;
                    string error;
                    Errors.TryGetValue(entry.Id, out error);
                    if (entry.Id == activeId)
                    {
                        state = activeVerifying ? "verifying" : "downloading";
                    }
                    else if (Queue.Contains(entry.Id))
                    {
                        state = "queued";
                    }
                    else if (allReady)
                    {
                        state = "ready";
                    }
                    else if (error != null)
                    {
                        state = "error";
                    }
                    else
                    {
                        state = anyPart ? "paused" : "missing";
                    }

                    Dictionary<string, object> item = new Dictionary<string, object>();
                    item["id"] = entry.Id;
                    item["state"] = state;
                    item["downloaded"] = downloaded;
                    // 模型文件本身已下的字节；运行库各模型共用，只有它下好时模型仍算「未下载」。
                    item["modelDownloaded"] = modelDownloaded;
                    item["total"] = total;
                    item["modelSize"] = entry.Model.Size;
                    item["runtimeSize"] = entry.Runtime.Size;
                    item["error"] = state == "error" ? error : string.Empty;
                    item["runtimeUrl"] = "/models/" + entry.Runtime.Name;
                    item["modelUrl"] = "/models/" + entry.Model.Name;
                    items.Add(item);
                }

                Dictionary<string, object> result = new Dictionary<string, object>();
                result["ok"] = true;
                result["dir"] = dir;
                result["defaultDir"] = defaultDir;
                result["isDefault"] = ConfigStore.SameDirectory(dir, defaultDir);
                result["items"] = items;
                // 自定义模型与内置模型共用运行库：页面据此判断导入的模型能不能用。
                result["runtimeReady"] = IsComplete(Path.Combine(dir, RuntimeFile.Name), RuntimeFile);
                result["runtimeUrl"] = "/models/" + RuntimeFile.Name;
                result["custom"] = CustomModelStore.Describe();
                return new JavaScriptSerializer().Serialize(result);
            }
        }

        /// <summary>开始或继续下载；已在下载或排队时什么都不做。</summary>
        internal static void Download(string id)
        {
            ModelEntry entry = Find(id);
            lock (Sync)
            {
                if (activeId == entry.Id || Queue.Contains(entry.Id))
                {
                    return;
                }
                Errors.Remove(entry.Id);
                Queue.Add(entry.Id);
                if (worker == null)
                {
                    Idle.Reset();
                    worker = new Thread(Work);
                    worker.IsBackground = true;
                    worker.Name = "ModelDownload";
                    worker.Start();
                }
            }
        }

        /// <summary>暂停：从队列里拿掉；正在下载的会在写完当前这一块后停下，已下的部分留在 .part 里。</summary>
        internal static void Pause(string id)
        {
            ModelEntry entry = Find(id);
            lock (Sync)
            {
                Queue.Remove(entry.Id);
                if (activeId == entry.Id)
                {
                    cancelRequested = true;
                }
            }
        }

        /// <summary>
        /// 删除模型文件（含下了一半的）。运行库各模型共用：别的模型还有文件时保留。
        /// </summary>
        internal static void Delete(string id)
        {
            ModelEntry entry = Find(id);
            Pause(entry.Id);
            WaitUntilStopped(entry.Id);

            lock (Sync)
            {
                if (activeId == entry.Id)
                {
                    throw new ModelException("下载还没停下，请稍后再删");
                }
                Errors.Remove(entry.Id);
                string dir = CurrentDirectory();
                DeleteFile(dir, entry.Model);

                bool runtimeInUse = false;
                foreach (ModelEntry other in Entries)
                {
                    if (other == entry || other.Runtime != entry.Runtime)
                    {
                        continue;
                    }
                    string otherModel = Path.Combine(dir, other.Model.Name);
                    if (File.Exists(otherModel) || File.Exists(otherModel + PartSuffix) ||
                        activeId == other.Id || Queue.Contains(other.Id))
                    {
                        runtimeInUse = true;
                    }
                }
                if (!runtimeInUse)
                {
                    DeleteFile(dir, entry.Runtime);
                }
            }
        }

        /// <summary>
        /// 把已下载和下了一半的文件移到新目录（null 表示移回默认目录），再改位置记录；中途失败会把已移动的移回去。
        /// 下载进行中不允许移动。返回 false 表示目标就是当前目录。
        /// </summary>
        internal static bool MoveTo(string targetDirectory)
        {
            lock (Sync)
            {
                if (activeId != null || Queue.Count > 0)
                {
                    throw new ModelException("请先暂停正在进行的下载，再更改模型目录");
                }

                string defaultDir = DefaultDirectory;
                string targetDir = targetDirectory;
                try
                {
                    targetDir = string.IsNullOrWhiteSpace(targetDirectory)
                        ? defaultDir
                        : ConfigStore.ValidateTarget(targetDirectory);
                    Directory.CreateDirectory(targetDir);
                }
                catch (ConfigException ex)
                {
                    throw new ModelException(ex.Message, ex);
                }
                catch (Exception ex)
                {
                    throw new ModelException("无法创建目录：" + targetDir + "（" + ex.Message + "）", ex);
                }

                string currentDir = CurrentDirectory();
                if (ConfigStore.SameDirectory(targetDir, currentDir))
                {
                    return false;
                }

                List<string[]> moved = new List<string[]>();
                try
                {
                    List<string> names = new List<string>(KnownFileNames());
                    names.AddRange(CustomModelStore.RelativeFiles(currentDir));
                    foreach (string name in names)
                    {
                        string source = Path.Combine(currentDir, name);
                        if (!File.Exists(source))
                        {
                            continue;
                        }
                        string target = Path.Combine(targetDir, name);
                        // 自定义模型在 custom 子目录里，目标目录可能还没有它。
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        if (File.Exists(target))
                        {
                            File.Delete(target);
                        }
                        File.Move(source, target);
                        moved.Add(new string[] { source, target });
                    }
                    ConfigStore.SaveCustomDirectory(
                        LocationFileName,
                        ConfigStore.SameDirectory(targetDir, defaultDir) ? null : targetDir);
                }
                catch (Exception ex)
                {
                    for (int index = moved.Count - 1; index >= 0; index--)
                    {
                        try
                        {
                            File.Move(moved[index][1], moved[index][0]);
                        }
                        catch
                        {
                            // 移回失败时文件留在新目录；位置记录没变，页面会显示需要重新下载。
                        }
                    }
                    throw new ModelException("移动模型文件失败：" + ex.Message, ex);
                }
                return true;
            }
        }

        internal static void OpenInExplorer()
        {
            string dir = CurrentDirectory();
            Directory.CreateDirectory(dir);
            Process.Start("explorer.exe", "\"" + dir + "\"");
        }

        /// <summary>页面请求 /models/文件名 时：只认清单里的文件，且必须已完整下载。返回完整路径与类型，否则 null。</summary>
        internal static string[] ResolveServedFile(string name)
        {
            string customPrefix = CustomModelStore.FolderName + "/";
            if (name.StartsWith(customPrefix, StringComparison.Ordinal))
            {
                string customPath = CustomModelStore.Resolve(name.Substring(customPrefix.Length));
                return customPath == null ? null : new string[] { customPath, "application/octet-stream" };
            }
            lock (Sync)
            {
                foreach (ModelEntry entry in Entries)
                {
                    foreach (ModelFile file in entry.Files)
                    {
                        if (!string.Equals(file.Name, name, StringComparison.Ordinal))
                        {
                            continue;
                        }
                        string path = Path.Combine(CurrentDirectory(), file.Name);
                        return IsComplete(path, file) ? new string[] { path, file.ContentType } : null;
                    }
                }
                return null;
            }
        }

        private static ModelEntry Find(string id)
        {
            foreach (ModelEntry entry in Entries)
            {
                if (string.Equals(entry.Id, id, StringComparison.Ordinal))
                {
                    return entry;
                }
            }
            throw new ModelException("没有这个模型：" + (id ?? string.Empty));
        }

        private static IEnumerable<string> KnownFileNames()
        {
            HashSet<string> names = new HashSet<string>();
            foreach (ModelEntry entry in Entries)
            {
                foreach (ModelFile file in entry.Files)
                {
                    if (names.Add(file.Name))
                    {
                        yield return file.Name;
                        yield return file.Name + PartSuffix;
                    }
                }
            }
        }

        private static bool IsComplete(string path, ModelFile file)
        {
            return File.Exists(path) && SafeLength(path) == file.Size;
        }

        private static long SafeLength(string path)
        {
            try
            {
                return new FileInfo(path).Length;
            }
            catch
            {
                return 0;
            }
        }

        private static void DeleteFile(string dir, ModelFile file)
        {
            string path = Path.Combine(dir, file.Name);
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
                if (File.Exists(path + PartSuffix))
                {
                    File.Delete(path + PartSuffix);
                }
            }
            catch (Exception ex)
            {
                throw new ModelException("删除模型文件失败：" + ex.Message, ex);
            }
        }

        private static void WaitUntilStopped(string id)
        {
            for (int attempt = 0; attempt < 100; attempt++)
            {
                lock (Sync)
                {
                    if (activeId != id)
                    {
                        return;
                    }
                }
                Idle.WaitOne(100);
            }
        }

        /// <summary>下载线程：依次处理队列，一个模型的运行库与模型文件都下完（或暂停、出错）再处理下一个。</summary>
        private static void Work()
        {
            for (;;)
            {
                ModelEntry entry;
                lock (Sync)
                {
                    if (Queue.Count == 0)
                    {
                        worker = null;
                        activeId = null;
                        Idle.Set();
                        return;
                    }
                    entry = Find(Queue[0]);
                    Queue.RemoveAt(0);
                    activeId = entry.Id;
                    activeVerifying = false;
                    cancelRequested = false;
                }

                try
                {
                    foreach (ModelFile file in entry.Files)
                    {
                        if (!DownloadFile(file))
                        {
                            break;
                        }
                    }
                }
                catch (Exception ex)
                {
                    lock (Sync)
                    {
                        Errors[entry.Id] = ex is ModelException ? ex.Message : "下载失败：" + ex.Message;
                    }
                }
                finally
                {
                    lock (Sync)
                    {
                        activeId = null;
                        activeVerifying = false;
                    }
                }
            }
        }

        /// <summary>下载一个文件；返回 false 表示被暂停。已完整存在时直接返回 true。</summary>
        private static bool DownloadFile(ModelFile file)
        {
            string dir = CurrentDirectory();
            Directory.CreateDirectory(dir);
            string final = Path.Combine(dir, file.Name);
            if (IsComplete(final, file))
            {
                return true;
            }
            string part = final + PartSuffix;
            long have = File.Exists(part) ? SafeLength(part) : 0;
            if (have > file.Size)
            {
                File.Delete(part);
                have = 0;
            }

            Exception lastError = null;
            foreach (string url in file.Urls)
            {
                if (have >= file.Size)
                {
                    break;
                }
                try
                {
                    have = Fetch(url, part, have, file.Size);
                }
                catch (OperationCanceledException)
                {
                    return false;
                }
                catch (Exception ex)
                {
                    // 换下一个地址接着下，已写入的部分保留。
                    lastError = ex;
                    have = File.Exists(part) ? SafeLength(part) : 0;
                }
                if (cancelRequested)
                {
                    return false;
                }
            }
            if (have < file.Size)
            {
                throw new ModelException(
                    "下载 " + file.Name + " 失败：" + (lastError != null ? lastError.Message : "所有地址都不可用"));
            }

            lock (Sync)
            {
                activeVerifying = true;
            }
            string hash = Sha256Of(part);
            if (!string.Equals(hash, file.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(part);
                throw new ModelException(file.Name + " 校验不通过，已删除下载的内容，请重新下载");
            }
            if (File.Exists(final))
            {
                File.Delete(final);
            }
            File.Move(part, final);
            lock (Sync)
            {
                activeVerifying = false;
            }
            return true;
        }

        /// <summary>从 url 续传到 part；手动跟随跳转，每一跳都带 Range（Hugging Face 的下载地址是一小时有效的签名链接）。</summary>
        private static long Fetch(string url, string part, long have, long size)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            string current = url;
            for (int hop = 0; hop <= MaxRedirects; hop++)
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(current);
                request.AllowAutoRedirect = false;
                request.UserAgent = "YisiImageTool";
                request.Timeout = 20000;
                request.ReadWriteTimeout = 30000;
                if (have > 0)
                {
                    request.AddRange(have);
                }

                using (HttpWebResponse response = GetResponse(request))
                {
                    int code = (int)response.StatusCode;
                    if (code >= 300 && code < 400)
                    {
                        string location = response.Headers["Location"];
                        if (string.IsNullOrEmpty(location))
                        {
                            throw new ModelException("下载地址跳转缺少目标");
                        }
                        current = new Uri(new Uri(current), location).ToString();
                        continue;
                    }
                    if (code == 416)
                    {
                        // 本地记录的长度和服务器对不上，从头下。
                        File.Delete(part);
                        have = 0;
                        continue;
                    }
                    if (code != 200 && code != 206)
                    {
                        throw new ModelException("服务器返回 " + code);
                    }
                    if (code == 200 && have > 0)
                    {
                        // 服务器不支持续传：从头写。
                        have = 0;
                    }
                    if (code == 206 && !RangeStartsAt(response.Headers["Content-Range"], have))
                    {
                        throw new ModelException("服务器返回的续传位置不对");
                    }

                    using (FileStream output = new FileStream(
                        part,
                        have > 0 ? FileMode.Append : FileMode.Create,
                        FileAccess.Write,
                        FileShare.Read))
                    using (Stream input = response.GetResponseStream())
                    {
                        byte[] buffer = new byte[81920];
                        int read;
                        while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            if (have + read > size)
                            {
                                throw new ModelException("下载的文件比预期大，已停止");
                            }
                            output.Write(buffer, 0, read);
                            have += read;
                            if (cancelRequested)
                            {
                                output.Flush();
                                throw new OperationCanceledException();
                            }
                        }
                    }
                    return have;
                }
            }
            throw new ModelException("下载地址跳转次数过多");
        }

        private static HttpWebResponse GetResponse(HttpWebRequest request)
        {
            try
            {
                return (HttpWebResponse)request.GetResponse();
            }
            catch (WebException ex)
            {
                HttpWebResponse response = ex.Response as HttpWebResponse;
                if (response != null)
                {
                    return response;
                }
                throw new ModelException("网络连接失败（" + ex.Status + "）", ex);
            }
        }

        private static bool RangeStartsAt(string contentRange, long start)
        {
            // 形如 "bytes 1000-2000/3000"
            if (string.IsNullOrEmpty(contentRange))
            {
                return false;
            }
            int space = contentRange.IndexOf(' ');
            int dash = contentRange.IndexOf('-');
            if (space < 0 || dash <= space)
            {
                return false;
            }
            long value;
            return long.TryParse(
                contentRange.Substring(space + 1, dash - space - 1),
                System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture,
                out value) && value == start;
        }

        internal static string Sha256Of(string path)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                byte[] digest = sha.ComputeHash(stream);
                StringBuilder builder = new StringBuilder(digest.Length * 2);
                foreach (byte value in digest)
                {
                    builder.Append(value.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
                }
                return builder.ToString();
            }
        }
    }
}
