// OpenCapture is distributed under GPL-3.0. See the repository LICENSE file.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class QuickLaunch
{
    [STAThread]
    private static int Main(string[] args)
    {
        string diagnosticsPath = ArgumentValue(args, "--diagnostics");
        if (HasArgument(args, "--capture-self-test"))
            return NativeCapture.RunSelfTest(diagnosticsPath);
        if (HasArgument(args, "--self-test"))
            return RunSelfTest(diagnosticsPath);

        bool createdNew;
        string mutexName = "Local\\OpenCaptureQuick-" + Process.GetCurrentProcess().SessionId.ToString(CultureInfo.InvariantCulture);
        using (Mutex mutex = new Mutex(true, mutexName, out createdNew))
        {
            if (!createdNew)
                return 0;

            NativeCapture.EnableDpiAwareness();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (QuickLaunchContext context = new QuickLaunchContext(diagnosticsPath))
                Application.Run(context);
        }
        return 0;
    }

    private static int RunSelfTest(string diagnosticsPath)
    {
        Stopwatch timer = Stopwatch.StartNew();
        bool firstRegistered = false;
        bool duplicateRejected = false;
        const int testId = 91;
        const int duplicateId = 92;
        using (HotKeyWindow window = new HotKeyWindow(null))
        {
            try
            {
                firstRegistered = NativeMethods.RegisterHotKey(window.Handle, testId,
                    NativeMethods.ModControl | NativeMethods.ModShift | NativeMethods.ModNoRepeat,
                    (uint)Keys.F24);
                if (firstRegistered)
                    duplicateRejected = !NativeMethods.RegisterHotKey(window.Handle, duplicateId,
                        NativeMethods.ModControl | NativeMethods.ModShift | NativeMethods.ModNoRepeat,
                        (uint)Keys.F24);
            }
            finally
            {
                NativeMethods.UnregisterHotKey(window.Handle, duplicateId);
                NativeMethods.UnregisterHotKey(window.Handle, testId);
            }
        }

        timer.Stop();
        string json = "{\"selfTest\":true,\"combination\":\"Ctrl+Shift+F24\",\"firstRegistered\":"
            + JsonBoolean(firstRegistered) + ",\"duplicateRejected\":" + JsonBoolean(duplicateRejected)
            + ",\"released\":true,\"startupMs\":" + timer.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture) + "}";
        WriteDiagnostics(diagnosticsPath, json);
        return firstRegistered && duplicateRejected ? 0 : 1;
    }

    internal static void WriteDiagnostics(string path, string json)
    {
        if (String.IsNullOrEmpty(path))
            return;
        string fullPath = Path.GetFullPath(path);
        string directory = Path.GetDirectoryName(fullPath);
        if (!String.IsNullOrEmpty(directory))
            Directory.CreateDirectory(directory);
        File.WriteAllText(fullPath, json, new UTF8Encoding(false));
    }

    internal static string JsonString(string value)
    {
        if (value == null)
            return "null";
        StringBuilder result = new StringBuilder(value.Length + 2);
        result.Append('"');
        foreach (char character in value)
        {
            switch (character)
            {
                case '"': result.Append("\\\""); break;
                case '\\': result.Append("\\\\"); break;
                case '\b': result.Append("\\b"); break;
                case '\f': result.Append("\\f"); break;
                case '\n': result.Append("\\n"); break;
                case '\r': result.Append("\\r"); break;
                case '\t': result.Append("\\t"); break;
                default:
                    if (character < 32)
                        result.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    else
                        result.Append(character);
                    break;
            }
        }
        return result.Append('"').ToString();
    }

    internal static string JsonBoolean(bool value)
    {
        return value ? "true" : "false";
    }

    private static bool HasArgument(string[] args, string name)
    {
        foreach (string arg in args)
            if (String.Equals(arg, name, StringComparison.OrdinalIgnoreCase))
                return true;
        return false;
    }

    private static string ArgumentValue(string[] args, string name)
    {
        for (int index = 0; index + 1 < args.Length; index++)
            if (String.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
                return args[index + 1];
        return null;
    }
}

internal sealed class QuickLaunchContext : ApplicationContext
{
    private const int ToggleId = 1;
    private const int CaptureId = 2;
    private readonly Stopwatch startupTimer = Stopwatch.StartNew();
    private readonly HotKeyWindow window;
    private readonly NotifyIcon notifyIcon;
    private readonly ContextMenuStrip menu;
    private readonly HotKeyRegistration toggle;
    private readonly HotKeyRegistration capture;
    private Icon ownedIcon;
    private CaptureOverlay captureOverlay;
    private ToolStripMenuItem openLastCaptureItem;
    private ToolStripMenuItem openCaptureFolderItem;
    private string lastCapturePath;
    private bool disposed;

