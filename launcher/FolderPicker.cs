using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Yisi.ImageTool
{
    /// <summary>
    /// 系统「选择文件夹」窗口。优先用 Vista 以后的新式对话框（IFileOpenDialog + FOS_PICKFOLDERS），
    /// 不可用时退回 FolderBrowserDialog。必须在 UI 线程调用。
    /// 托盘程序没有自己的窗口，浏览器又在前台，所以先放一个置顶的透明宿主窗口当所有者，
    /// 让对话框出现在浏览器上方。
    /// </summary>
    internal static class FolderPicker
    {
        private const uint FosNoChangeDir = 0x00000008;
        private const uint FosPickFolders = 0x00000020;
        private const uint FosForceFileSystem = 0x00000040;
        private const uint FosPathMustExist = 0x00000800;
        private const uint SigdnFileSysPath = 0x80058000;
        private const int ErrorCancelled = unchecked((int)0x800704C7);

        /// <summary>返回选中的目录；用户取消时返回 null。</summary>
        internal static string Pick(string title, string initialDirectory)
        {
            using (Form owner = CreateOwner())
            {
                owner.Show();
                owner.Activate();
                SetForegroundWindow(owner.Handle);
                try
                {
                    return PickModern(owner.Handle, title, initialDirectory);
                }
                catch (COMException)
                {
                    return PickClassic(owner, title, initialDirectory);
                }
                catch (InvalidCastException)
                {
                    return PickClassic(owner, title, initialDirectory);
                }
            }
        }

        private static Form CreateOwner()
        {
            Rectangle area = Screen.FromPoint(Cursor.Position).WorkingArea;
            Form form = new Form();
            form.ShowInTaskbar = false;
            form.FormBorderStyle = FormBorderStyle.None;
            form.StartPosition = FormStartPosition.Manual;
            form.Bounds = new Rectangle(
                area.Left + area.Width / 2,
                area.Top + area.Height / 3,
                1,
                1);
            form.Opacity = 0;
            form.TopMost = true;
            return form;
        }

        private static string PickModern(IntPtr owner, string title, string initialDirectory)
        {
            IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogComObject();
            IShellItem folder = null;
            IShellItem result = null;
            try
            {
                uint options;
                dialog.GetOptions(out options);
                dialog.SetOptions(
                    options | FosPickFolders | FosForceFileSystem | FosPathMustExist | FosNoChangeDir);
                dialog.SetTitle(title);
                dialog.SetOkButtonLabel("选择此目录");

                if (!string.IsNullOrWhiteSpace(initialDirectory) && Directory.Exists(initialDirectory))
                {
                    Guid shellItemId = typeof(IShellItem).GUID;
                    SHCreateItemFromParsingName(initialDirectory, IntPtr.Zero, ref shellItemId, out folder);
                    dialog.SetFolder(folder);
                }

                int hr = dialog.Show(owner);
                if (hr == ErrorCancelled)
                {
                    return null;
                }
                if (hr != 0)
                {
                    throw new COMException("选择目录窗口打开失败", hr);
                }

                dialog.GetResult(out result);
                string path;
                result.GetDisplayName(SigdnFileSysPath, out path);
                return string.IsNullOrWhiteSpace(path) ? null : path;
            }
            finally
            {
                if (result != null)
                {
                    Marshal.ReleaseComObject(result);
                }
                if (folder != null)
                {
                    Marshal.ReleaseComObject(folder);
                }
                Marshal.ReleaseComObject(dialog);
            }
        }

        private static string PickClassic(IWin32Window owner, string title, string initialDirectory)
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = title;
                dialog.ShowNewFolderButton = true;
                if (!string.IsNullOrWhiteSpace(initialDirectory) && Directory.Exists(initialDirectory))
                {
                    dialog.SelectedPath = initialDirectory;
                }
                return dialog.ShowDialog(owner) == DialogResult.OK ? dialog.SelectedPath : null;
            }
        }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern void SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
            IntPtr pbc,
            ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

        [ComImport]
        [Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        private class FileOpenDialogComObject
        {
        }

        // 方法顺序必须与 IModalWindow → IFileDialog → IFileOpenDialog 的 vtable 一致，不能增删或调换。
        [ComImport]
        [Guid("d57c7288-d4ad-4768-be02-9d969532d960")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileOpenDialog
        {
            [PreserveSig]
            int Show(IntPtr parent);

            void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);

            void SetFileTypeIndex(uint iFileType);

            void GetFileTypeIndex(out uint piFileType);

            void Advise(IntPtr pfde, out uint pdwCookie);

            void Unadvise(uint dwCookie);

            void SetOptions(uint fos);

            void GetOptions(out uint pfos);

            void SetDefaultFolder(IShellItem psi);

            void SetFolder(IShellItem psi);

            void GetFolder(out IShellItem ppsi);

            void GetCurrentSelection(out IShellItem ppsi);

            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);

            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);

            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);

            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);

            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);

            void GetResult(out IShellItem ppsi);

            void AddPlace(IShellItem psi, int fdap);

            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);

            void Close(int hr);

            void SetClientGuid(ref Guid guid);

            void ClearClientData();

            void SetFilter(IntPtr pFilter);

            void GetResults(out IntPtr ppenum);

            void GetSelectedItems(out IntPtr ppsai);
        }

        [ComImport]
        [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem
        {
            void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);

            void GetParent(out IShellItem ppsi);

            void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);

            void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);

            void Compare(IShellItem psi, uint hint, out int piOrder);
        }
    }
}
