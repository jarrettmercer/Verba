using Microsoft.Extensions.Logging;
using SharpHook;
using SharpHook.Data;

namespace MercerVoice.Services;

public enum HotkeyServiceStatus
{
    Starting,
    Active,
    Failed,
    Stopped
}

public class HotkeyService : IDisposable
{
    private readonly ILogger<HotkeyService> _logger;
    private TaskPoolGlobalHook? _hook;
    private bool _started;

    private bool _hotkeyActive;

    private HotkeyServiceStatus _status = HotkeyServiceStatus.Starting;
    private string? _statusError;

    public HotkeyServiceStatus Status => _status;
    public string? StatusError => _statusError;

    public event Action? HotkeyPressed;
    public event Action? HotkeyReleased;
    public event Action<HotkeyServiceStatus>? StatusChanged;

    public HotkeyService(ILogger<HotkeyService> logger)
    {
        _logger = logger;
    }

    private void SetStatus(HotkeyServiceStatus status, string? error = null)
    {
        _status = status;
        _statusError = error;
        StatusChanged?.Invoke(status);
    }

    public void Start()
    {
        if (_started) return;
        _started = true;

        _ = Task.Run(RunHookAsync);
    }

    private async Task RunHookAsync()
    {
        _logger.LogInformation("HotkeyService starting. Listening for Right Command...");

        _hook = new TaskPoolGlobalHook();
        _hook.KeyPressed += OnKeyPressed;
        _hook.KeyReleased += OnKeyReleased;

        try
        {
            var hookTask = _hook.RunAsync();

            // If RunAsync faults within 500ms, the hook failed to start
            // (e.g. missing Input Monitoring permission). Otherwise it's running.
            var completed = await Task.WhenAny(hookTask, Task.Delay(500));

            if (completed == hookTask)
            {
                await hookTask; // Re-throw any exception
            }

            SetStatus(HotkeyServiceStatus.Active);
            _logger.LogInformation("HotkeyService hook is active.");

            await hookTask;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "HotkeyService encountered an error");
            SetStatus(HotkeyServiceStatus.Failed, ex.Message);
        }
    }

    private void OnKeyPressed(object? sender, KeyboardHookEventArgs e)
    {
        _logger.LogDebug("Key pressed: {KeyCode} ({RawCode})", e.Data.KeyCode, e.Data.RawCode);

        if (e.Data.KeyCode == KeyCode.VcRightMeta && !_hotkeyActive)
        {
            _hotkeyActive = true;
            _logger.LogInformation("Hotkey triggered: Right Command (down)");
            HotkeyPressed?.Invoke();
        }
    }

    private void OnKeyReleased(object? sender, KeyboardHookEventArgs e)
    {
        if (e.Data.KeyCode == KeyCode.VcRightMeta && _hotkeyActive)
        {
            _hotkeyActive = false;
            _logger.LogInformation("Hotkey released: Right Command (up)");
            HotkeyReleased?.Invoke();
        }
    }

    public void Dispose()
    {
        _hook?.Dispose();
    }
}
