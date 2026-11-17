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
using System.Windows.Forms;

[assembly: AssemblyTitle("Yisi 图像工具")]
[assembly: AssemblyDescription("本地多图拼接工具")]
[assembly: AssemblyProduct("Yisi 图像工具")]
[assembly: AssemblyCompany("Yisi")]
[assembly: AssemblyVersion("0.5.0.0")]
[assembly: AssemblyFileVersion("0.5.0.0")]

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

                try
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
                    {
                        ShowError("运行异常：\n" + e.Exception.Message);
                    };

                    Application.Run(new TrayContext(openBrowser));
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
        private bool isCleanedUp;

        public TrayContext(bool openBrowser)
        {
            server = new StaticServer(Program.AppUrl);
            server.Start();

            appIcon = LoadAppIcon();

            ToolStripMenuItem openItem = new ToolStripMenuItem("打开界面");
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            openItem.Click += delegate { Program.OpenBrowser(); };

            ToolStripMenuItem exitItem = new ToolStripMenuItem("退出");
            exitItem.Click += delegate { ExitApplication(); };

            trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add(openItem);
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add(exitItem);

            trayIcon = new NotifyIcon();
            trayIcon.Icon = appIcon;
            trayIcon.Text = "Yisi 图像工具（双击打开）";
            trayIcon.ContextMenuStrip = trayMenu;
            trayIcon.DoubleClick += delegate { Program.OpenBrowser(); };
            trayIcon.Visible = true;

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
                        string request = ReadRequest(stream);
                        if (string.IsNullOrEmpty(request))
                        {
                            return;
                        }

                        string[] lines = request.Split(new string[] { "\r\n" }, StringSplitOptions.None);
                        string[] parts = lines[0].Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                        if (parts.Length < 2)
                        {
                            return;
                        }

                        string method = parts[0].ToUpperInvariant();
                        if (method != "GET" && method != "HEAD")
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

        private static string ReadRequest(NetworkStream stream)
        {
            byte[] buffer = new byte[8192];
            int count = 0;

            while (count < buffer.Length)
            {
                int read = stream.Read(buffer, count, buffer.Length - count);
                if (read <= 0)
                {
                    return null;
                }

                count += read;
                string text = Encoding.ASCII.GetString(buffer, 0, count);
                if (text.IndexOf("\r\n\r\n", StringComparison.Ordinal) >= 0)
                {
                    return text;
                }
            }

            return null;
        }

        private static void WriteResponse(
            NetworkStream stream,
            string status,
            string contentType,
            byte[] body,
            bool headOnly)
        {
            StringBuilder header = new StringBuilder();
            header.Append("HTTP/1.1 ").Append(status).Append("\r\n");
            header.Append("Content-Type: ").Append(contentType).Append("\r\n");
            header.Append("Content-Length: ").Append(body.Length).Append("\r\n");
            header.Append("Cache-Control: no-cache\r\n");
            header.Append("X-Content-Type-Options: nosniff\r\n");
            header.Append("Connection: close\r\n\r\n");

            byte[] headerBytes = Encoding.ASCII.GetBytes(header.ToString());
            stream.Write(headerBytes, 0, headerBytes.Length);
            if (!headOnly && body.Length > 0)
            {
                stream.Write(body, 0, body.Length);
            }
            stream.Flush();
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
