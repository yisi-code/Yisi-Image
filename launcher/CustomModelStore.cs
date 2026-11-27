using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace Yisi.ImageTool
{
    /// <summary>
    /// 用户自己导入的 AI 模型（ONNX），用途是清晰化（sharpen）、局部修瑕（heal）、去除背景（matte）
    /// 或点选抠图（segment）。文件复制到模型目录下的 custom 文件夹，以「custom-SHA-256 前 12 位.onnx」保存，
    /// 清单 custom-models.json 记用途、名称、大小与 SHA-256（早期没有用途字段的条目按清晰化处理）。
    /// 抠图模型是一对文件（图像编码器 + 掩码解码器）：解码器另存为「编号.decoder.onnx」，
    /// 编号取两个文件 SHA-256 拼接后再算一次 SHA-256 的前 12 位。
    /// 页面通过 /models/custom/文件名 读取；只认清单里且大小一致的文件。
    /// 运行库与内置模型共用（模型目录里的 ort-wasm 文件）。
    /// </summary>
    internal static class CustomModelStore
    {
        internal const string FolderName = "custom";
        private const string ManifestName = "custom-models.json";
        private const long MaxModelBytes = 1024L * 1024 * 1024;
        private const int MaxNameLength = 60;
        internal const string KindSharpen = "sharpen";
        internal const string KindHeal = "heal";
        internal const string KindMatte = "matte";
        internal const string KindSegment = "segment";
        private static readonly Regex IdPattern = new Regex("^custom-[0-9a-f]{12}$");

        private static readonly object Sync = new object();

        private sealed class CustomModel
        {
            public string Id { get; set; }
            /// <summary>sharpen / heal；旧清单里为 null，按 sharpen 处理</summary>
            public string Kind { get; set; }
            public string Name { get; set; }
            public long Size { get; set; }
            public string Sha256 { get; set; }
            /// <summary>抠图模型的掩码解码器；其他用途为空</summary>
            public long DecoderSize { get; set; }
            public string DecoderSha256 { get; set; }
            public string AddedAt { get; set; }
        }

        private static string FolderIn(string modelsDir)
        {
            return Path.Combine(modelsDir, FolderName);
        }

        private static string FileNameOf(string id)
        {
            return id + ".onnx";
        }

        private static string DecoderFileNameOf(string id)
        {
            return id + ".decoder.onnx";
        }

        private static string KindOf(CustomModel model)
        {
            return model.Kind == KindHeal || model.Kind == KindMatte || model.Kind == KindSegment
                ? model.Kind
                : KindSharpen;
        }

        internal static string PurposeText(string kind)
        {
            switch (kind)
            {
                case KindHeal:
                    return "局部修瑕";
                case KindMatte:
                    return "去除背景";
                case KindSegment:
                    return "抠图";
                default:
                    return "清晰化";
            }
        }

        /// <summary>页面传来的用途；缺省为清晰化（兼容只会导入清晰化模型的旧页面）。</summary>
        internal static string NormalizeKind(string kind)
        {
            if (string.IsNullOrEmpty(kind) || kind == KindSharpen)
            {
                return KindSharpen;
            }
            if (kind == KindHeal || kind == KindMatte || kind == KindSegment)
            {
                return kind;
            }
            throw new ModelException("模型用途无效");
        }

        private static List<CustomModel> Load(string modelsDir)
        {
            string path = Path.Combine(FolderIn(modelsDir), ManifestName);
            if (!File.Exists(path))
            {
                return new List<CustomModel>();
            }
            try
            {
                List<CustomModel> list = new JavaScriptSerializer().Deserialize<List<CustomModel>>(
                    File.ReadAllText(path, Encoding.UTF8));
                return list ?? new List<CustomModel>();
            }
            catch
            {
                // 清单损坏时当作没有导入过；文件留在原处，用户可重新导入。
                return new List<CustomModel>();
            }
        }

        private static void Save(string modelsDir, List<CustomModel> list)
        {
            string folder = FolderIn(modelsDir);
            Directory.CreateDirectory(folder);
            string path = Path.Combine(folder, ManifestName);
            string temp = path + ".tmp";
            File.WriteAllText(temp, new JavaScriptSerializer().Serialize(list), new UTF8Encoding(false));
            if (File.Exists(path))
            {
                File.Delete(path);
            }
            File.Move(temp, path);
        }

        private static string CleanName(string name)
        {
            string trimmed = (name ?? string.Empty).Trim();
            if (trimmed.Length == 0)
            {
                throw new ModelException("名称不能为空");
            }
            return trimmed.Length > MaxNameLength ? trimmed.Substring(0, MaxNameLength) : trimmed;
        }

        /// <summary>GET /api/models 里的 custom 数组。</summary>
        internal static List<object> Describe()
        {
            lock (Sync)
            {
                string modelsDir = ModelStore.CurrentDirectory();
                List<object> items = new List<object>();
                foreach (CustomModel model in Load(modelsDir))
                {
                    string file = Path.Combine(FolderIn(modelsDir), FileNameOf(model.Id));
                    bool available = File.Exists(file) && new FileInfo(file).Length == model.Size;
                    Dictionary<string, object> item = new Dictionary<string, object>();
                    item["id"] = model.Id;
                    item["kind"] = KindOf(model);
                    item["name"] = model.Name;
                    item["size"] = model.Size + model.DecoderSize;
                    item["sha256"] = model.Sha256;
                    item["modelUrl"] = "/models/" + FolderName + "/" + FileNameOf(model.Id);
                    if (KindOf(model) == KindSegment)
                    {
                        string decoder = Path.Combine(FolderIn(modelsDir), DecoderFileNameOf(model.Id));
                        available = available && File.Exists(decoder) && new FileInfo(decoder).Length == model.DecoderSize;
                        item["decoderUrl"] = "/models/" + FolderName + "/" + DecoderFileNameOf(model.Id);
                    }
                    item["available"] = available;
                    items.Add(item);
                }
                return items;
            }
        }

        /// <summary>
        /// 复制并登记一个 ONNX 文件；同一份文件（SHA-256 相同）以同一用途重复导入时直接返回已有的编号，
        /// 已作为另一用途导入过时报错（两个用途共用一个文件名，不能各存一份）。
        /// </summary>
        internal static string Import(string sourcePath, string kind)
        {
            if (kind == KindSegment)
            {
                throw new ModelException("抠图模型要同时导入图像编码器和掩码解码器");
            }
            long size = CheckSource(sourcePath);
            string sha = ModelStore.Sha256Of(sourcePath);
            string id = "custom-" + sha.Substring(0, 12);
            lock (Sync)
            {
                string modelsDir = ModelStore.CurrentDirectory();
                List<CustomModel> list = Load(modelsDir);
                string folder = FolderIn(modelsDir);
                string target = Path.Combine(folder, FileNameOf(id));
                CustomModel existing = FindForKind(list, id, kind);
                if (existing != null && File.Exists(target) && new FileInfo(target).Length == size)
                {
                    return id;
                }

                CopyInto(sourcePath, target);
                list.RemoveAll(item => item.Id == id);
                list.Add(new CustomModel
                {
                    Id = id,
                    Kind = kind,
                    Name = CleanName(Path.GetFileNameWithoutExtension(sourcePath)),
                    Size = size,
                    Sha256 = sha,
                    AddedAt = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
                });
                Save(modelsDir, list);
                return id;
            }
        }

        /// <summary>导入一对抠图模型文件（图像编码器 + 掩码解码器）；同一对重复导入时返回已有的编号。</summary>
        internal static string ImportPair(string encoderPath, string decoderPath)
        {
            long encoderSize = CheckSource(encoderPath);
            long decoderSize = CheckSource(decoderPath);
            string encoderSha = ModelStore.Sha256Of(encoderPath);
            string decoderSha = ModelStore.Sha256Of(decoderPath);
            if (string.Equals(encoderSha, decoderSha, StringComparison.OrdinalIgnoreCase))
            {
                throw new ModelException("两次选的是同一个文件；请先选图像编码器，再选掩码解码器");
            }
            string id = "custom-" + Sha256OfText(encoderSha + decoderSha).Substring(0, 12);
            lock (Sync)
            {
                string modelsDir = ModelStore.CurrentDirectory();
                List<CustomModel> list = Load(modelsDir);
                string folder = FolderIn(modelsDir);
                string encoderTarget = Path.Combine(folder, FileNameOf(id));
                string decoderTarget = Path.Combine(folder, DecoderFileNameOf(id));
                CustomModel existing = FindForKind(list, id, KindSegment);
                if (existing != null && File.Exists(encoderTarget) && new FileInfo(encoderTarget).Length == encoderSize &&
                    File.Exists(decoderTarget) && new FileInfo(decoderTarget).Length == decoderSize)
                {
                    return id;
                }

                CopyInto(encoderPath, encoderTarget);
                CopyInto(decoderPath, decoderTarget);
                list.RemoveAll(item => item.Id == id);
                list.Add(new CustomModel
                {
                    Id = id,
                    Kind = KindSegment,
                    Name = CleanName(Path.GetFileNameWithoutExtension(encoderPath)),
                    Size = encoderSize,
                    Sha256 = encoderSha,
                    DecoderSize = decoderSize,
                    DecoderSha256 = decoderSha,
                    AddedAt = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
                });
                Save(modelsDir, list);
                return id;
            }
        }

        /// <summary>所选文件存在、是 .onnx、大小合适；返回字节数。</summary>
        private static long CheckSource(string sourcePath)
        {
            if (string.IsNullOrWhiteSpace(sourcePath) || !File.Exists(sourcePath))
            {
                throw new ModelException("找不到所选文件");
            }
            if (!string.Equals(Path.GetExtension(sourcePath), ".onnx", StringComparison.OrdinalIgnoreCase))
            {
                throw new ModelException("只能导入 .onnx 格式的模型");
            }
            long size = new FileInfo(sourcePath).Length;
            if (size <= 0 || size > MaxModelBytes)
            {
                throw new ModelException("模型文件大小不合适（需大于 0、不超过 1 GB）");
            }
            return size;
        }

        /// <summary>清单里同编号的条目；已作为另一用途导入时报错（同一编号只能存一份文件）。</summary>
        private static CustomModel FindForKind(List<CustomModel> list, string id, string kind)
        {
            CustomModel existing = list.Find(item => item.Id == id);
            if (existing != null && KindOf(existing) != kind)
            {
                throw new ModelException(
                    "这个文件已经作为" + PurposeText(KindOf(existing)) + "模型导入过（「" + existing.Name +
                    "」），要换用途请先在那里删除");
            }
            return existing;
        }

        /// <summary>先复制成 .part 再改名，复制失败时不留下半个文件。</summary>
        private static void CopyInto(string sourcePath, string target)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            string part = target + ".part";
            try
            {
                File.Copy(sourcePath, part, true);
                if (File.Exists(target))
                {
                    File.Delete(target);
                }
                File.Move(part, target);
            }
            catch (Exception ex)
            {
                try
                {
                    if (File.Exists(part))
                    {
                        File.Delete(part);
                    }
                }
                catch
                {
                    // 清理失败不掩盖真正的错误。
                }
                throw new ModelException("复制模型文件失败：" + ex.Message, ex);
            }
        }

        private static string Sha256OfText(string text)
        {
            using (System.Security.Cryptography.SHA256 sha = System.Security.Cryptography.SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(text.ToLowerInvariant()));
                StringBuilder builder = new StringBuilder(hash.Length * 2);
                foreach (byte value in hash)
                {
                    builder.Append(value.ToString("x2"));
                }
                return builder.ToString();
            }
        }

        internal static void Rename(string id, string name)
        {
            lock (Sync)
            {
                string modelsDir = ModelStore.CurrentDirectory();
                List<CustomModel> list = Load(modelsDir);
                CustomModel model = list.Find(item => item.Id == id);
                if (model == null)
                {
                    throw new ModelException("没有这个自定义模型");
                }
                model.Name = CleanName(name);
                Save(modelsDir, list);
            }
        }

        /// <summary>
        /// 删除文件并从清单去掉。清单里已经没有它时当作已删除（只清理可能残留的文件），不报错：
        /// 上一次删除在服务端已完成、但页面没收到回应时，再点一次删除应当得到最新列表。
        /// </summary>
        internal static void Delete(string id)
        {
            if (!IsCustomId(id))
            {
                throw new ModelException("自定义模型编号无效");
            }
            lock (Sync)
            {
                string modelsDir = ModelStore.CurrentDirectory();
                List<CustomModel> list = Load(modelsDir);
                bool listed = list.RemoveAll(item => item.Id == id) > 0;
                try
                {
                    foreach (string name in new string[] { FileNameOf(id), DecoderFileNameOf(id) })
                    {
                        string file = Path.Combine(FolderIn(modelsDir), name);
                        if (File.Exists(file))
                        {
                            File.Delete(file);
                        }
                    }
                }
                catch (Exception ex)
                {
                    throw new ModelException("删除模型文件失败：" + ex.Message, ex);
                }
                if (listed)
                {
                    Save(modelsDir, list);
                }
            }
        }

        internal static bool IsCustomId(string id)
        {
            return id != null && IdPattern.IsMatch(id);
        }

        /// <summary>自定义模型文件的完整路径；清单里没有或文件不完整时为 null。</summary>
        internal static string PathOf(string id)
        {
            return IsCustomId(id) ? Resolve(FileNameOf(id)) : null;
        }

        /// <summary>/models/custom/文件名：清单里有、且文件大小一致时返回完整路径。</summary>
        internal static string Resolve(string fileName)
        {
            lock (Sync)
            {
                string modelsDir = ModelStore.CurrentDirectory();
                foreach (CustomModel model in Load(modelsDir))
                {
                    long size;
                    if (string.Equals(FileNameOf(model.Id), fileName, StringComparison.Ordinal))
                    {
                        size = model.Size;
                    }
                    else if (KindOf(model) == KindSegment &&
                        string.Equals(DecoderFileNameOf(model.Id), fileName, StringComparison.Ordinal))
                    {
                        size = model.DecoderSize;
                    }
                    else
                    {
                        continue;
                    }
                    string path = Path.Combine(FolderIn(modelsDir), fileName);
                    return File.Exists(path) && new FileInfo(path).Length == size ? path : null;
                }
                return null;
            }
        }

        /// <summary>换模型目录时要一起移走的文件（相对模型目录的路径）。</summary>
        internal static IEnumerable<string> RelativeFiles(string modelsDir)
        {
            List<string> names = new List<string>();
            lock (Sync)
            {
                foreach (CustomModel model in Load(modelsDir))
                {
                    names.Add(Path.Combine(FolderName, FileNameOf(model.Id)));
                    if (KindOf(model) == KindSegment)
                    {
                        names.Add(Path.Combine(FolderName, DecoderFileNameOf(model.Id)));
                    }
                }
            }
            names.Add(Path.Combine(FolderName, ManifestName));
            return names;
        }
    }
}
