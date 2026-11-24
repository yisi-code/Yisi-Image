using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("Yisi 图像工具")]
[assembly: AssemblyDescription("本地多图拼接工具")]
[assembly: AssemblyProduct("Yisi 图像工具")]
[assembly: AssemblyCompany("Yisi")]
[assembly: AssemblyVersion("0.12.0.0")]
[assembly: AssemblyFileVersion("0.12.0.0")]

namespace Yisi.ImageTool
{
    internal static class Program
    {
        internal const string AppUrl = "http://127.0.0.1:47831/";
        private const int Port = 47831;
        private const string MutexName = @"Local\YisiImageTool.SingleInstance";

        [STAThread]
        private static void Main(string[] args)
        {
            bool openBrowser = !HasArgument(args, "--no-browser");
            bool autoUpdate = !HasArgument(args, "--no-update");
            bool devUpdate = HasArgument(args, "--dev-update");
            if (devUpdate)
            {
                UpdateService.UseCustomSource(Environment.GetEnvironmentVariable("YISI_UPDATE_BASE"));
            }

            bool createdNew;
            using (Mutex mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    // 第二次双击时不再启动第二个服务，直接打开已经运行的页面。
                    if (!openBrowser)
                    {
                        return;
                    }

                    if (WaitUntilReady(3000))
                    {
                        OpenBrowser();
                    }
                    else
                    {
                        MessageBox.Show(
                            "程序正在启动，请稍后再双击一次。\n\n如果一直无法打开，请右键托盘图标选择「退出」后重试。",
                            "Yisi 图像工具",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Information);
                    }
                    return;
                }

                UpdateInstaller.CleanupOldFiles();
                if (HasArgument(args, "--dev-update-selftest"))
                {
                    RunUpdateSelfTest();
                    return;
                }

                try
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
                    {
                        ShowError("运行异常：\n" + e.Exception.Message);
                    };

                    Application.Run(new TrayContext(openBrowser, autoUpdate));
                }
                catch (Exception ex)
                {
                    ShowError(
                        "启动失败：\n" + ex.Message +
                        "\n\n请确认 47831 端口没有被其他程序占用，然后重试。");
                }
                finally
                {
                    try
                    {
                        mutex.ReleaseMutex();
                    }
                    catch
                    {
                        // 进程退出阶段，互斥量可能已经被系统回收。
                    }
                }
            }
        }

        internal static void OpenBrowser()
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo(AppUrl);
                info.UseShellExecute = true;
                Process.Start(info);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "无法自动打开浏览器。\n请手动访问：\n" + AppUrl +
                    "\n\n" + ex.Message,
                    "Yisi 图像工具",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
        }

        internal static void ShowError(string message)
        {
            MessageBox.Show(message, "Yisi 图像工具", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        /// <summary>
        /// 仅用于自动化验证更新链路：不显示界面，直接检查、下载、校验并交给替换脚本。
        /// 必须在 --dev-update 且设置 YISI_UPDATE_BASE 时使用。
        /// </summary>
        private static void RunUpdateSelfTest()
        {
            string log = Path.Combine(Path.GetTempPath(), "YisiImageTool-update-selftest.log");
            StringBuilder lines = new StringBuilder();
            try
            {
                lines.AppendLine("CURRENT " + UpdateService.FormatVersion(UpdateService.CurrentVersion()));
                UpdateInfo info = UpdateService.CheckForUpdate();
                if (info == null)
                {
                    lines.AppendLine("NO_UPDATE");
                }
                else
                {
                    lines.AppendLine("FOUND " + info.VersionText + " " + info.Source);
                    string path = UpdateService.Download(
                        info,
                        delegate(int percent, long received, long total)
                        {
                            lines.AppendLine("PROGRESS " + percent + " " + received + "/" + total);
                        },
                        delegate { return false; });
                    lines.AppendLine("DOWNLOADED " + path);
                    UpdateInstaller.Launch(path);
                    lines.AppendLine("LAUNCHED");
                }
            }
            catch (Exception ex)
            {
                lines.AppendLine("ERROR " + ex.Message);
            }

            try
            {
                File.WriteAllText(log, lines.ToString(), new UTF8Encoding(false));
            }
            catch
            {
                // 自测日志写不了时不影响进程状态。
            }
        }

        private static bool HasArgument(string[] args, string value)
        {
            if (args == null)
            {
                return false;
            }

            foreach (string arg in args)
            {
                if (string.Equals(arg, value, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool WaitUntilReady(int timeoutMilliseconds)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    using (TcpClient client = new TcpClient())
                    {
                        client.Connect(IPAddress.Loopback, Port);
                        return true;
                    }
                }
                catch (SocketException)
                {
                    Thread.Sleep(100);
                }
                catch (ObjectDisposedException)
                {
                    Thread.Sleep(100);
                }
            }

            return false;
        }
    }

    internal sealed class TrayContext : ApplicationContext
    {
        private readonly NotifyIcon trayIcon;
        private readonly ContextMenuStrip trayMenu;
        private readonly StaticServer server;
        private readonly Icon appIcon;
        private readonly SynchronizationContext uiContext;
        private readonly ToolStripMenuItem updateItem;
        private readonly System.Windows.Forms.Timer updateTimer;
        private bool isCheckingUpdate;
        private bool isPickingFolder;
        private bool isCleanedUp;

        public TrayContext(bool openBrowser, bool autoUpdate)
        {
            uiContext = SynchronizationContext.Current;
            if (uiContext == null)
            {
                uiContext = new WindowsFormsSynchronizationContext();
            }
            server = new StaticServer(Program.AppUrl);
            server.Start();

            appIcon = LoadAppIcon();

            ToolStripMenuItem openItem = new ToolStripMenuItem("打开界面");
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            openItem.Click += delegate { Program.OpenBrowser(); };

            updateItem = new ToolStripMenuItem("检查更新");
            updateItem.Click += delegate { CheckForUpdates(true); };

            // 关于页只能发起检查；下载、校验和替换由启动器负责。
            server.CheckUpdateRequested = delegate
            {
                uiContext.Post(delegate { CheckForUpdates(true); }, null);
            };

            // 设置页「更改目录」：HTTP 线程在这里等待用户在系统窗口里选完目录。
            server.PickFolderRequested = PickFolderOnUiThread;
            // 设置页「导入模型…」：同样在 UI 线程弹出系统「打开文件」窗口。
            server.PickFileRequested = PickModelFileOnUiThread;

            ToolStripMenuItem exitItem = new ToolStripMenuItem("退出");
            exitItem.Click += delegate { ExitApplication(); };

            trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add(openItem);
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add(updateItem);
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add(exitItem);

            trayIcon = new NotifyIcon();
            trayIcon.Icon = appIcon;
            trayIcon.Text = "Yisi 图像工具（双击打开）";
            trayIcon.ContextMenuStrip = trayMenu;
            trayIcon.DoubleClick += delegate { Program.OpenBrowser(); };
            trayIcon.Visible = true;

            updateTimer = new System.Windows.Forms.Timer();
            updateTimer.Interval = 3000;
            updateTimer.Tick += delegate
            {
                updateTimer.Stop();
                if (autoUpdate && UpdateSettings.ShouldAutoCheck())
                {
                    CheckForUpdates(false);
                }
            };
            updateTimer.Start();

            if (openBrowser)
            {
                trayIcon.ShowBalloonTip(
                    2500,
                    "Yisi 图像工具已启动",
                    "已在浏览器打开；关闭浏览器后可双击托盘图标重新打开。",
                    ToolTipIcon.Info);
                Program.OpenBrowser();
            }
        }

        private static Icon LoadAppIcon()
        {
            try
            {
                Icon icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (icon != null)
                {
                    return icon;
                }
            }
            catch
            {
                // 取不到 exe 图标时使用系统图标，不影响功能。
            }

            return (Icon)SystemIcons.Application.Clone();
        }

        private string PickFolderOnUiThread(string initialDirectory)
        {
            string selected = null;
            Exception failure = null;
            uiContext.Send(delegate
            {
                if (isPickingFolder)
                {
                    failure = new ConfigException("选择目录窗口已经打开，请先完成或取消");
                    return;
                }

                isPickingFolder = true;
                try
                {
                    selected = FolderPicker.Pick("选择配置文件存放目录", initialDirectory);
                }
                catch (Exception ex)
                {
                    failure = ex;
                }
                finally
                {
                    isPickingFolder = false;
                }
            }, null);

            if (failure != null)
            {
                throw failure is ConfigException
                    ? failure
                    : new ConfigException("无法打开选择目录窗口：" + failure.Message, failure);
            }
            return selected;
        }

        private string PickModelFileOnUiThread(string initialDirectory)
        {
            string selected = null;
            Exception failure = null;
            uiContext.Send(delegate
            {
                if (isPickingFolder)
                {
                    failure = new ModelException("选择窗口已经打开，请先完成或取消");
                    return;
                }

                isPickingFolder = true;
                try
                {
                    selected = FolderPicker.PickFile(
                        "选择要导入的 ONNX 清晰化模型",
                        "ONNX 模型 (*.onnx)|*.onnx",
                        initialDirectory);
                }
                catch (Exception ex)
                {
                    failure = ex;
                }
                finally
                {
                    isPickingFolder = false;
                }
            }, null);

            if (failure != null)
            {
                throw failure is ModelException
                    ? failure
                    : new ModelException("无法打开选择文件窗口：" + failure.Message, failure);
            }
            return selected;
        }

        private void CheckForUpdates(bool manual)
        {
            if (isCheckingUpdate)
            {
                return;
            }

            isCheckingUpdate = true;
            updateItem.Enabled = false;
            updateItem.Text = "正在检查更新…";

            ThreadPool.QueueUserWorkItem(delegate
            {
                UpdateInfo info = null;
                string error = null;
                try
                {
                    info = UpdateService.CheckForUpdate();
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                }

                uiContext.Post(delegate { FinishUpdateCheck(manual, info, error); }, null);
            });
        }

        private void FinishUpdateCheck(bool manual, UpdateInfo info, string error)
        {
            isCheckingUpdate = false;
            updateItem.Enabled = true;
            updateItem.Text = "检查更新";

            if (!string.IsNullOrWhiteSpace(error))
            {
                if (manual)
                {
                    Program.ShowError("检查更新失败：\n" + error + "\n\n请检查网络后重试。");
                }
                return;
            }

            UpdateSettings.MarkChecked();
            if (info == null)
            {
                if (manual)
                {
                    MessageBox.Show(
                        "当前已是最新版本 v" +
                        UpdateService.FormatVersion(UpdateService.CurrentVersion()) + "。",
                        "Yisi 图像工具",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                }
                return;
            }

            if (!manual &&
                string.Equals(
                    UpdateSettings.PromptedVersion(),
                    info.VersionText,
                    StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            UpdateSettings.MarkPrompted(info.VersionText);
            using (UpdateForm form = new UpdateForm(info, UpdateService.CurrentVersion(), appIcon))
            {
                form.ShowDialog();
                if (!form.InstallRequested || string.IsNullOrWhiteSpace(form.DownloadedPath))
                {
                    return;
                }

                try
                {
                    UpdateInstaller.Launch(form.DownloadedPath);
                    Cleanup();
                    ExitThread();
                }
                catch (Exception ex)
                {
                    Program.ShowError(
                        "无法启动自动安装：\n" + ex.Message +
                        "\n\n程序仍可继续使用，请稍后到发布页手动下载。");
                }
            }
        }

        private void ExitApplication()
        {
            Cleanup();
            ExitThread();
        }

        private void Cleanup()
        {
            if (isCleanedUp)
            {
                return;
            }

            isCleanedUp = true;
            updateTimer.Stop();
            updateTimer.Dispose();
            trayIcon.Visible = false;
            trayIcon.Dispose();
            trayMenu.Dispose();
            server.Stop();
            appIcon.Dispose();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                Cleanup();
            }

            base.Dispose(disposing);
        }
    }

    internal sealed class StaticServer
    {
        private readonly int port;
        private readonly Dictionary<string, byte[]> assets;
        private TcpListener listener;
        private volatile bool running;

        /// <summary>
        /// 关于页点「检查更新」时由本地 HTTP 线程转回 WinForms UI 线程。
        /// 页面本身没有权限替换 EXE，实际下载与安装仍由更新窗口完成。
        /// </summary>
        internal Action CheckUpdateRequested { get; set; }

        /// <summary>
        /// 设置页请求选择配置目录时调用，参数是当前目录；返回选中的目录，取消时返回 null。
        /// 由托盘上下文转到 UI 线程弹出系统窗口。
        /// </summary>
        internal Func<string, string> PickFolderRequested { get; set; }

        /// <summary>设置页请求导入模型文件时调用，参数是初始目录；返回选中的文件，取消时返回 null。</summary>
        internal Func<string, string> PickFileRequested { get; set; }

        public StaticServer(string url)
        {
            Uri uri = new Uri(url);
            port = uri.Port;
            assets = LoadAssets();
        }

        public void Start()
        {
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            running = true;

            Thread acceptThread = new Thread(AcceptLoop);
            acceptThread.IsBackground = true;
            acceptThread.Name = "Yisi static server";
            acceptThread.Start();
        }

        public void Stop()
        {
            running = false;
            if (listener != null)
            {
                try
                {
                    listener.Stop();
                }
                catch
                {
                    // 关闭阶段忽略监听器已停止等异常。
                }
            }
        }

        private void AcceptLoop()
        {
            while (running)
            {
                try
                {
                    TcpClient client = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(HandleClient, client);
                }
                catch (ObjectDisposedException)
                {
                    break;
                }
                catch (InvalidOperationException)
                {
                    break;
                }
                catch (SocketException)
                {
                    if (!running)
                    {
                        break;
                    }

                    Thread.Sleep(50);
                }
                catch
                {
                    if (running)
                    {
                        running = false;
                    }
                    break;
                }
            }
        }

        private void HandleClient(object state)
        {
            using (TcpClient client = (TcpClient)state)
            {
                try
                {
                    client.ReceiveTimeout = 5000;
                    using (NetworkStream stream = client.GetStream())
                    {
                        HttpRequestData request = ReadRequest(stream);
                        if (request == null)
                        {
                            return;
                        }

                        string[] lines = request.Head.Split(new string[] { "\r\n" }, StringSplitOptions.None);
                        string[] parts = lines[0].Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                        if (parts.Length < 2)
                        {
                            return;
                        }

                        string method = parts[0].ToUpperInvariant();
                        if (method != "GET" && method != "HEAD" && method != "POST")
                        {
                            WriteResponse(
                                stream,
                                "405 Method Not Allowed",
                                "text/plain; charset=utf-8",
                                Encoding.UTF8.GetBytes("Method Not Allowed"),
                                false);
                            return;
                        }

                        string target = parts[1];
                        int queryIndex = target.IndexOf('?');
                        if (queryIndex >= 0)
                        {
                            target = target.Substring(0, queryIndex);
                        }

                        string path;
                        try
                        {
                            path = Uri.UnescapeDataString(target);
                        }
                        catch
                        {
                            path = target;
                        }

                        if (path == "/api/update/check")
                        {
                            if (method != "POST" ||
                                request.Head.IndexOf(
                                    "X-Yisi-Update: 1",
                                    StringComparison.OrdinalIgnoreCase) < 0)
                            {
                                WriteResponse(
                                    stream,
                                    "403 Forbidden",
                                    "text/plain; charset=utf-8",
                                    Encoding.UTF8.GetBytes("Forbidden"),
                                    false);
                                return;
                            }

                            Action callback = CheckUpdateRequested;
                            if (callback == null)
                            {
                                WriteResponse(
                                    stream,
                                    "503 Service Unavailable",
                                    "text/plain; charset=utf-8",
                                    Encoding.UTF8.GetBytes("Updater unavailable"),
                                    false);
                                return;
                            }

                            callback();
                            WriteResponse(
                                stream,
                                "202 Accepted",
                                "application/json; charset=utf-8",
                                Encoding.UTF8.GetBytes("{\"ok\":true}"),
                                false);
                            return;
                        }

                        if (path == "/api/config" ||
                            path.StartsWith("/api/config/", StringComparison.Ordinal))
                        {
                            HandleConfigRequest(stream, method, path, request);
                            return;
                        }

                        if (path == "/api/models" ||
                            path.StartsWith("/api/models/", StringComparison.Ordinal))
                        {
                            HandleModelRequest(stream, method, path, request);
                            return;
                        }

                        if (path.StartsWith("/models/", StringComparison.Ordinal))
                        {
                            HandleModelFile(stream, method, path, request);
                            return;
                        }

                        if (method == "POST")
                        {
                            WriteResponse(
                                stream,
                                "405 Method Not Allowed",
                                "text/plain; charset=utf-8",
                                Encoding.UTF8.GetBytes("Method Not Allowed"),
                                false);
                            return;
                        }

                        if (string.IsNullOrEmpty(path) || path == "/")
                        {
                            path = "/index.html";
                        }

                        if (path == "/health")
                        {
                            WriteResponse(
                                stream,
                                "200 OK",
                                "text/plain; charset=utf-8",
                                Encoding.UTF8.GetBytes("ok"),
                                method == "HEAD");
                            return;
                        }

                        byte[] body;
                        string key = path.TrimStart('/');
                        if (!assets.TryGetValue(key, out body))
                        {
                            WriteResponse(
                                stream,
                                "404 Not Found",
                                "text/plain; charset=utf-8",
                                Encoding.UTF8.GetBytes("Not Found"),
                                method == "HEAD");
                            return;
                        }

                        WriteResponse(
                            stream,
                            "200 OK",
                            GetContentType(key),
                            body,
                            method == "HEAD");
                    }
                }
                catch (IOException)
                {
                    // 浏览器关闭连接或请求超时，不需要提示。
                }
                catch (SocketException)
                {
                    // 浏览器取消请求时忽略。
                }
                catch (ObjectDisposedException)
                {
                    // 应用退出时忽略。
                }
            }
        }

        /// <summary>
        /// /api/config 系列：读写配置文件、选择与移动配置目录、打开所在目录。
        /// 只接受带 X-Yisi-Config 头、Host/Origin 为本机地址的请求：跨站页面带自定义头会先发预检，
        /// 本服务不响应预检；校验 Host 可挡住 DNS 重绑定。
        /// </summary>
        private void HandleConfigRequest(
            NetworkStream stream,
            string method,
            string path,
            HttpRequestData request)
        {
            string status = "200 OK";
            string json;
            try
            {
                if (!IsTrustedConfigRequest(request.Head))
                {
                    status = "403 Forbidden";
                    json = ErrorJson("Forbidden");
                }
                else if (path == "/api/config" && method == "GET")
                {
                    json = ConfigStore.BuildSnapshotJson();
                }
                else if (method != "POST")
                {
                    status = "405 Method Not Allowed";
                    json = ErrorJson("Method Not Allowed");
                }
                else if (request.IsBodyTooLarge)
                {
                    status = "413 Payload Too Large";
                    json = ErrorJson("设置内容过大");
                }
                else if (path == "/api/config")
                {
                    ConfigStore.WriteSettingsJson(Encoding.UTF8.GetString(request.Body));
                    json = "{\"ok\":true}";
                }
                else if (path == "/api/config/pick-dir")
                {
                    Func<string, string> picker = PickFolderRequested;
                    if (picker == null)
                    {
                        status = "503 Service Unavailable";
                        json = ErrorJson("选择目录功能不可用");
                    }
                    else
                    {
                        string selected = picker(ConfigStore.CurrentDirectory());
                        json = selected == null
                            ? "{\"ok\":true,\"canceled\":true}"
                            : "{\"ok\":true,\"dir\":" + new JavaScriptSerializer().Serialize(selected) + "}";
                    }
                }
                else if (path == "/api/config/location")
                {
                    bool moved = ConfigStore.MoveTo(ReadDirectoryField(request.Body));
                    json = "{\"ok\":true,\"moved\":" + (moved ? "true" : "false") +
                        ",\"location\":" + ConfigStore.DescribeJson() + "}";
                }
                else if (path == "/api/config/open-dir")
                {
                    ConfigStore.OpenInExplorer();
                    json = "{\"ok\":true}";
                }
                else
                {
                    status = "404 Not Found";
                    json = ErrorJson("Not Found");
                }
            }
            catch (Exception ex)
            {
                status = "500 Internal Server Error";
                json = ErrorJson(ex.Message);
            }

            WriteResponse(
                stream,
                status,
                "application/json; charset=utf-8",
                Encoding.UTF8.GetBytes(json),
                false);
        }

        /// <summary>
        /// /api/models 系列：AI 修瑕模型的状态、下载 / 暂停 / 删除、选择与移动模型目录、打开目录。
        /// 与配置接口同样只接受带 X-Yisi-Config 头的本机请求。
        /// </summary>
        private void HandleModelRequest(
            NetworkStream stream,
            string method,
            string path,
            HttpRequestData request)
        {
            string status = "200 OK";
            string json;
            try
            {
                if (!IsTrustedConfigRequest(request.Head))
                {
                    status = "403 Forbidden";
                    json = ErrorJson("Forbidden");
                }
                else if (path == "/api/models" && method == "GET")
                {
                    json = ModelStore.DescribeJson();
                }
                else if (method != "POST")
                {
                    status = "405 Method Not Allowed";
                    json = ErrorJson("Method Not Allowed");
                }
                else if (request.IsBodyTooLarge)
                {
                    status = "413 Payload Too Large";
                    json = ErrorJson("请求内容过大");
                }
                else if (path == "/api/models/download")
                {
                    ModelStore.Download(ReadStringField(request.Body, "id"));
                    json = ModelStore.DescribeJson();
                }
                else if (path == "/api/models/pause")
                {
                    ModelStore.Pause(ReadStringField(request.Body, "id"));
                    json = ModelStore.DescribeJson();
                }
                else if (path == "/api/models/delete")
                {
                    ModelStore.Delete(ReadStringField(request.Body, "id"));
                    json = ModelStore.DescribeJson();
                }
                else if (path == "/api/models/pick-dir")
                {
                    Func<string, string> picker = PickFolderRequested;
                    if (picker == null)
                    {
                        status = "503 Service Unavailable";
                        json = ErrorJson("选择目录功能不可用");
                    }
                    else
                    {
                        string selected = picker(ModelStore.CurrentDirectory());
                        json = selected == null
                            ? "{\"ok\":true,\"canceled\":true}"
                            : "{\"ok\":true,\"dir\":" + new JavaScriptSerializer().Serialize(selected) + "}";
                    }
                }
                else if (path == "/api/models/location")
                {
                    bool moved = ModelStore.MoveTo(ReadDirectoryField(request.Body));
                    json = "{\"moved\":" + (moved ? "true" : "false") + "," + ModelStore.DescribeJson().Substring(1);
                }
                else if (path == "/api/models/open-dir")
                {
                    ModelStore.OpenInExplorer();
                    json = "{\"ok\":true}";
                }
                else if (path == "/api/models/reveal")
                {
                    ModelStore.RevealModelFile(ReadStringField(request.Body, "id"));
                    json = "{\"ok\":true}";
                }
                else if (path == "/api/models/custom/import")
                {
                    Func<string, string> picker = PickFileRequested;
                    if (picker == null)
                    {
                        status = "503 Service Unavailable";
                        json = ErrorJson("选择文件功能不可用");
                    }
                    else
                    {
                        // 先校验用途再弹窗，免得选完文件才报错。
                        string kind = CustomModelStore.NormalizeKind(ReadOptionalStringField(request.Body, "kind"));
                        string selected = picker(null);
                        json = selected == null
                            ? "{\"canceled\":true," + ModelStore.DescribeJson().Substring(1)
                            : "{\"imported\":" +
                                new JavaScriptSerializer().Serialize(CustomModelStore.Import(selected, kind)) +
                                "," + ModelStore.DescribeJson().Substring(1);
                    }
                }
                else if (path == "/api/models/custom/rename")
                {
                    CustomModelStore.Rename(
                        ReadStringField(request.Body, "id"),
                        ReadStringField(request.Body, "name"));
                    json = ModelStore.DescribeJson();
                }
                else if (path == "/api/models/custom/delete")
                {
                    CustomModelStore.Delete(ReadStringField(request.Body, "id"));
                    json = ModelStore.DescribeJson();
                }
                else
                {
                    status = "404 Not Found";
                    json = ErrorJson("Not Found");
                }
            }
            catch (Exception ex)
            {
                status = "500 Internal Server Error";
                json = ErrorJson(ex.Message);
            }

            WriteResponse(
                stream,
                status,
                "application/json; charset=utf-8",
                Encoding.UTF8.GetBytes(json),
                false);
        }

        /// <summary>/models/文件名：把已下载完的模型或运行库原样发给页面（只认清单里的文件名）。</summary>
        private static void HandleModelFile(
            NetworkStream stream,
            string method,
            string path,
            HttpRequestData request)
        {
            if ((method != "GET" && method != "HEAD") || !IsLocalAuthority(GetHeader(request.Head, "Host")))
            {
                WriteResponse(
                    stream,
                    "403 Forbidden",
                    "text/plain; charset=utf-8",
                    Encoding.UTF8.GetBytes("Forbidden"),
                    false);
                return;
            }

            string[] served = ModelStore.ResolveServedFile(path.Substring("/models/".Length));
            if (served == null)
            {
                WriteResponse(
                    stream,
                    "404 Not Found",
                    "text/plain; charset=utf-8",
                    Encoding.UTF8.GetBytes("Not Found"),
                    method == "HEAD");
                return;
            }

            using (FileStream file = new FileStream(served[0], FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                byte[] headerBytes = Encoding.ASCII.GetBytes(BuildHeader("200 OK", served[1], file.Length));
                stream.Write(headerBytes, 0, headerBytes.Length);
                if (method != "HEAD")
                {
                    file.CopyTo(stream, 81920);
                }
                stream.Flush();
            }
        }

        private static bool IsTrustedConfigRequest(string head)
        {
            if (GetHeader(head, "X-Yisi-Config") != "1")
            {
                return false;
            }

            string host = GetHeader(head, "Host");
            if (!IsLocalAuthority(host))
            {
                return false;
            }

            string origin = GetHeader(head, "Origin");
            return origin == null ||
                string.Equals(origin, "http://" + host, StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsLocalAuthority(string host)
        {
            return string.Equals(host, "127.0.0.1:47831", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(host, "localhost:47831", StringComparison.OrdinalIgnoreCase);
        }

        private static string GetHeader(string head, string name)
        {
            string[] lines = head.Split(new string[] { "\r\n" }, StringSplitOptions.None);
            for (int index = 1; index < lines.Length; index++)
            {
                int colon = lines[index].IndexOf(':');
                if (colon <= 0)
                {
                    continue;
                }
                if (string.Equals(lines[index].Substring(0, colon).Trim(), name, StringComparison.OrdinalIgnoreCase))
                {
                    return lines[index].Substring(colon + 1).Trim();
                }
            }
            return null;
        }

        /// <summary>解析 {"id": "..."} 这类只有一个字符串字段的请求体。</summary>
        /// <summary>读一个可以省略的字符串字段；没有、或不是字符串时返回 null。</summary>
        private static string ReadOptionalStringField(byte[] body, string name)
        {
            try
            {
                Dictionary<string, object> parsed = new JavaScriptSerializer().DeserializeObject(
                    Encoding.UTF8.GetString(body)) as Dictionary<string, object>;
                object value;
                return parsed != null && parsed.TryGetValue(name, out value) ? value as string : null;
            }
            catch
            {
                return null;
            }
        }

        private static string ReadStringField(byte[] body, string name)
        {
            Dictionary<string, object> parsed = null;
            try
            {
                parsed = new JavaScriptSerializer().DeserializeObject(Encoding.UTF8.GetString(body))
                    as Dictionary<string, object>;
            }
            catch
            {
                // 下面统一报格式错误。
            }
            object value;
            if (parsed == null || !parsed.TryGetValue(name, out value) || !(value is string))
            {
                throw new ConfigException("请求格式无效");
            }
            return (string)value;
        }

        /// <summary>解析 {"dir": "D:\\..."}；dir 为 null 表示移回程序所在目录。</summary>
        private static string ReadDirectoryField(byte[] body)
        {
            Dictionary<string, object> parsed = null;
            try
            {
                parsed = new JavaScriptSerializer().DeserializeObject(Encoding.UTF8.GetString(body))
                    as Dictionary<string, object>;
            }
            catch
            {
                // 下面统一报格式错误。
            }
            if (parsed == null)
            {
                throw new ConfigException("请求格式无效");
            }

            object value;
            if (!parsed.TryGetValue("dir", out value) || value == null)
            {
                return null;
            }
            string dir = value as string;
            if (dir == null)
            {
                throw new ConfigException("请求格式无效");
            }
            return dir;
        }

        private static string ErrorJson(string message)
        {
            return "{\"ok\":false,\"error\":" + new JavaScriptSerializer().Serialize(message ?? string.Empty) + "}";
        }

        private sealed class HttpRequestData
        {
            internal string Head;
            internal byte[] Body;
            internal bool IsBodyTooLarge;
        }

        /// <summary>
        /// 读请求头（上限 8 KB）与按 Content-Length 的请求体（上限 64 KB，超过只标记不读取）。
        /// </summary>
        private static HttpRequestData ReadRequest(NetworkStream stream)
        {
            byte[] buffer = new byte[8192];
            int count = 0;
            int headerEnd = -1;

            while (count < buffer.Length)
            {
                int read = stream.Read(buffer, count, buffer.Length - count);
                if (read <= 0)
                {
                    return null;
                }

                count += read;
                headerEnd = IndexOfHeaderEnd(buffer, count);
                if (headerEnd >= 0)
                {
                    break;
                }
            }

            if (headerEnd < 0)
            {
                return null;
            }

            HttpRequestData request = new HttpRequestData();
            request.Head = Encoding.ASCII.GetString(buffer, 0, headerEnd);
            request.Body = new byte[0];

            int contentLength;
            string lengthText = GetHeader(request.Head, "Content-Length");
            if (lengthText == null ||
                !int.TryParse(lengthText, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out contentLength) ||
                contentLength <= 0)
            {
                return request;
            }
            if (contentLength > ConfigStore.MaxSettingsBytes)
            {
                request.IsBodyTooLarge = true;
                return request;
            }

            byte[] body = new byte[contentLength];
            int bodyStart = headerEnd + 4;
            int filled = Math.Min(contentLength, count - bodyStart);
            if (filled > 0)
            {
                Buffer.BlockCopy(buffer, bodyStart, body, 0, filled);
            }
            while (filled < contentLength)
            {
                int read = stream.Read(body, filled, contentLength - filled);
                if (read <= 0)
                {
                    return null;
                }
                filled += read;
            }

            request.Body = body;
            return request;
        }

        private static int IndexOfHeaderEnd(byte[] buffer, int count)
        {
            for (int index = 0; index + 3 < count; index++)
            {
                if (buffer[index] == 13 && buffer[index + 1] == 10 &&
                    buffer[index + 2] == 13 && buffer[index + 3] == 10)
                {
                    return index;
                }
            }
            return -1;
        }

        private static void WriteResponse(
            NetworkStream stream,
            string status,
            string contentType,
            byte[] body,
            bool headOnly)
        {
            byte[] headerBytes = Encoding.ASCII.GetBytes(BuildHeader(status, contentType, body.Length));
            stream.Write(headerBytes, 0, headerBytes.Length);
            if (!headOnly && body.Length > 0)
            {
                stream.Write(body, 0, body.Length);
            }
            stream.Flush();
        }

        /// <summary>
        /// 所有响应共用的头。COOP / COEP 让页面处于跨源隔离状态，AI 修瑕的 wasm 才能多线程运行；
        /// 页面不加载任何外站资源，开启后不影响其他功能。
        /// </summary>
        private static string BuildHeader(string status, string contentType, long length)
        {
            StringBuilder header = new StringBuilder();
            header.Append("HTTP/1.1 ").Append(status).Append("\r\n");
            header.Append("Content-Type: ").Append(contentType).Append("\r\n");
            header.Append("Content-Length: ").Append(length).Append("\r\n");
            header.Append("Cache-Control: no-cache\r\n");
            header.Append("X-Content-Type-Options: nosniff\r\n");
            header.Append("Cross-Origin-Opener-Policy: same-origin\r\n");
            header.Append("Cross-Origin-Embedder-Policy: require-corp\r\n");
            header.Append("Cross-Origin-Resource-Policy: same-origin\r\n");
            header.Append("Connection: close\r\n\r\n");
            return header.ToString();
        }

        private static string GetContentType(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".html":
                    return "text/html; charset=utf-8";
                case ".js":
                case ".mjs":
                    return "text/javascript; charset=utf-8";
                case ".css":
                    return "text/css; charset=utf-8";
                case ".json":
                    return "application/json; charset=utf-8";
                case ".svg":
                    return "image/svg+xml";
                case ".png":
                    return "image/png";
                case ".ico":
                    return "image/x-icon";
                case ".webp":
                    return "image/webp";
                case ".woff":
                    return "font/woff";
                case ".woff2":
                    return "font/woff2";
                case ".wasm":
                    return "application/wasm";
                default:
                    return "application/octet-stream";
            }
        }

        private static Dictionary<string, byte[]> LoadAssets()
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            Stream archiveStream = assembly.GetManifestResourceStream("WebAssets.zip");
            if (archiveStream == null)
            {
                throw new InvalidOperationException(
                    "内置网页资源缺失。现有资源：" +
                    string.Join(", ", assembly.GetManifestResourceNames()));
            }

            Dictionary<string, byte[]> result =
                new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);

            using (archiveStream)
            using (ZipArchive archive = new ZipArchive(archiveStream, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string name = entry.FullName.Replace('\\', '/').TrimStart('/');
                    if (name.Length == 0 || name.EndsWith("/", StringComparison.Ordinal))
                    {
                        continue;
                    }

                    using (Stream entryStream = entry.Open())
                    using (MemoryStream memory = new MemoryStream())
                    {
                        entryStream.CopyTo(memory);
                        result[name] = memory.ToArray();
                    }
                }
            }

            if (!result.ContainsKey("index.html"))
            {
                throw new InvalidOperationException("内置网页资源不完整：缺少 index.html。");
            }

            return result;
        }
    }
}
