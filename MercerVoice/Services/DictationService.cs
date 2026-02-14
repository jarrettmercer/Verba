using Microsoft.Extensions.Logging;

namespace MercerVoice.Services;

public class DictationService : IDictationService
{
    private readonly HotkeyService _hotkeyService;
    private readonly ISpeechRecognitionService _speechService;
    private readonly ITextInputService _textInputService;
    private readonly IAudioRecorderService _audioRecorder;
    private readonly ILogger<DictationService> _logger;

    private DictationState _state = DictationState.Idle;
    public DictationState State
    {
        get => _state;
        private set
        {
            if (_state != value)
            {
                _state = value;
                StateChanged?.Invoke(value);
            }
        }
    }

    public string? LastTranscription { get; private set; }
    public string? LastError { get; private set; }

    public event Action<DictationState>? StateChanged;
    public event Action<string>? TranscriptionCompleted;
    public event Action<float>? AudioLevelChanged;

    public DictationService(
        HotkeyService hotkeyService,
        ISpeechRecognitionService speechService,
        ITextInputService textInputService,
        IAudioRecorderService audioRecorder,
        ILogger<DictationService> logger)
    {
        _hotkeyService = hotkeyService;
        _speechService = speechService;
        _textInputService = textInputService;
        _audioRecorder = audioRecorder;
        _logger = logger;

        _hotkeyService.HotkeyPressed += OnHotkeyPressed;
        _hotkeyService.HotkeyReleased += OnHotkeyReleased;
        _audioRecorder.AudioLevelChanged += level => AudioLevelChanged?.Invoke(level);

        _hotkeyService.Start();
    }

    private async void OnHotkeyPressed()
    {
        if (State != DictationState.Idle) return;

        try
        {
            State = DictationState.Recording;
            LastError = null;
            await _speechService.StartRecognitionAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to start recording");
            LastError = ex.Message;
            State = DictationState.Error;
            _ = ResetToIdleAfterDelay(3000);
        }
    }

    private async void OnHotkeyReleased()
    {
        if (State != DictationState.Recording) return;

        try
        {
            State = DictationState.Transcribing;
            var text = await _speechService.StopRecognitionAndGetResultAsync();

            if (!string.IsNullOrWhiteSpace(text))
            {
                LastTranscription = text;
                State = DictationState.Typing;
                await _textInputService.TypeTextAsync(text);
                TranscriptionCompleted?.Invoke(text);
            }

            State = DictationState.Idle;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed during transcription/typing");
            LastError = ex.Message;
            State = DictationState.Error;
            _ = ResetToIdleAfterDelay(3000);
        }
    }

    private async Task ResetToIdleAfterDelay(int ms)
    {
        await Task.Delay(ms);
        if (State == DictationState.Error)
            State = DictationState.Idle;
    }

    public void Dispose()
    {
        _hotkeyService.HotkeyPressed -= OnHotkeyPressed;
        _hotkeyService.HotkeyReleased -= OnHotkeyReleased;
    }
}
