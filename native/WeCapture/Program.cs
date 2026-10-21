using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

// One bounded request per process. No desktop/monitor capture, shell commands or input injection.
internal static class Program
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };
    private const int MaximumPixels = 16_777_216;
    private sealed record Identity(string Handle, int ProcessId, string StartTime, string ProcessPath, string ClassName);
    private sealed record Request(string Operation, string WindowName = "", string InstallDir = "", Identity? Expected = null, string[]? Baseline = null, int TimeoutMs = 8000);
    private sealed class Failure(string code, string message) : Exception(message) { public string Code { get; } = code; }

    public static async Task Main()
    {
        try
        {
            if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041) || !Environment.Is64BitProcess)
                throw new Failure("CAPTURE_UNSUPPORTED", "Requires Windows build 19041+ and an x64 process.");
            // Physical frame dimensions must not be DPI virtualized.
            SetProcessDpiAwarenessContext(new nint(-4));
            if (GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) != 2)
                throw new Failure("DPI_AWARENESS_UNAVAILABLE", "Per-monitor DPI awareness could not be established.");
            var input = new StringBuilder();
            var buffer = new char[4096];
            int length;
            while ((length = await Console.In.ReadAsync(buffer)) > 0)
            {
                input.Append(buffer, 0, length);
                if (input.Length > 65536) throw new Failure("INVALID_REQUEST", "Request exceeds 64 KiB.");
            }
            var request = JsonSerializer.Deserialize<Request>(input.ToString(), Json) ?? throw new Failure("INVALID_REQUEST", "Missing request.");
            if (request.TimeoutMs < 100 || request.TimeoutMs > 30000) throw new Failure("INVALID_REQUEST", "Invalid timeout.");
            object result;
            if (request.Operation == "probe")
            {
                if (!GraphicsCaptureSession.IsSupported()) throw new Failure("CAPTURE_UNSUPPORTED", "Windows Graphics Capture is unavailable.");
                using var device = CaptureInterop.CreateDevice();
                result = new { status = "available", rendering = "unverified until an owned frame is captured", color = "SDR BGRA8; HDR fidelity unverified", maximumPixels = MaximumPixels };
            }
            else if (request.Operation == "baseline") result = new { handles = Windows().Select(h => h.ToInt64().ToString()).ToArray() };
            else
            {
                if (!Regex.IsMatch(request.WindowName, "^WE-MCP-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$") || !Path.IsPathFullyQualified(request.InstallDir))
                    throw new Failure("INVALID_REQUEST", "Requires a generated preview name and absolute engine directory.");
                result = request.Operation switch
                {
                    "find" => new { identity = await Find(request) },
                    "verify" => new { identity = Verify(request) },
                    "absent" => await WaitAbsent(request),
                    "capture" => await Capture(request),
                    _ => throw new Failure("INVALID_REQUEST", "Unknown operation.")
                };
            }
            Console.Write(JsonSerializer.Serialize(result, Json));
        }
        catch (Exception error)
        {
            var code = error is Failure failure ? failure.Code : error is TimeoutException ? "CAPTURE_TIMEOUT" : "CAPTURE_FAILED";
            Console.Write(JsonSerializer.Serialize(new { error = new { code, message = error.Message, hresult = $"0x{error.HResult:X8}" } }, Json));
        }
    }

    private static List<nint> Windows()
    {
        var result = new List<nint>();
        if (!EnumWindows((window, _) => { result.Add(window); return true; }, 0)) throw new Failure("WINDOW_ENUMERATION_FAILED", "EnumWindows failed.");
        return result;
    }

    private static string Text(nint window, bool className = false)
    {
        var text = new StringBuilder(512);
        if (className) GetClassName(window, text, text.Capacity); else GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    private static nint[] Matches(Request request) => Windows().Where(h => Text(h) == request.WindowName).ToArray();

    private static Identity Identify(nint window, Request request)
    {
        if (!IsWindow(window) || GetAncestor(window, 2) != window || window == GetDesktopWindow() || window == GetShellWindow())
            throw new Failure("WINDOW_IDENTITY_CHANGED", "Target is not an ordinary top-level preview window.");
        if (Text(window) != request.WindowName || GetWindowThreadProcessId(window, out var pid) == 0)
            throw new Failure("WINDOW_IDENTITY_CHANGED", "Preview title or process changed.");
        using var process = Process.GetProcessById(checked((int)pid));
        using var current = Process.GetCurrentProcess();
        var executable = process.MainModule?.FileName ?? throw new Failure("WINDOW_IDENTITY_UNAVAILABLE", "Cannot read window process path.");
        var allowed = new[] { "wallpaper32.exe", "wallpaper64.exe", "bin/webwallpaper32.exe", "bin/webwallpaper64.exe", "bin/edgewallpaper64.exe" };
        if (process.SessionId != current.SessionId || !allowed.Any(p => string.Equals(Path.GetFullPath(Path.Combine(request.InstallDir, p)), executable, StringComparison.OrdinalIgnoreCase)))
            throw new Failure("WINDOW_NOT_OWNED", "Window does not belong to the configured engine in this session.");
        // Refuse junction/symlink redirection anywhere in the executable path.
        for (var file = new FileInfo(executable) as FileSystemInfo; file != null; file = file is FileInfo f ? f.Directory : ((DirectoryInfo)file).Parent)
            if ((file.Attributes & FileAttributes.ReparsePoint) != 0) throw new Failure("WINDOW_NOT_OWNED", "Engine process path contains a reparse point.");
        var identity = new Identity(window.ToInt64().ToString(), process.Id, process.StartTime.ToUniversalTime().Ticks.ToString(), executable, Text(window, true));
        if (request.Expected is { } expected && identity != expected)
            throw new Failure("WINDOW_IDENTITY_CHANGED", "HWND, PID, process creation time, executable or window class changed.");
        return identity;
    }

    private static Identity Verify(Request request)
    {
        if (request.Expected == null) throw new Failure("INVALID_REQUEST", "A previously bound identity is required.");
        var matches = Matches(request);
        if (matches.Length != 1 || matches[0].ToInt64().ToString() != request.Expected.Handle)
            throw new Failure("WINDOW_IDENTITY_CHANGED", "Owned preview is missing, ambiguous or replaced.");
        return Identify(matches[0], request);
    }

    private static async Task<Identity> Find(Request request)
    {
        if (request.Baseline == null) throw new Failure("INVALID_REQUEST", "Pre-launch HWND baseline is required.");
        var timer = Stopwatch.StartNew();
        do
        {
            var matches = Matches(request);
            if (matches.Length > 1) throw new Failure("WINDOW_AMBIGUOUS", "More than one window has the preview name.");
            if (matches.Length == 1)
            {
                if (request.Baseline.Contains(matches[0].ToInt64().ToString())) throw new Failure("WINDOW_NOT_NEW", "HWND existed before this launch.");
                return Identify(matches[0], request);
            }
            await Task.Delay(100);
        } while (timer.ElapsedMilliseconds < request.TimeoutMs);
        throw new Failure("WINDOW_NOT_FOUND", "No owned preview window appeared before timeout.");
    }

    private static async Task<object> WaitAbsent(Request request)
    {
        var timer = Stopwatch.StartNew();
        do
        {
            if (Matches(request).Length == 0 && !StillHasExpectedWindow(request))
            {
                await Task.Delay(150);
                if (Matches(request).Length == 0 && !StillHasExpectedWindow(request)) return new { state = "window-absent" };
            }
            await Task.Delay(100);
        } while (timer.ElapsedMilliseconds < request.TimeoutMs);
        throw new Failure("WINDOW_CLOSE_TIMEOUT", "Preview name remains present; ownership record retained.");
    }

    private static bool StillHasExpectedWindow(Request request)
    {
        if (request.Expected is not { } expected) return false;
        var window = new nint(long.Parse(expected.Handle));
        if (!IsWindow(window)) return false;
        if (GetWindowThreadProcessId(window, out var pid) == 0) throw new Failure("WINDOW_IDENTITY_UNAVAILABLE", "Cannot check the previous HWND.");
        if (pid != expected.ProcessId) return false;
        using var process = Process.GetProcessById(checked((int)pid));
        // Renaming/hiding a still-live owned window must not be reported as a successful close.
        return process.StartTime.ToUniversalTime().Ticks.ToString() == expected.StartTime && Text(window, true) == expected.ClassName;
    }

    private static void CheckSize(int width, int height)
    {
        if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || (long)width * height > MaximumPixels)
            throw new Failure("CAPTURE_SIZE_LIMIT", "Frame must contain 1–16777216 pixels, with each dimension at most 8192.");
    }

    private static async Task<object> Capture(Request request)
    {
        var identity = Verify(request);
        var window = new nint(long.Parse(identity.Handle));
        if (!IsWindowVisible(window) || IsIconic(window)) throw new Failure("WINDOW_NOT_CAPTURABLE", "Preview is hidden or minimized.");
        if (!GraphicsCaptureSession.IsSupported()) throw new Failure("CAPTURE_UNSUPPORTED", "Windows Graphics Capture is unavailable.");
        using var device = CaptureInterop.CreateDevice();
        var item = CaptureInterop.CreateItem(window);
        Verify(request);
        var initialSize = item.Size;
        CheckSize(initialSize.Width, initialSize.Height);
        using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, initialSize);
        using var session = pool.CreateCaptureSession(item);
        session.IsCursorCaptureEnabled = false;
        // Keep the system capture border. Never broaden capture to a monitor on failure.
        var frameReady = new TaskCompletionSource<Direct3D11CaptureFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
        var gate = new object();
        bool stopped = false;
        void Arrived(Direct3D11CaptureFramePool sender, object _)
        {
            lock (gate)
            {
                if (stopped) return;
                try
                {
                    var frame = sender.TryGetNextFrame();
                    if (frame != null && !frameReady.TrySetResult(frame)) frame.Dispose();
                }
                catch (Exception error) { frameReady.TrySetException(error); }
            }
        }
        void Closed(GraphicsCaptureItem _, object __) => frameReady.TrySetException(new Failure("WINDOW_CLOSED", "Window closed during capture."));
        pool.FrameArrived += Arrived;
        item.Closed += Closed;
        Direct3D11CaptureFrame? captured = null;
        try
        {
            session.StartCapture();
            captured = await frameReady.Task.WaitAsync(TimeSpan.FromMilliseconds(request.TimeoutMs));
            CheckSize(captured.ContentSize.Width, captured.ContentSize.Height);
            if (captured.ContentSize != initialSize) throw new Failure("CAPTURE_SIZE_CHANGED", "Window resized during capture; retry with a stable window.");
            using var bitmap = await SoftwareBitmap.CreateCopyFromSurfaceAsync(captured.Surface);
            using var stream = new InMemoryRandomAccessStream();
            var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
            encoder.SetSoftwareBitmap(bitmap);
            await encoder.FlushAsync();
            if (stream.Size > 20 * 1024 * 1024) throw new Failure("CAPTURE_SIZE_LIMIT", "Encoded PNG exceeds 20 MiB.");
            stream.Seek(0);
            using var reader = new DataReader(stream);
            await reader.LoadAsync(checked((uint)stream.Size));
            var bytes = new byte[checked((int)stream.Size)];
            reader.ReadBytes(bytes);
            Verify(request);
            if (!IsWindowVisible(window) || IsIconic(window)) throw new Failure("WINDOW_NOT_CAPTURABLE", "Preview became hidden or minimized during capture.");
            return new { identity, width = captured.ContentSize.Width, height = captured.ContentSize.Height, dpi = GetDpiForWindow(window), timestampTicks = captured.SystemRelativeTime.Ticks.ToString(), color = "SDR BGRA8; HDR fidelity unverified", data = Convert.ToBase64String(bytes) };
        }
        finally
        {
            lock (gate) { stopped = true; }
            pool.FrameArrived -= Arrived;
            item.Closed -= Closed;
            // A frame can arrive concurrently with timeout. Dispose the unconsumed result too.
            if (captured == null && frameReady.Task.IsCompletedSuccessfully) captured = frameReady.Task.Result;
            captured?.Dispose();
        }
    }

    private delegate bool EnumCallback(nint window, nint parameter);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumCallback callback, nint parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(nint window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(nint window, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint processId);
    [DllImport("user32.dll")] private static extern nint GetAncestor(nint window, uint flags);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindow(nint window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsIconic(nint window);
    [DllImport("user32.dll")] private static extern nint GetDesktopWindow();
    [DllImport("user32.dll")] private static extern nint GetShellWindow();
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(nint context);
    [DllImport("user32.dll")] private static extern nint GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] private static extern int GetAwarenessFromDpiAwarenessContext(nint context);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(nint window);
}
