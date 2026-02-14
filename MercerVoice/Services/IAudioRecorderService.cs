namespace MercerVoice.Services;

public interface IAudioRecorderService : IDisposable
{
    bool IsRecording { get; }
    Task StartRecordingAsync();
    Task<string?> StopRecordingAsync();
    event Action<float>? AudioLevelChanged;
}