    internal QuickLaunchContext(string diagnosticsPath)
    {
        window = new HotKeyWindow(HandleHotKey);
        toggle = RegisterWithFallback(ToggleId, Keys.Space, "Ctrl+Shift+Space", "Ctrl+Alt+Space");
        capture = RegisterWithFallback(CaptureId, Keys.A, "Ctrl+Shift+A", "Ctrl+Alt+A");

        notifyIcon = new NotifyIcon();
        notifyIcon.Text = "OpenCapture Quick Launch";
        notifyIcon.Icon = LoadIcon();
        menu = BuildMenu();
        notifyIcon.ContextMenuStrip = menu;
        notifyIcon.DoubleClick += delegate { Launch("--broker --toggle"); };
        notifyIcon.Visible = true;

        startupTimer.Stop();
        WriteReadyDiagnostics(diagnosticsPath);
    }

    private HotKeyRegistration RegisterWithFallback(int id, Keys key, string preferred, string fallback)
    {
        uint preferredModifiers = NativeMethods.ModControl | NativeMethods.ModShift | NativeMethods.ModNoRepeat;
        uint fallbackModifiers = NativeMethods.ModControl | NativeMethods.ModAlt | NativeMethods.ModNoRepeat;
        bool preferredRegistered = NativeMethods.RegisterHotKey(window.Handle, id, preferredModifiers, (uint)key);
        if (preferredRegistered)
            return new HotKeyRegistration(id, preferred, false, false, true);

        bool fallbackRegistered = NativeMethods.RegisterHotKey(window.Handle, id, fallbackModifiers, (uint)key);
        return new HotKeyRegistration(id, fallbackRegistered ? fallback : null, true, !fallbackRegistered, fallbackRegistered);
    }

