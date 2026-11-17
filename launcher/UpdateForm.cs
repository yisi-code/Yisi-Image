using System;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace Yisi.ImageTool
{
    /// <summary>
    /// 原生更新窗口：打开后自动开始下载，显示百分比和字节进度；
    /// 下载并校验完成后，用户点一次即可重启安装。
    /// </summary>
    internal sealed class UpdateForm : Form
    {
        private readonly UpdateInfo info;
        private readonly Version currentVersion;
        private readonly Icon appIcon;
        private readonly Label statusLabel;
        private readonly ProgressBar progressBar;
        private readonly Button primaryButton;
        private readonly Button laterButton;

        private volatile bool canceled;
        private Thread downloadThread;
        private string downloadedPath;
        private bool isDownloading;
        private bool isReady;
        private bool installRequested;

        internal UpdateForm(UpdateInfo info, Version currentVersion, Icon appIcon)
        {
            this.info = info;
            this.currentVersion = currentVersion;
            this.appIcon = appIcon;

            Text = "软件更新 - Yisi 图像工具";
            ClientSize = new Size(620, 462);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = true;
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            BackColor = Color.FromArgb(246, 248, 247);
            if (appIcon != null)
            {
                Icon = appIcon;
            }

            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 88;
            header.BackColor = Color.White;
            header.Paint += delegate(object sender, PaintEventArgs e)
            {
                using (Pen pen = new Pen(Color.FromArgb(226, 233, 229)))
                {
                    e.Graphics.DrawLine(pen, 0, header.Height - 1, header.Width, header.Height - 1);
                }
            };
            Controls.Add(header);

            PictureBox iconBox = new PictureBox();
            iconBox.Location = new Point(24, 20);
            iconBox.Size = new Size(48, 48);
            iconBox.SizeMode = PictureBoxSizeMode.Zoom;
            iconBox.Image = appIcon == null ? null : appIcon.ToBitmap();
            header.Controls.Add(iconBox);

            Label title = new Label();
            title.AutoSize = false;
            title.Location = new Point(88, 16);
            title.Size = new Size(500, 32);
            title.Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold, GraphicsUnit.Point);
            title.ForeColor = Color.FromArgb(19, 32, 28);
            title.Text = "发现新版本 v" + info.VersionText;
            header.Controls.Add(title);

            Label subtitle = new Label();
            subtitle.AutoSize = false;
            subtitle.Location = new Point(88, 49);
            subtitle.Size = new Size(500, 24);
            subtitle.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            subtitle.ForeColor = Color.FromArgb(102, 115, 110);
            subtitle.Text = "当前版本 v" + UpdateService.FormatVersion(currentVersion) +
                "  ·  来自 " + info.Source;
            header.Controls.Add(subtitle);

            Label notesTitle = new Label();
            notesTitle.AutoSize = true;
            notesTitle.Location = new Point(24, 104);
            notesTitle.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold, GraphicsUnit.Point);
            notesTitle.ForeColor = Color.FromArgb(38, 51, 47);
            notesTitle.Text = "更新内容";
            Controls.Add(notesTitle);

            TextBox notes = new TextBox();
            notes.Location = new Point(24, 128);
            notes.Size = new Size(572, 170);
            notes.Multiline = true;
            notes.ReadOnly = true;
            notes.ScrollBars = ScrollBars.Vertical;
            notes.BorderStyle = BorderStyle.FixedSingle;
            notes.BackColor = Color.White;
            notes.ForeColor = Color.FromArgb(38, 51, 47);
            notes.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            notes.Text = DisplayNotes(info.Notes);
            notes.TabStop = false;
            notes.SelectionLength = 0;
            Controls.Add(notes);

            statusLabel = new Label();
            statusLabel.AutoSize = false;
            statusLabel.Location = new Point(24, 310);
            statusLabel.Size = new Size(572, 38);
            statusLabel.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            statusLabel.ForeColor = Color.FromArgb(102, 115, 110);
            statusLabel.Text = "准备下载…";
            statusLabel.TextAlign = ContentAlignment.MiddleLeft;
            Controls.Add(statusLabel);

            progressBar = new ProgressBar();
            progressBar.Location = new Point(24, 352);
            progressBar.Size = new Size(572, 14);
            progressBar.Minimum = 0;
            progressBar.Maximum = 100;
            progressBar.Style = ProgressBarStyle.Continuous;
            Controls.Add(progressBar);

            Label footer = new Label();
            footer.AutoSize = false;
            footer.Location = new Point(24, 376);
            footer.Size = new Size(572, 22);
            footer.Font = new Font("Microsoft YaHei UI", 8F, FontStyle.Regular, GraphicsUnit.Point);
            footer.ForeColor = Color.FromArgb(139, 151, 146);
            footer.Text = "下载完成后点击「立即重启并安装」；安装包会经过 SHA-256 校验。";
            Controls.Add(footer);

            laterButton = new Button();
            laterButton.Location = new Point(386, 410);
            laterButton.Size = new Size(96, 34);
            laterButton.Text = "稍后";
            laterButton.FlatStyle = FlatStyle.Flat;
            laterButton.FlatAppearance.BorderColor = Color.FromArgb(207, 218, 213);
            laterButton.BackColor = Color.White;
            laterButton.ForeColor = Color.FromArgb(38, 51, 47);
            laterButton.Click += delegate
            {
                canceled = true;
                DialogResult = DialogResult.Cancel;
                Close();
            };
            Controls.Add(laterButton);

            primaryButton = new Button();
            primaryButton.Location = new Point(494, 410);
            primaryButton.Size = new Size(102, 34);
            primaryButton.Text = "下载并安装";
            primaryButton.Enabled = false;
            primaryButton.FlatStyle = FlatStyle.Flat;
            primaryButton.FlatAppearance.BorderSize = 0;
            primaryButton.BackColor = Color.FromArgb(15, 118, 110);
            primaryButton.ForeColor = Color.White;
            primaryButton.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold, GraphicsUnit.Point);
            primaryButton.Click += delegate(object sender, EventArgs e)
            {
                if (isReady)
                {
                    installRequested = true;
                    DialogResult = DialogResult.OK;
                    Close();
                    return;
                }
                if (!isDownloading)
                {
                    StartDownload();
                }
            };
            Controls.Add(primaryButton);

            Shown += delegate
            {
                laterButton.Focus();
                StartDownload();
            };
            FormClosing += delegate
            {
                canceled = true;
            };
        }

        internal bool InstallRequested
        {
            get { return installRequested; }
        }

        internal string DownloadedPath
        {
            get { return downloadedPath; }
        }

        private void StartDownload()
        {
            if (isDownloading)
            {
                return;
            }

            isDownloading = true;
            isReady = false;
            canceled = false;
            downloadedPath = null;
            progressBar.Value = 0;
            primaryButton.Enabled = false;
            primaryButton.BackColor = Color.FromArgb(153, 180, 174);
            statusLabel.ForeColor = Color.FromArgb(102, 115, 110);
            statusLabel.Text = "正在连接更新服务器…";

            downloadThread = new Thread(DownloadWorker);
            downloadThread.IsBackground = true;
            downloadThread.Name = "YisiUpdateDownload";
            downloadThread.Start();
        }

        private void DownloadWorker()
        {
            try
            {
                string path = UpdateService.Download(
                    info,
                    delegate(int percent, long received, long total)
                    {
                        PostProgress(percent, received, total);
                    },
                    delegate { return canceled; });
                PostCompleted(path);
            }
            catch (Exception ex)
            {
                PostFailed(ex.Message);
            }
        }

        private void PostProgress(int percent, long received, long total)
        {
            Post(delegate
            {
                if (IsDisposed)
                {
                    return;
                }
                progressBar.Value = Math.Max(0, Math.Min(100, percent));
                string size = total > 0
                    ? FormatBytes(received) + " / " + FormatBytes(total)
                    : FormatBytes(received);
                statusLabel.Text = "正在下载… " + percent.ToString(CultureInfo.InvariantCulture) +
                    "%  (" + size + ")";
            });
        }

        private void PostCompleted(string path)
        {
            Post(delegate
            {
                if (IsDisposed)
                {
                    return;
                }
                isDownloading = false;
                isReady = true;
                downloadedPath = path;
                progressBar.Value = 100;
                statusLabel.ForeColor = Color.FromArgb(6, 118, 71);
                statusLabel.Text = "下载完成，已通过 SHA-256 校验。";
                primaryButton.Text = "立即重启并安装";
                primaryButton.Enabled = true;
                primaryButton.BackColor = Color.FromArgb(15, 118, 110);
            });
        }

        private void PostFailed(string message)
        {
            Post(delegate
            {
                if (IsDisposed)
                {
                    return;
                }
                isDownloading = false;
                isReady = false;
                progressBar.Value = 0;
                statusLabel.ForeColor = Color.FromArgb(180, 35, 24);
                statusLabel.Text = "下载失败：" + message;
                primaryButton.Text = "重试";
                primaryButton.Enabled = true;
                primaryButton.BackColor = Color.FromArgb(15, 118, 110);
            });
        }

        private void Post(Action action)
        {
            if (IsDisposed || !IsHandleCreated)
            {
                return;
            }

            try
            {
                BeginInvoke(action);
            }
            catch (ObjectDisposedException)
            {
                // 窗口已经释放。
            }
            catch (InvalidOperationException)
            {
                // 窗口正在关闭时忽略后台线程回报。
            }
        }

        private static string FormatBytes(long bytes)
        {
            if (bytes >= 1024 * 1024)
            {
                return (bytes / 1024.0 / 1024.0).ToString("0.0", CultureInfo.InvariantCulture) + " MB";
            }
            return (bytes / 1024.0).ToString("0", CultureInfo.InvariantCulture) + " KB";
        }

        private static string DisplayNotes(string notes)
        {
            if (string.IsNullOrWhiteSpace(notes))
            {
                return "本次更新没有附说明。";
            }

            string text = Regex.Replace(
                notes,
                @"(?im)^\s*(?:[-*]\s*)?SHA-?256\s*[:：].*$",
                string.Empty);
            text = text.Trim();
            return string.IsNullOrWhiteSpace(text) ? notes.Trim() : text;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                canceled = true;
                if (progressBar != null)
                {
                    progressBar.Dispose();
                }
            }
            base.Dispose(disposing);
        }
    }
}
