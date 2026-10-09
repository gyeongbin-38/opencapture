// OpenCapture is distributed under GPL-3.0. See the repository LICENSE file.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class NativeCapture
{
    private const int ReceiptVersion = 1;
    private const int MaximumSettingsBytes = 16 * 1024;
    private const int MaximumLegacyLibraryBytes = 16 * 1024 * 1024;
    private const long MaximumVirtualPixels = 80000000;

    internal static void EnableDpiAwareness()
    {
        try
        {
            if (CaptureNativeMethods.SetProcessDpiAwarenessContext(new IntPtr(-4)))
                return;
        }
        catch (EntryPointNotFoundException)
        {
        }
        CaptureNativeMethods.SetProcessDPIAware();
    }

    internal static CaptureOverlay BeginCapture(Action<CaptureResult> completed)
    {
        Bitmap desktop = null;
        try
        {
            Rectangle bounds = SystemInformation.VirtualScreen;
            if (bounds.Width < 1 || bounds.Height < 1)
                throw new InvalidOperationException("The current desktop has no capturable area.");
            if ((long)bounds.Width * bounds.Height > MaximumVirtualPixels)
                throw new InvalidOperationException("The virtual desktop is too large to capture safely (80 million pixel limit).");
            desktop = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
            using (Graphics graphics = Graphics.FromImage(desktop))
                graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
            if (IsAllBlack(desktop))
                throw new InvalidOperationException("The current desktop is inaccessible; the captured frame was entirely black.");

            CaptureOverlay overlay = new CaptureOverlay(desktop, bounds, delegate(Bitmap selection) {
                if (selection == null)
                {
                    completed(CaptureResult.Cancel());
                    return;
                }
                try
                {
                    CaptureSettings settings = LoadSettings();
                    completed(PersistCapturedBitmap(selection, settings.Folder, InboxFolder(), settings.NeedsWorkflow));
                }
                catch (Exception exception)
                {
                    completed(CaptureResult.Failure(exception.Message));
                }
                finally
                {
                    selection.Dispose();
                }
            });
            desktop = null;
            overlay.Show();
            overlay.Activate();
            return overlay;
        }
        catch (Exception exception)
        {
            if (desktop != null)
                desktop.Dispose();
            completed(CaptureResult.Failure(exception.Message));
            return null;
        }
    }

    internal static Rectangle NormalizeSelection(Point start, Point end, Rectangle bounds)
    {
        int startX = Math.Max(bounds.Left, Math.Min(bounds.Right, start.X));
        int startY = Math.Max(bounds.Top, Math.Min(bounds.Bottom, start.Y));
        int endX = Math.Max(bounds.Left, Math.Min(bounds.Right, end.X));
        int endY = Math.Max(bounds.Top, Math.Min(bounds.Bottom, end.Y));
        return Rectangle.FromLTRB(Math.Min(startX, endX), Math.Min(startY, endY),
            Math.Max(startX, endX), Math.Max(startY, endY));
    }

    internal static int RunSelfTest(string diagnosticsPath)
    {
        string root = Path.Combine(Path.GetTempPath(), "OpenCaptureQuick-capture-test-" + Guid.NewGuid().ToString("N"));
        bool normalizationPassed = false;
        bool blackDetectionPassed = false;
        bool uniqueNamesPassed = false;
        bool receiptsPassed = false;
        bool receiptFailurePreserved = false;
        bool warningHasLastPath = false;
        bool workflowSuppressedWithoutReceipt = false;
        string error = null;
        try
        {
            Rectangle reversed = NormalizeSelection(new Point(90, 80), new Point(10, 20), new Rectangle(0, 0, 100, 100));
            Rectangle clamped = NormalizeSelection(new Point(-10, 5), new Point(120, 200), new Rectangle(0, 0, 100, 100));
            normalizationPassed = reversed == new Rectangle(10, 20, 80, 60)
                && clamped == new Rectangle(0, 5, 100, 95);

            string captures = Path.Combine(root, "captures");
            string inbox = Path.Combine(root, "inbox");
            using (Bitmap synthetic = new Bitmap(8, 6, PixelFormat.Format32bppArgb))
            using (Graphics graphics = Graphics.FromImage(synthetic))
            {
                graphics.Clear(Color.Black);
                bool blackDetected = IsAllBlack(synthetic);
                graphics.Clear(Color.CornflowerBlue);
                blackDetectionPassed = blackDetected && !IsAllBlack(synthetic);
                CaptureReceipt first = SaveCapturedBitmap(synthetic, captures, inbox);
                CaptureReceipt second = SaveCapturedBitmap(synthetic, captures, inbox);
                uniqueNamesPassed = first.Path != second.Path && File.Exists(first.Path) && File.Exists(second.Path);
                receiptsPassed = ValidateReceipt(first.ReceiptPath, first.Path) && ValidateReceipt(second.ReceiptPath, second.Path)
                    && Directory.GetFiles(inbox, "*.tmp").Length == 0;

                string blockedInbox = Path.Combine(root, "blocked-inbox");
                File.WriteAllText(blockedInbox, "This file intentionally blocks directory creation.");
                CaptureResult partial = PersistCapturedBitmap(synthetic, captures, blockedInbox, true);
                receiptFailurePreserved = partial.Success && File.Exists(partial.SavedPath);
                warningHasLastPath = !String.IsNullOrEmpty(partial.Warning) && !String.IsNullOrEmpty(partial.SavedPath);
                workflowSuppressedWithoutReceipt = !partial.NeedsWorkflow;
            }
        }
        catch (Exception exception)
        {
            error = exception.ToString();
        }
        finally
        {
            try
            {
                if (Directory.Exists(root) && IsSafeSelfTestDirectory(root))
                    Directory.Delete(root, true);
                else if (Directory.Exists(root))
                    throw new InvalidOperationException("Refused to remove an unexpected self-test directory.");
            }
            catch (Exception cleanupException)
            {
                if (error == null)
                    error = cleanupException.ToString();
            }
        }

        bool success = normalizationPassed && blackDetectionPassed && uniqueNamesPassed && receiptsPassed
            && receiptFailurePreserved && warningHasLastPath && workflowSuppressedWithoutReceipt && error == null;
        string json = "{\"captureSelfTest\":true,\"desktopCaptured\":false,\"hotkeysRegistered\":false"
            + ",\"normalizationPassed\":" + QuickLaunch.JsonBoolean(normalizationPassed)
            + ",\"blackDetectionPassed\":" + QuickLaunch.JsonBoolean(blackDetectionPassed)
            + ",\"uniqueNamesPassed\":" + QuickLaunch.JsonBoolean(uniqueNamesPassed)
            + ",\"receiptsPassed\":" + QuickLaunch.JsonBoolean(receiptsPassed)
            + ",\"receiptFailurePreserved\":" + QuickLaunch.JsonBoolean(receiptFailurePreserved)
            + ",\"warningHasLastPath\":" + QuickLaunch.JsonBoolean(warningHasLastPath)
            + ",\"workflowSuppressedWithoutReceipt\":" + QuickLaunch.JsonBoolean(workflowSuppressedWithoutReceipt)
            + ",\"error\":" + QuickLaunch.JsonString(error) + "}";
        QuickLaunch.WriteDiagnostics(diagnosticsPath, json);
        return success ? 0 : 1;
    }

    private static CaptureSettings LoadSettings()
    {
        string fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "OpenCapture");
        string folder = fallback;
        bool needsWorkflow = false;
        try
        {
            CaptureSettings configured;
            if (TryReadSettingsSnapshot(out configured) || TryReadLegacyLibrary(out configured))
            {
                folder = configured.Folder;
                needsWorkflow = configured.NeedsWorkflow;
            }
            Directory.CreateDirectory(folder);
        }
        catch (Exception)
        {
            folder = fallback;
            Directory.CreateDirectory(folder);
        }
        return new CaptureSettings(folder, needsWorkflow);
    }

    private static bool TryReadSettingsSnapshot(out CaptureSettings settings)
    {
        settings = null;
        string path = Path.Combine(OpenCaptureDataFolder(), "capture-settings.json");
        if (!File.Exists(path))
            return false;
        FileInfo file = new FileInfo(path);
        if (file.Length < 1 || file.Length > MaximumSettingsBytes)
            return false;
        try
        {
            Dictionary<string, object> value = DeserializeDictionary(path, MaximumSettingsBytes);
            object versionValue;
            if (value == null || !value.TryGetValue("version", out versionValue)
                || Convert.ToInt32(versionValue, CultureInfo.InvariantCulture) != 1)
                return false;
            string folder = ValueAsString(value, "folder");
            if (String.IsNullOrWhiteSpace(folder) || !Path.IsPathRooted(folder))
                return false;
            object workflowValue;
            Dictionary<string, object> workflow = value.TryGetValue("workflow", out workflowValue)
                ? workflowValue as Dictionary<string, object> : null;
            bool needsWorkflow = BooleanValue(workflow, "autoRemoveBackground")
                || BooleanValue(workflow, "autoCopy") || BooleanValue(workflow, "autoPin");
            settings = new CaptureSettings(Path.GetFullPath(folder), needsWorkflow);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static bool TryReadLegacyLibrary(out CaptureSettings settings)
    {
        settings = null;
        string path = Path.Combine(OpenCaptureDataFolder(), "library.json");
        if (!File.Exists(path))
            return false;
        FileInfo file = new FileInfo(path);
        if (file.Length < 1 || file.Length > MaximumLegacyLibraryBytes)
            return false;
        try
        {
            Dictionary<string, object> library = DeserializeDictionary(path, MaximumLegacyLibraryBytes);
            if (library == null)
                return false;
            string activeId = ValueAsString(library, "activeCollectionId");
            string folder = null;
            object collectionsValue;
            IEnumerable collections = library.TryGetValue("collections", out collectionsValue)
                ? collectionsValue as IEnumerable : null;
            if (!String.IsNullOrEmpty(activeId) && collections != null)
            {
                foreach (object value in collections)
                {
                    Dictionary<string, object> collection = value as Dictionary<string, object>;
                    if (collection != null && String.Equals(ValueAsString(collection, "id"), activeId, StringComparison.Ordinal))
                    {
                        folder = ValueAsString(collection, "path");
                        break;
                    }
                }
            }
            if (String.IsNullOrWhiteSpace(folder) || !Path.IsPathRooted(folder))
                return false;
            object workflowValue;
            Dictionary<string, object> workflow = library.TryGetValue("workflow", out workflowValue)
                ? workflowValue as Dictionary<string, object> : null;
            bool needsWorkflow = BooleanValue(workflow, "autoRemoveBackground")
                || BooleanValue(workflow, "autoCopy") || BooleanValue(workflow, "autoPin");
            settings = new CaptureSettings(Path.GetFullPath(folder), needsWorkflow);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static Dictionary<string, object> DeserializeDictionary(string path, int maximumLength)
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        serializer.MaxJsonLength = maximumLength;
        return serializer.DeserializeObject(File.ReadAllText(path, Encoding.UTF8)) as Dictionary<string, object>;
    }

    private static string ValueAsString(Dictionary<string, object> dictionary, string key)
    {
        object value;
        return dictionary != null && dictionary.TryGetValue(key, out value) ? value as string : null;
    }

    private static bool BooleanValue(Dictionary<string, object> dictionary, string key)
    {
        object value;
        return dictionary != null && dictionary.TryGetValue(key, out value) && value is bool && (bool)value;
    }

    private static CaptureReceipt SaveCapturedBitmap(Bitmap bitmap, string folder, string inbox)
    {
        Directory.CreateDirectory(folder);
        string createdAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
        string imagePath = null;
        for (int attempt = 0; attempt < 10; attempt++)
        {
            string name = "OpenCapture-" + DateTime.Now.ToString("yyyy-MM-dd-HH-mm-ss-fff", CultureInfo.InvariantCulture)
                + "-" + Guid.NewGuid().ToString("N") + ".png";
            string candidate = Path.Combine(folder, name);
            try
            {
                using (FileStream stream = new FileStream(candidate, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    bitmap.Save(stream, ImageFormat.Png);
                imagePath = candidate;
                break;
            }
            catch (IOException)
            {
            }
        }
        if (imagePath == null)
            throw new IOException("Could not allocate a unique capture filename.");

        try
        {
            Directory.CreateDirectory(inbox);
            string receiptId = Guid.NewGuid().ToString("N");
            string receiptPath = Path.Combine(inbox, receiptId + ".json");
            string temporaryPath = Path.Combine(inbox, "." + receiptId + ".tmp");
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            string json = serializer.Serialize(new Dictionary<string, object> {
                { "version", ReceiptVersion },
                { "path", imagePath },
                { "createdAt", createdAt }
            });
            try
            {
                File.WriteAllText(temporaryPath, json, new UTF8Encoding(false));
                File.Move(temporaryPath, receiptPath);
            }
            finally
            {
                if (File.Exists(temporaryPath))
                    File.Delete(temporaryPath);
            }
            return new CaptureReceipt(imagePath, receiptPath);
        }
        catch (Exception exception)
        {
            throw new CaptureReceiptException(imagePath,
                "The PNG was saved, but OpenCapture could not register it for the library or enabled workflow.", exception);
        }
    }

    private static CaptureResult PersistCapturedBitmap(Bitmap bitmap, string folder, string inbox, bool needsWorkflow)
    {
        try
        {
            CaptureReceipt receipt = SaveCapturedBitmap(bitmap, folder, inbox);
            return CaptureResult.Saved(receipt.Path, needsWorkflow);
        }
        catch (CaptureReceiptException exception)
        {
            return CaptureResult.SavedWithWarning(exception.SavedPath, exception.Message);
        }
    }

    private static bool ValidateReceipt(string receiptPath, string expectedImagePath)
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        Dictionary<string, object> receipt = serializer.DeserializeObject(File.ReadAllText(receiptPath, Encoding.UTF8))
            as Dictionary<string, object>;
        if (receipt == null)
            return false;
        object version;
        object path;
        object createdAt;
        return receipt.TryGetValue("version", out version) && Convert.ToInt32(version, CultureInfo.InvariantCulture) == ReceiptVersion
            && receipt.TryGetValue("path", out path) && String.Equals(path as string, expectedImagePath, StringComparison.Ordinal)
            && receipt.TryGetValue("createdAt", out createdAt) && !String.IsNullOrEmpty(createdAt as string);
    }

    private static bool IsAllBlack(Bitmap bitmap)
    {
        Rectangle bounds = new Rectangle(Point.Empty, bitmap.Size);
        BitmapData data = bitmap.LockBits(bounds, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            byte[] row = new byte[Math.Abs(data.Stride)];
            for (int y = 0; y < data.Height; y++)
            {
                IntPtr address = IntPtr.Add(data.Scan0, y * data.Stride);
                Marshal.Copy(address, row, 0, row.Length);
                for (int x = 0; x < data.Width * 4; x += 4)
                    if (row[x] != 0 || row[x + 1] != 0 || row[x + 2] != 0)
                        return false;
            }
            return true;
        }
        finally
        {
            bitmap.UnlockBits(data);
        }
    }

    private static string OpenCaptureDataFolder()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "OpenCapture");
    }

    private static string InboxFolder()
    {
        return Path.Combine(OpenCaptureDataFolder(), "capture-inbox");
    }

    private static bool IsSafeSelfTestDirectory(string path)
    {
        string normalized = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string temporaryRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string parent = Path.GetDirectoryName(normalized);
        string name = Path.GetFileName(normalized);
        const string prefix = "OpenCaptureQuick-capture-test-";
        Guid id;
        return String.Equals(parent, temporaryRoot, StringComparison.OrdinalIgnoreCase)
            && name.StartsWith(prefix, StringComparison.Ordinal)
            && Guid.TryParseExact(name.Substring(prefix.Length), "N", out id);
    }

    private sealed class CaptureSettings
    {
        internal readonly string Folder;
        internal readonly bool NeedsWorkflow;
        internal CaptureSettings(string folder, bool needsWorkflow) { Folder = folder; NeedsWorkflow = needsWorkflow; }
    }

    private sealed class CaptureReceipt
    {
        internal readonly string Path;
        internal readonly string ReceiptPath;
        internal CaptureReceipt(string path, string receiptPath) { Path = path; ReceiptPath = receiptPath; }
    }
}

internal sealed class CaptureReceiptException : IOException
{
    internal readonly string SavedPath;

    internal CaptureReceiptException(string savedPath, string message, Exception innerException)
        : base(message, innerException)
    {
        SavedPath = savedPath;
    }
}

internal sealed class CaptureOverlay : Form
{
    private readonly Bitmap desktop;
    private readonly Action<Bitmap> completed;
    private Point dragStart;
    private Point dragCurrent;
    private bool dragging;
    private bool completionSent;

    internal CaptureOverlay(Bitmap desktop, Rectangle virtualBounds, Action<Bitmap> completed)
    {
        this.desktop = desktop;
        this.completed = completed;
        AutoScaleMode = AutoScaleMode.None;
        Bounds = virtualBounds;
        Cursor = Cursors.Cross;
        DoubleBuffered = true;
        FormBorderStyle = FormBorderStyle.None;
        KeyPreview = true;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
    }

    internal void CancelCapture()
    {
        Finish(null);
    }

    protected override bool ProcessCmdKey(ref Message message, Keys keyData)
    {
        if (keyData == Keys.Escape)
        {
            Finish(null);
            return true;
        }
        return base.ProcessCmdKey(ref message, keyData);
    }

    protected override void OnMouseDown(MouseEventArgs eventArgs)
    {
        base.OnMouseDown(eventArgs);
        if (eventArgs.Button != MouseButtons.Left)
            return;
        dragStart = ClampPoint(eventArgs.Location);
        dragCurrent = dragStart;
        dragging = true;
        Capture = true;
        Invalidate();
    }

    protected override void OnMouseMove(MouseEventArgs eventArgs)
    {
        base.OnMouseMove(eventArgs);
        if (!dragging)
            return;
        dragCurrent = ClampPoint(eventArgs.Location);
        Invalidate();
    }

    protected override void OnMouseUp(MouseEventArgs eventArgs)
    {
        base.OnMouseUp(eventArgs);
        if (!dragging || eventArgs.Button != MouseButtons.Left)
            return;
        Capture = false;
        dragging = false;
        dragCurrent = ClampPoint(eventArgs.Location);
        Rectangle selection = NativeCapture.NormalizeSelection(dragStart, dragCurrent, new Rectangle(Point.Empty, desktop.Size));
        if (selection.Width < 2 || selection.Height < 2)
        {
            Invalidate();
            return;
        }
        Hide();
        Bitmap selected = desktop.Clone(selection, PixelFormat.Format32bppArgb);
        Finish(selected);
    }

    protected override void OnPaint(PaintEventArgs eventArgs)
    {
        eventArgs.Graphics.DrawImageUnscaled(desktop, Point.Empty);
        using (Brush shade = new SolidBrush(Color.FromArgb(100, Color.Black)))
            eventArgs.Graphics.FillRectangle(shade, ClientRectangle);
        if (!dragging)
            return;
        Rectangle selection = NativeCapture.NormalizeSelection(dragStart, dragCurrent, new Rectangle(Point.Empty, desktop.Size));
        if (selection.Width < 1 || selection.Height < 1)
            return;
        eventArgs.Graphics.InterpolationMode = InterpolationMode.NearestNeighbor;
        eventArgs.Graphics.DrawImage(desktop, selection, selection, GraphicsUnit.Pixel);
        using (Pen border = new Pen(Color.White, 1))
            eventArgs.Graphics.DrawRectangle(border, selection.X, selection.Y, selection.Width - 1, selection.Height - 1);
    }

    protected override void OnFormClosed(FormClosedEventArgs eventArgs)
    {
        if (!completionSent)
            Finish(null);
        base.OnFormClosed(eventArgs);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
            desktop.Dispose();
        base.Dispose(disposing);
    }

    private Point ClampPoint(Point point)
    {
        return new Point(Math.Max(0, Math.Min(desktop.Width, point.X)), Math.Max(0, Math.Min(desktop.Height, point.Y)));
    }

    private void Finish(Bitmap selection)
    {
        if (completionSent)
        {
            if (selection != null)
                selection.Dispose();
            return;
        }
        completionSent = true;
        completed(selection);
        Close();
    }
}

internal sealed class CaptureResult
{
    internal readonly bool Success;
    internal readonly bool Cancelled;
    internal readonly string Error;
    internal readonly string SavedPath;
    internal readonly bool NeedsWorkflow;
    internal readonly string Warning;

    private CaptureResult(bool success, bool cancelled, string error, string savedPath, bool needsWorkflow, string warning)
    {
        Success = success;
        Cancelled = cancelled;
        Error = error;
        SavedPath = savedPath;
        NeedsWorkflow = needsWorkflow;
        Warning = warning;
    }

    internal static CaptureResult Cancel() { return new CaptureResult(false, true, null, null, false, null); }
    internal static CaptureResult Failure(string error) { return new CaptureResult(false, false, error, null, false, null); }
    internal static CaptureResult Saved(string path, bool workflow) { return new CaptureResult(true, false, null, path, workflow, null); }
    internal static CaptureResult SavedWithWarning(string path, string warning)
    {
        return new CaptureResult(true, false, null, path, false, warning);
    }
}

internal static class CaptureNativeMethods
{
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
}
