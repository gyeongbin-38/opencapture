// OpenCapture is distributed under GPL-3.0. See the repository LICENSE file.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class QuickLaunch
{
    internal const string DefaultCaptureKey = "CommandOrControl+Shift+Space";
    internal const string DefaultToggleKey = "CommandOrControl+Alt+Space";

    [STAThread]
    private static int Main(string[] args)
    {
        string diagnosticsPath = ArgumentValue(args, "--diagnostics");
        string userDataPath = UserDataPath(args);
        string dispatch = ArgumentValue(args, "--dispatch");
        if (!String.IsNullOrEmpty(dispatch))
        {
            string dispatchError;
            int dispatchedPid;
            string dispatchExtra = ArgumentValue(args, "--dispatch-extra");
            bool dispatched = DispatchSibling(
                dispatch,
                userDataPath,
                dispatchExtra,
                out dispatchError,
                out dispatchedPid);
            WriteDiagnostics(diagnosticsPath,
                "{\"dispatched\":" + JsonBoolean(dispatched) +
                ",\"physicalKeyTested\":false,\"action\":" + JsonString(dispatch) +
                ",\"pid\":" + dispatchedPid.ToString(CultureInfo.InvariantCulture) +
                ",\"arguments\":" + JsonString(DispatchArguments(dispatch, userDataPath, dispatchExtra)) +
                ",\"error\":" + JsonString(dispatchError) + "}");
            return dispatched ? 0 : 1;
        }
        if (HasArgument(args, "--capture-self-test"))
            return NativeCapture.RunSelfTest(diagnosticsPath);
        if (HasArgument(args, "--self-test"))
            return RunSelfTest(diagnosticsPath, userDataPath);

        bool createdNew;
        string mutexName = "Local\\OpenCaptureQuick-" +
            Process.GetCurrentProcess().SessionId.ToString(CultureInfo.InvariantCulture);
        string testInstance = ArgumentValue(args, "--test-instance");
        if (!String.IsNullOrEmpty(testInstance))
            mutexName += "-" + testInstance.Replace("\\", "_").Replace("/", "_");
        using (Mutex mutex = new Mutex(true, mutexName, out createdNew))
        {
            if (!createdNew)
                return 0;

            NativeCapture.EnableDpiAwareness();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (QuickLaunchContext context = new QuickLaunchContext(
                diagnosticsPath,
                userDataPath,
                !String.IsNullOrEmpty(testInstance)))
                Application.Run(context);
        }
        return 0;
    }

    private static int RunSelfTest(string diagnosticsPath, string userDataPath)
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

        HotKeySpec capture;
        HotKeySpec toggle;
        string configError;
        HotKeyConfiguration.Load(userDataPath, out capture, out toggle, out configError);
        HotKeySpec meta;
        string metaError;
        bool metaParsed = HotKeySpec.TryParse("Meta+Shift+F12", out meta, out metaError);
        timer.Stop();
        string json = "{\"selfTest\":true,\"physicalKeyTested\":false,\"combination\":\"Ctrl+Shift+F24\",\"firstRegistered\":"
            + JsonBoolean(firstRegistered) + ",\"duplicateRejected\":" + JsonBoolean(duplicateRejected)
            + ",\"released\":true,\"configPath\":" + JsonString(Path.Combine(userDataPath, "config.json"))
            + ",\"capture\":" + capture.ToJson() + ",\"toggle\":" + toggle.ToJson()
            + ",\"configError\":" + JsonString(configError) + ",\"metaParsed\":" + JsonBoolean(metaParsed)
            + ",\"metaError\":" + JsonString(metaError)
            + ",\"captureDispatch\":\"--broker --native-dispatch --capture\""
            + ",\"toggleDispatch\":\"--broker --native-dispatch --toggle\""
            + ",\"startupMs\":" + timer.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture) + "}";
        WriteDiagnostics(diagnosticsPath, json);
        return firstRegistered && duplicateRejected && metaParsed ? 0 : 1;
    }

    internal static string UserDataPath(string[] args)
    {
        string explicitPath = ArgumentValue(args, "--userData");
        if (!String.IsNullOrWhiteSpace(explicitPath))
            return Path.GetFullPath(explicitPath);

        string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
        string[] preloadCandidates = {
            Path.Combine(baseDirectory, "preload_config"),
            Path.Combine(baseDirectory, "resources", "app", "preload_config")
        };
        foreach (string preloadPath in preloadCandidates)
        {
            try
            {
                if (!File.Exists(preloadPath))
                    continue;
                string configured = File.ReadAllText(preloadPath, Encoding.UTF8).Trim();
                if (String.IsNullOrEmpty(configured))
                    continue;
                return Path.GetFullPath(Path.IsPathRooted(configured)
                    ? configured
                    : Path.Combine(Path.GetDirectoryName(preloadPath), configured));
            }
            catch (Exception)
            {
            }
        }

        string[] portableCandidates = {
            Path.Combine(baseDirectory, "portable"),
            Path.Combine(baseDirectory, "resources", "app", "portable")
        };
        foreach (string portablePath in portableCandidates)
            if (Directory.Exists(portablePath))
                return portablePath;

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "OpenCapture");
    }

    internal static string DispatchArguments(string action, string userDataPath, string extraArguments)
    {
        string normalized = String.Equals(action, "capture", StringComparison.OrdinalIgnoreCase)
            ? "capture"
            : String.Equals(action, "toggle", StringComparison.OrdinalIgnoreCase)
                ? "toggle"
                : null;
        if (normalized == null)
            return null;
        string escapedPath = (userDataPath ?? "").Replace("\"", "\\\"");
        string extra = String.IsNullOrWhiteSpace(extraArguments)
            ? ""
            : " " + extraArguments.Trim();
        return "--broker --native-dispatch --" + normalized +
            " --userData=\"" + escapedPath + "\"" + extra;
    }

    internal static bool DispatchSibling(
        string action,
        string userDataPath,
        string extraArguments,
        out string error,
        out int pid)
    {
        pid = 0;
        string arguments = DispatchArguments(action, userDataPath, extraArguments);
        if (arguments == null)
        {
            error = "Unsupported dispatch action.";
            return false;
        }
        string executable = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "OpenCapture.exe");
        if (!File.Exists(executable))
        {
            error = "OpenCapture.exe was not found beside OpenCaptureQuick.exe.";
            return false;
        }
        try
        {
            Process launched = Process.Start(new ProcessStartInfo(executable, arguments) {
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(executable)
            });
            if (launched != null)
            {
                pid = launched.Id;
                launched.Dispose();
            }
            error = null;
            return true;
        }
        catch (Exception exception)
        {
            error = exception.Message;
            return false;
        }
    }

    internal static void WriteDiagnostics(string path, string json)
    {
        if (String.IsNullOrEmpty(path))
            return;
        WriteAtomic(path, json);
    }

    internal static void WriteAtomic(string path, string content)
    {
        string fullPath = Path.GetFullPath(path);
        string directory = Path.GetDirectoryName(fullPath);
        if (!String.IsNullOrEmpty(directory))
            Directory.CreateDirectory(directory);
        string temporary = fullPath + "." + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) + ".tmp";
        File.WriteAllText(temporary, content, new UTF8Encoding(false));
        if (File.Exists(fullPath))
        {
            try
            {
                File.Replace(temporary, fullPath, null);
                return;
            }
            catch (PlatformNotSupportedException)
            {
            }
            catch (IOException)
            {
            }
            File.Delete(fullPath);
        }
        File.Move(temporary, fullPath);
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
        for (int index = 0; index < args.Length; index++)
        {
            string arg = args[index];
            if (arg.StartsWith(name + "=", StringComparison.OrdinalIgnoreCase))
                return arg.Substring(name.Length + 1).Trim('"');
            if (index + 1 < args.Length &&
                String.Equals(arg, name, StringComparison.OrdinalIgnoreCase))
                return args[index + 1];
        }
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
    private readonly System.Windows.Forms.Timer refreshTimer;
    private readonly string diagnosticsPath;
    private readonly string userDataPath;
    private readonly string configPath;
    private readonly string ownerPath;
    private readonly string helperStatePath;
    private readonly bool allowTestOwner;
    private ContextMenuStrip menu;
    private HotKeyRegistration toggle = HotKeyRegistration.Disabled(ToggleId, QuickLaunch.DefaultToggleKey);
    private HotKeyRegistration capture = HotKeyRegistration.Disabled(CaptureId, QuickLaunch.DefaultCaptureKey);
    private Icon ownedIcon;
    private string configFingerprint;
    private string ownerFingerprint;
    private bool electronOwnsKeys;
    private HotKeySpec lastCaptureSpec;
    private HotKeySpec lastToggleSpec;
    private bool disposed;

    internal QuickLaunchContext(string diagnosticsPath, string userDataPath, bool allowTestOwner)
    {
        this.diagnosticsPath = diagnosticsPath;
        this.userDataPath = userDataPath;
        this.allowTestOwner = allowTestOwner;
        configPath = Path.Combine(userDataPath, "config.json");
        ownerPath = Path.Combine(userDataPath, "hotkey-owner.json");
        helperStatePath = Path.Combine(userDataPath, "hotkey-helper-state.json");
        Directory.CreateDirectory(userDataPath);

        window = new HotKeyWindow(HandleHotKey);
        notifyIcon = new NotifyIcon();
        notifyIcon.Text = "OpenCapture Quick Launch";
        notifyIcon.Icon = LoadIcon();
        notifyIcon.DoubleClick += delegate { Launch("toggle"); };
        notifyIcon.Visible = true;

        RefreshOwnership(true);
        refreshTimer = new System.Windows.Forms.Timer();
        refreshTimer.Interval = 350;
        refreshTimer.Tick += delegate { RefreshOwnership(false); };
        refreshTimer.Start();

        startupTimer.Stop();
        WriteReadyDiagnostics();
    }

    private void RefreshOwnership(bool force)
    {
        string nextConfigFingerprint = FileFingerprint(configPath);
        string nextOwnerFingerprint = FileFingerprint(ownerPath);
        bool claimed = LiveElectronClaim(ownerPath, allowTestOwner);
        if (!force && claimed == electronOwnsKeys &&
            nextConfigFingerprint == configFingerprint &&
            nextOwnerFingerprint == ownerFingerprint)
            return;

        configFingerprint = nextConfigFingerprint;
        ownerFingerprint = nextOwnerFingerprint;
        electronOwnsKeys = claimed;
        Unregister(toggle);
        Unregister(capture);

        string configError;
        HotKeySpec captureSpec;
        HotKeySpec toggleSpec;
        bool configLoaded = HotKeyConfiguration.Load(
            userDataPath,
            out captureSpec,
            out toggleSpec,
            out configError);
        if (!configLoaded && lastCaptureSpec != null && lastToggleSpec != null)
        {
            captureSpec = lastCaptureSpec;
            toggleSpec = lastToggleSpec;
        }
        else
        {
            lastCaptureSpec = captureSpec;
            lastToggleSpec = toggleSpec;
        }
        if (electronOwnsKeys)
        {
            capture = HotKeyRegistration.FromSuspended(CaptureId, captureSpec);
            toggle = HotKeyRegistration.FromSuspended(ToggleId, toggleSpec);
        }
        else
        {
            capture = Register(CaptureId, captureSpec);
            toggle = Register(ToggleId, toggleSpec);
        }
        RebuildMenu(configError);
        WriteHelperState(configError);
    }

    private HotKeyRegistration Register(int id, HotKeySpec spec)
    {
        if (!spec.Enabled)
            return HotKeyRegistration.Disabled(id, spec.Requested);
        if (!spec.Valid)
            return HotKeyRegistration.Invalid(id, spec.Requested, spec.Error);
        bool registered = NativeMethods.RegisterHotKey(
            window.Handle,
            id,
            spec.Modifiers | NativeMethods.ModNoRepeat,
            spec.VirtualKey);
        return new HotKeyRegistration(
            id,
            spec.Requested,
            registered,
            registered ? null : "The key is already owned by another application.",
            false);
    }

    private void Unregister(HotKeyRegistration registration)
    {
        if (registration != null && registration.Registered)
            NativeMethods.UnregisterHotKey(window.Handle, registration.Id);
    }

    private void RebuildMenu(string configError)
    {
        if (menu != null)
            menu.Dispose();
        menu = new ContextMenuStrip();
        menu.Items.Add("Open OpenCapture", null, delegate { Launch("toggle"); });
        menu.Items.Add("Capture", null, delegate { Launch("capture"); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(StatusText("Open", toggle)).Enabled = false;
        menu.Items.Add(StatusText("Capture", capture)).Enabled = false;
        if (!String.IsNullOrEmpty(configError))
            menu.Items.Add("Config: " + configError).Enabled = false;
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit Quick Launch", null, delegate { ExitThread(); });
        notifyIcon.ContextMenuStrip = menu;
    }

    private static string StatusText(string action, HotKeyRegistration registration)
    {
        if (registration.Suspended)
            return action + ": Electron owns " + registration.Requested;
        if (!registration.Registered)
            return action + ": " + registration.Requested +
                (String.IsNullOrEmpty(registration.Error) ? " (disabled)" : " (" + registration.Error + ")");
        return action + ": " + registration.Requested;
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
            Launch("toggle");
        else if (id == CaptureId)
            Launch("capture");
    }

    private void Launch(string action)
    {
        string error;
        int ignoredPid;
        if (!QuickLaunch.DispatchSibling(action, userDataPath, null, out error, out ignoredPid))
        {
            MessageBox.Show("Could not start OpenCapture.\r\n\r\n" + error,
                "OpenCapture Quick Launch", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    internal static string SiblingExecutable()
    {
        return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "OpenCapture.exe");
    }

    private void WriteReadyDiagnostics()
    {
        if (String.IsNullOrEmpty(diagnosticsPath))
            return;
        Process process = Process.GetCurrentProcess();
        process.Refresh();
        string json = "{\"ready\":true,\"physicalKeyTested\":false,\"pid\":" +
            process.Id.ToString(CultureInfo.InvariantCulture)
            + ",\"userData\":" + QuickLaunch.JsonString(userDataPath)
            + ",\"configPath\":" + QuickLaunch.JsonString(configPath)
            + ",\"owner\":" + QuickLaunch.JsonString(electronOwnsKeys ? "electron" : "helper")
            + ",\"toggle\":" + toggle.ToJson() + ",\"capture\":" + capture.ToJson()
            + ",\"workingSetBytes\":" + process.WorkingSet64.ToString(CultureInfo.InvariantCulture)
            + ",\"privateMemoryBytes\":" + process.PrivateMemorySize64.ToString(CultureInfo.InvariantCulture)
            + ",\"startupMs\":" + startupTimer.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture) + "}";
        QuickLaunch.WriteDiagnostics(diagnosticsPath, json);
    }

    private void WriteHelperState(string configError)
    {
        string json = "{\"version\":1,\"pid\":" +
            Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture)
            + ",\"owner\":" + QuickLaunch.JsonString(electronOwnsKeys ? "electron" : "helper")
            + ",\"registered\":" + QuickLaunch.JsonBoolean(capture.Registered || toggle.Registered)
            + ",\"keys\":{\"capture\":" + QuickLaunch.JsonString(capture.Requested)
            + ",\"toggle\":" + QuickLaunch.JsonString(toggle.Requested) + "}"
            + ",\"capture\":" + capture.ToJson() + ",\"toggle\":" + toggle.ToJson()
            + ",\"configError\":" + QuickLaunch.JsonString(configError)
            + ",\"updatedAt\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)
            + "}";
        try
        {
            QuickLaunch.WriteAtomic(helperStatePath, json);
        }
        catch (Exception)
        {
        }
    }

    private static string FileFingerprint(string path)
    {
        try
        {
            FileInfo info = new FileInfo(path);
            return info.Exists
                ? info.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture) + ":" +
                    info.Length.ToString(CultureInfo.InvariantCulture)
                : "missing";
        }
        catch (Exception)
        {
            return "error";
        }
    }

    private static bool LiveElectronClaim(string path, bool allowTestOwner)
    {
        try
        {
            if (!File.Exists(path))
                return false;
            if (new FileInfo(path).Length > 64 * 1024)
                return false;
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            IDictionary<string, object> value =
                serializer.DeserializeObject(File.ReadAllText(path, Encoding.UTF8))
                as IDictionary<string, object>;
            if (value == null || !String.Equals(Convert.ToString(value["mode"], CultureInfo.InvariantCulture),
                "electron", StringComparison.OrdinalIgnoreCase))
                return false;
            int pid = Convert.ToInt32(value["pid"], CultureInfo.InvariantCulture);
            using (Process process = Process.GetProcessById(pid))
            {
                if (process.HasExited)
                    return false;
                if (allowTestOwner)
                    return true;
                string name = process.ProcessName;
                return String.Equals(name, "OpenCapture", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(name, "electron", StringComparison.OrdinalIgnoreCase);
            }
        }
        catch (Exception)
        {
            return false;
        }
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
        refreshTimer.Stop();
        refreshTimer.Dispose();
        Unregister(toggle);
        Unregister(capture);
        notifyIcon.Visible = false;
        notifyIcon.Dispose();
        if (menu != null)
            menu.Dispose();
        window.Dispose();
        if (ownedIcon != null)
            ownedIcon.Dispose();
        try
        {
            if (File.Exists(helperStatePath))
                File.Delete(helperStatePath);
        }
        catch (Exception)
        {
        }
    }
}

internal static class HotKeyConfiguration
{
    internal static bool Load(
        string userDataPath,
        out HotKeySpec capture,
        out HotKeySpec toggle,
        out string error)
    {
        string captureText = QuickLaunch.DefaultCaptureKey;
        string toggleText = QuickLaunch.DefaultToggleKey;
        error = null;
        string path = Path.Combine(userDataPath, "config.json");
        bool loaded = true;
        try
        {
            if (File.Exists(path))
            {
                if (new FileInfo(path).Length > 2 * 1024 * 1024)
                    throw new InvalidDataException("config.json is too large.");
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                IDictionary<string, object> root =
                    serializer.DeserializeObject(File.ReadAllText(path, Encoding.UTF8))
                    as IDictionary<string, object>;
                object customValue;
                if (root != null && root.TryGetValue("起始页快捷键", out customValue))
                {
                    IDictionary<string, object> custom = customValue as IDictionary<string, object>;
                    object value;
                    if (custom != null && custom.TryGetValue("capture", out value))
                        captureText = Convert.ToString(value, CultureInfo.InvariantCulture);
                    if (custom != null && custom.TryGetValue("toggle", out value))
                        toggleText = Convert.ToString(value, CultureInfo.InvariantCulture);
                }
            }
        }
        catch (Exception exception)
        {
            error = "Invalid config.json: " + exception.Message;
            loaded = false;
        }

        string captureError;
        string toggleError;
        HotKeySpec.TryParse(captureText, out capture, out captureError);
        HotKeySpec.TryParse(toggleText, out toggle, out toggleError);
        if (String.IsNullOrEmpty(error))
            error = JoinErrors(captureError, toggleError);
        return loaded;
    }

    private static string JoinErrors(string first, string second)
    {
        if (String.IsNullOrEmpty(first))
            return second;
        if (String.IsNullOrEmpty(second))
            return first;
        return first + "; " + second;
    }
}

internal sealed class HotKeySpec
{
    internal readonly string Requested;
    internal readonly uint Modifiers;
    internal readonly uint VirtualKey;
    internal readonly bool Enabled;
    internal readonly bool Valid;
    internal readonly string Error;

    private HotKeySpec(string requested, uint modifiers, uint virtualKey, bool enabled, bool valid, string error)
    {
        Requested = requested ?? "";
        Modifiers = modifiers;
        VirtualKey = virtualKey;
        Enabled = enabled;
        Valid = valid;
        Error = error;
    }

    internal static bool TryParse(string value, out HotKeySpec spec, out string error)
    {
        string requested = value == null ? "" : value.Trim();
        if (requested.Length == 0)
        {
            spec = new HotKeySpec(requested, 0, 0, false, true, null);
            error = null;
            return true;
        }

        uint modifiers = 0;
        uint virtualKey = 0;
        string[] parts = requested.Split(new[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string rawPart in parts)
        {
            string part = rawPart.Trim();
            string normalized = part.ToLowerInvariant();
            if (normalized == "ctrl" || normalized == "control" || normalized == "commandorcontrol")
                modifiers |= NativeMethods.ModControl;
            else if (normalized == "shift")
                modifiers |= NativeMethods.ModShift;
            else if (normalized == "alt" || normalized == "option")
                modifiers |= NativeMethods.ModAlt;
            else if (normalized == "meta" || normalized == "super" ||
                normalized == "win" || normalized == "windows" || normalized == "command")
                modifiers |= NativeMethods.ModWin;
            else
            {
                uint parsedKey;
                if (virtualKey != 0 || !TryVirtualKey(part, out parsedKey))
                {
                    error = "Unsupported accelerator: " + requested;
                    spec = new HotKeySpec(requested, 0, 0, true, false, error);
                    return false;
                }
                virtualKey = parsedKey;
            }
        }
        if (virtualKey == 0)
        {
            error = "Accelerator has no key: " + requested;
            spec = new HotKeySpec(requested, 0, 0, true, false, error);
            return false;
        }
        spec = new HotKeySpec(requested, modifiers, virtualKey, true, true, null);
        error = null;
        return true;
    }

    private static bool TryVirtualKey(string value, out uint key)
    {
        key = 0;
        if (value.Length == 1)
        {
            char character = Char.ToUpperInvariant(value[0]);
            if ((character >= 'A' && character <= 'Z') ||
                (character >= '0' && character <= '9'))
            {
                key = character;
                return true;
            }
        }
        string normalized = value.Replace(" ", "").Replace("-", "");
        Keys parsed;
        if (Enum.TryParse<Keys>(normalized, true, out parsed))
        {
            key = (uint)parsed;
            return true;
        }
        Dictionary<string, Keys> aliases = new Dictionary<string, Keys>(StringComparer.OrdinalIgnoreCase) {
            { "Plus", Keys.Oemplus }, { "Minus", Keys.OemMinus },
            { "Comma", Keys.Oemcomma }, { "Period", Keys.OemPeriod },
            { "Slash", Keys.OemQuestion }, { "Backslash", Keys.OemPipe },
            { "Semicolon", Keys.OemSemicolon }, { "Quote", Keys.OemQuotes },
            { "BracketLeft", Keys.OemOpenBrackets }, { "BracketRight", Keys.OemCloseBrackets }
        };
        if (aliases.TryGetValue(value, out parsed))
        {
            key = (uint)parsed;
            return true;
        }
        return false;
    }

    internal string ToJson()
    {
        return "{\"requested\":" + QuickLaunch.JsonString(Requested)
            + ",\"enabled\":" + QuickLaunch.JsonBoolean(Enabled)
            + ",\"valid\":" + QuickLaunch.JsonBoolean(Valid)
            + ",\"error\":" + QuickLaunch.JsonString(Error) + "}";
    }
}

internal sealed class HotKeyRegistration
{
    internal readonly int Id;
    internal readonly string Requested;
    internal readonly bool Registered;
    internal readonly string Error;
    internal readonly bool Suspended;

    internal HotKeyRegistration(int id, string requested, bool registered, string error, bool suspended)
    {
        Id = id;
        Requested = requested ?? "";
        Registered = registered;
        Error = error;
        Suspended = suspended;
    }

    internal static HotKeyRegistration Disabled(int id, string requested)
    {
        return new HotKeyRegistration(id, requested, false, null, false);
    }

    internal static HotKeyRegistration Invalid(int id, string requested, string error)
    {
        return new HotKeyRegistration(id, requested, false, error, false);
    }

    internal static HotKeyRegistration FromSuspended(int id, HotKeySpec spec)
    {
        return new HotKeyRegistration(id, spec.Requested, false, "Electron owns this key.", true);
    }

    internal string ToJson()
    {
        return "{\"requested\":" + QuickLaunch.JsonString(Requested)
            + ",\"registered\":" + QuickLaunch.JsonBoolean(Registered)
            + ",\"suspended\":" + QuickLaunch.JsonBoolean(Suspended)
            + ",\"error\":" + QuickLaunch.JsonString(Error) + "}";
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
    internal const uint ModWin = 0x0008;
    internal const uint ModNoRepeat = 0x4000;

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint virtualKey);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool UnregisterHotKey(IntPtr window, int id);
}