    private ContextMenuStrip BuildMenu()
    {
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("Open OpenCapture", null, delegate { Launch("--broker --toggle"); });
        menu.Items.Add("Capture", null, delegate { StartNativeCapture(); });
        openLastCaptureItem = new ToolStripMenuItem("Open last capture", null, delegate { OpenLastCapture(false); });
        openCaptureFolderItem = new ToolStripMenuItem("Open capture folder", null, delegate { OpenLastCapture(true); });
        openLastCaptureItem.Enabled = false;
        openCaptureFolderItem.Enabled = false;
        menu.Items.Add(openLastCaptureItem);
        menu.Items.Add(openCaptureFolderItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(StatusText("Open", toggle)).Enabled = false;
        menu.Items.Add(StatusText("Capture", capture)).Enabled = false;
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit Quick Launch", null, delegate { ExitThread(); });
        return menu;
    }

    private static string StatusText(string action, HotKeyRegistration registration)
    {
        if (!registration.Registered)
            return action + " hotkey unavailable (preferred and fallback conflict)";
        if (registration.PreferredConflict)
            return action + ": " + registration.ActualKey + " (preferred key conflict)";
        return action + ": " + registration.ActualKey;
    }

    private Icon LoadIcon()
    {
        string executable = SiblingExecutable();
        if (File.Exists(executable))
        {
            try
            {
                ownedIcon = Icon.ExtractAssociatedIcon(executable);
                if (ownedIcon != null)
                    return ownedIcon;
            }
            catch (Exception)
            {
            }
        }
        return SystemIcons.Application;
    }

    private void HandleHotKey(int id)
    {
        if (id == ToggleId)
            Launch("--broker --toggle");
        else if (id == CaptureId)
            StartNativeCapture();
    }

    private void StartNativeCapture()
    {
        if (captureOverlay != null && !captureOverlay.IsDisposed)
        {
            captureOverlay.Activate();
            return;
        }
        captureOverlay = NativeCapture.BeginCapture(HandleCaptureResult);
    }

    private void HandleCaptureResult(CaptureResult result)
    {
        captureOverlay = null;
        if (disposed || result.Cancelled)
            return;
        if (!result.Success)
        {
            ShowTrayMessage("Capture failed", result.Error, ToolTipIcon.Error);
            return;
        }
        lastCapturePath = result.SavedPath;
        openLastCaptureItem.Enabled = true;
        openCaptureFolderItem.Enabled = true;
        if (!String.IsNullOrEmpty(result.Warning))
        {
            ShowTrayMessage("Capture saved with warning", result.Warning + " Original: " + result.SavedPath,
                ToolTipIcon.Warning);
            return;
        }
        string workflowError;
        if (result.NeedsWorkflow && !LaunchProcessInbox(out workflowError))
            ShowTrayMessage("Capture saved", "The original PNG was saved, but its enabled workflow could not be applied. "
                + workflowError, ToolTipIcon.Warning);
        else
            ShowTrayMessage("Capture saved", result.SavedPath, ToolTipIcon.Info);
    }

    private void OpenLastCapture(bool folder)
    {
        if (String.IsNullOrEmpty(lastCapturePath))
            return;
        string target = folder ? Path.GetDirectoryName(lastCapturePath) : lastCapturePath;
        if (String.IsNullOrEmpty(target) || (!File.Exists(target) && !Directory.Exists(target)))
        {
            ShowTrayMessage("OpenCapture Quick Launch", "The saved capture is no longer available.", ToolTipIcon.Warning);
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }
        catch (Exception exception)
        {
            ShowTrayMessage("Could not open capture", exception.Message, ToolTipIcon.Error);
        }
    }

    private void ShowTrayMessage(string title, string message, ToolTipIcon icon)
    {
        notifyIcon.BalloonTipTitle = title;
        notifyIcon.BalloonTipText = message;
        notifyIcon.BalloonTipIcon = icon;
        notifyIcon.ShowBalloonTip(5000);
    }

    private static bool LaunchProcessInbox(out string error)
    {
        string executable = SiblingExecutable();
        if (!File.Exists(executable))
        {
            error = "OpenCapture.exe was not found beside OpenCaptureQuick.exe.";
            return false;
        }
        try
        {
            Process.Start(new ProcessStartInfo(executable, "--broker --process-inbox") {
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(executable)
            });
            error = null;
            return true;
        }
        catch (Exception exception)
        {
            error = exception.Message;
            return false;
        }
    }

    private static void Launch(string arguments)
    {
        string executable = SiblingExecutable();
        if (!File.Exists(executable))
        {
            MessageBox.Show("OpenCapture.exe was not found beside OpenCaptureQuick.exe.", "OpenCapture Quick Launch",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(executable, arguments) {
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(executable)
            });
        }
        catch (Exception exception)
        {
            MessageBox.Show("Could not start OpenCapture.\r\n\r\n" + exception.Message, "OpenCapture Quick Launch",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    internal static string SiblingExecutable()
    {
        return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "OpenCapture.exe");
    }

    private void WriteReadyDiagnostics(string diagnosticsPath)
    {
        if (String.IsNullOrEmpty(diagnosticsPath))
            return;
        Process process = Process.GetCurrentProcess();
        process.Refresh();
        string json = "{\"ready\":true,\"pid\":" + process.Id.ToString(CultureInfo.InvariantCulture)
            + ",\"toggle\":" + toggle.ToJson() + ",\"capture\":" + capture.ToJson()
            + ",\"workingSetBytes\":" + process.WorkingSet64.ToString(CultureInfo.InvariantCulture)
            + ",\"privateMemoryBytes\":" + process.PrivateMemorySize64.ToString(CultureInfo.InvariantCulture)
            + ",\"startupMs\":" + startupTimer.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture) + "}";
        QuickLaunch.WriteDiagnostics(diagnosticsPath, json);
    }

    protected override void ExitThreadCore()
    {
        DisposeResources();
        base.ExitThreadCore();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
            DisposeResources();
        base.Dispose(disposing);
    }

    private void DisposeResources()
    {
        if (disposed)
            return;
        disposed = true;
        if (toggle.Registered)
            NativeMethods.UnregisterHotKey(window.Handle, toggle.Id);
        if (capture.Registered)
            NativeMethods.UnregisterHotKey(window.Handle, capture.Id);
        if (captureOverlay != null && !captureOverlay.IsDisposed)
            captureOverlay.CancelCapture();
        notifyIcon.Visible = false;
        notifyIcon.Dispose();
        menu.Dispose();
        window.Dispose();
        if (ownedIcon != null)
            ownedIcon.Dispose();
    }
}

internal sealed class HotKeyRegistration
{
    internal readonly int Id;
    internal readonly string ActualKey;
    internal readonly bool PreferredConflict;
    internal readonly bool FallbackConflict;
    internal readonly bool Registered;

    internal HotKeyRegistration(int id, string actualKey, bool preferredConflict, bool fallbackConflict, bool registered)
    {
        Id = id;
        ActualKey = actualKey;
        PreferredConflict = preferredConflict;
        FallbackConflict = fallbackConflict;
        Registered = registered;
    }

    internal string ToJson()
    {
        return "{\"actualKey\":" + QuickLaunch.JsonString(ActualKey)
            + ",\"registered\":" + QuickLaunch.JsonBoolean(Registered)
            + ",\"preferredConflict\":" + QuickLaunch.JsonBoolean(PreferredConflict)
            + ",\"fallbackConflict\":" + QuickLaunch.JsonBoolean(FallbackConflict) + "}";
    }
}

internal sealed class HotKeyWindow : NativeWindow, IDisposable
{
    private const int WmHotKey = 0x0312;
    private readonly Action<int> handler;

    internal HotKeyWindow(Action<int> handler)
    {
        this.handler = handler;
        CreateHandle(new CreateParams());
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WmHotKey && handler != null)
            handler(message.WParam.ToInt32());
        base.WndProc(ref message);
    }

    public void Dispose()
    {
        DestroyHandle();
    }
}

internal static class NativeMethods
{
    internal const uint ModAlt = 0x0001;
    internal const uint ModControl = 0x0002;
    internal const uint ModShift = 0x0004;
    internal const uint ModNoRepeat = 0x4000;

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint virtualKey);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool UnregisterHotKey(IntPtr window, int id);
}
