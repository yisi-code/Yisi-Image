using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Yisi.ImageTool
{
    /// <summary>
    /// 用户自己导入的清晰化模型（ONNX）。文件复制到模型目录下的 custom 文件夹，
    /// 以「custom-SHA-256 前 12 位.onnx」保存，清单 custom-models.json 记名称、大小与 SHA-256。
    /// 页面通过 /models/custom/文件名 读取；只认清单里且大小一致的文件。
    /// 运行库与内置模型共用（模型目录里的 ort-wasm 文件）。
    /// </summary>
    internal static class CustomModelStore
    {
        internal const string FolderName = "custom";
        private const string ManifestName = "custom-models.json";
        private const long MaxModelBytes = 1024L * 1024 * 1024;
        private const int MaxNameLength = 60;

        private static readonly object Sync = new object();

        private sealed class CustomModel
        {
            public string Id { get; set; }
            public string Name { get; set; }
            public long Size { get; set; }
            public string Sha256 { get; set; }
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
                    Dictionary<string, object> item = new Dictionary<string, object>();
                    item["id"] = model.Id;
                    item["name"] = model.Name;
                    item["size"] = model.Size;
                    item["sha256"] = model.Sha256;
                    item["available"] = File.Exists(file) && new FileInfo(file).Length == model.Size;
                    item["modelUrl"] = "/models/" + FolderName + "/" + FileNameOf(model.Id);
                    items.Add(item);
                }
                return items;
            }
        }

        /// <summary>复制并登记一个 ONNX 文件；同一份文件（SHA-256 相同）重复导入时直接返回已有的编号。</summary>
        internal static string Import(string sourcePath)
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

            string sha = ModelStore.Sha256Of(sourcePath);
            string id = "custom-" + sha.Substring(0, 12);
            lock (Sync)
            {
                string modelsDir = ModelStore.CurrentDirectory();
                List<CustomModel> list = Load(modelsDir);
                string folder = FolderIn(modelsDir);
                string target = Path.Combine(folder, FileNameOf(id));
                CustomModel existing = list.Find(item => item.Id == id);
                if (existing != null && File.Exists(target) && new FileInfo(target).Length == size)
                {
                    return id;
                }

                Directory.CreateDirectory(folder);
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

                list.RemoveAll(item => item.Id == id);
                list.Add(new CustomModel
                {
                    Id = id,
                    Name = CleanName(Path.GetFileNameWithoutExtension(sourcePath)),
                    Size = size,
                    Sha256 = sha,
                    AddedAt = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
                });
                Save(modelsDir, list);
                return id;
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

        internal static void Delete(string id)
        {
            lock (Sync)
            {
                string modelsDir = ModelStore.CurrentDirectory();
                List<CustomModel> list = Load(modelsDir);
                if (list.RemoveAll(item => item.Id == id) == 0)
                {
                    throw new ModelException("没有这个自定义模型");
                }
                string file = Path.Combine(FolderIn(modelsDir), FileNameOf(id));
                try
                {
                    if (File.Exists(file))
                    {
                        File.Delete(file);
                    }
                }
                catch (Exception ex)
                {
                    throw new ModelException("删除模型文件失败：" + ex.Message, ex);
                }
                Save(modelsDir, list);
            }
        }

        /// <summary>/models/custom/文件名：清单里有、且文件大小一致时返回完整路径。</summary>
        internal static string Resolve(string fileName)
        {
            lock (Sync)
            {
                string modelsDir = ModelStore.CurrentDirectory();
                foreach (CustomModel model in Load(modelsDir))
                {
                    if (!string.Equals(FileNameOf(model.Id), fileName, StringComparison.Ordinal))
                    {
                        continue;
                    }
                    string path = Path.Combine(FolderIn(modelsDir), fileName);
                    return File.Exists(path) && new FileInfo(path).Length == model.Size ? path : null;
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
                }
            }
            names.Add(Path.Combine(FolderName, ManifestName));
            return names;
        }
    }
}
