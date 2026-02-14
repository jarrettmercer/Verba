using AudioToolbox;
using AVFoundation;
using Foundation;
using Microsoft.Extensions.Logging;

namespace MercerVoice.Services;

public class MacAudioRecorderService : IAudioRecorderService
{
    private readonly ILogger<MacAudioRecorderService> _logger;
    private AVAudioRecorder? _recorder;
    private string? _currentFilePath;
    private NSTimer? _meteringTimer;

    public bool IsRecording => _recorder?.Recording ?? false;
    public event Action<float>? AudioLevelChanged;

    public MacAudioRecorderService(ILogger<MacAudioRecorderService> logger)
    {
        _logger = logger;
    }

    public async Task StartRecordingAsync()
    {
        // Ensure microphone permission is granted before recording
        var permission = AVAudioApplication.SharedInstance.RecordPermission;
        _logger.LogInformation("Microphone permission status: {Status}", permission);

        if (permission == AVAudioApplicationRecordPermission.Undetermined)
        {
            var granted = await AVAudioApplication.RequestRecordPermissionAsync();
            _logger.LogInformation("Microphone permission request result: {Granted}", granted);
            if (!granted)
                throw new InvalidOperationException("Microphone permission denied.");
        }
        else if (permission == AVAudioApplicationRecordPermission.Denied)
        {
            throw new InvalidOperationException("Microphone permission denied. Grant access in System Settings > Privacy & Security > Microphone.");
        }

        await MainThread.InvokeOnMainThreadAsync(() =>
        {
            var audioSession = AVAudioSession.SharedInstance();
            audioSession.SetCategory(AVAudioSessionCategory.PlayAndRecord.GetConstant()!, out var sessionError);
            if (sessionError is not null)
            {
                _logger.LogError("Audio session category error: {Error}", sessionError.LocalizedDescription);
                throw new InvalidOperationException($"Audio session error: {sessionError.LocalizedDescription}");
            }

            audioSession.SetActive(true, out sessionError);
            if (sessionError is not null)
            {
                _logger.LogError("Audio session activation error: {Error}", sessionError.LocalizedDescription);
                throw new InvalidOperationException($"Audio session activation error: {sessionError.LocalizedDescription}");
            }

            _currentFilePath = Path.Combine(Path.GetTempPath(), $"mercervoice_{Guid.NewGuid():N}.wav");
            var url = NSUrl.FromFilename(_currentFilePath);

            var settings = new AudioSettings
            {
                Format = AudioFormatType.LinearPCM,
                SampleRate = 16000,
                NumberChannels = 1,
                LinearPcmBitDepth = 16,
                LinearPcmFloat = false,
                LinearPcmBigEndian = false,
            };

            _recorder = AVAudioRecorder.Create(url, settings, out var recorderError);
            if (recorderError is not null || _recorder is null)
            {
                _logger.LogError("Recorder creation error: {Error}", recorderError?.LocalizedDescription);
                throw new InvalidOperationException($"Recorder creation error: {recorderError?.LocalizedDescription}");
            }

            _recorder.MeteringEnabled = true;
            _recorder.PrepareToRecord();
            _recorder.Record();
            _logger.LogInformation("Recording started: {Path}", _currentFilePath);

            _meteringTimer = NSTimer.CreateRepeatingScheduledTimer(1.0 / 30.0, _ =>
            {
                if (_recorder is null || !_recorder.Recording) return;
                _recorder.UpdateMeters();
                var dB = _recorder.AveragePower(0);
                var normalized = Math.Clamp((dB + 50f) / 50f, 0f, 1f);
                AudioLevelChanged?.Invoke(normalized);
            });
        });
    }

    public async Task<string?> StopRecordingAsync()
    {
        string? filePath = null;

        await MainThread.InvokeOnMainThreadAsync(() =>
        {
            if (_recorder is null || !_recorder.Recording)
            {
                _logger.LogWarning("StopRecording called but not recording.");
                return;
            }

            _meteringTimer?.Invalidate();
            _meteringTimer = null;

            _recorder.Stop();
            _logger.LogInformation("Recording stopped.");

            filePath = _currentFilePath;

            _recorder.Dispose();
            _recorder = null;
        });

        return filePath;
    }

    public void Dispose()
    {
        _meteringTimer?.Invalidate();
        _meteringTimer = null;
        _recorder?.Stop();
        _recorder?.Dispose();
        _recorder = null;
    }
}
