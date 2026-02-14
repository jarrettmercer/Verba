namespace MercerVoice.Services;

public interface IDictationService : IDisposable
{
    DictationState State { get; }
    string? LastTranscription { get; }
    string? LastError { get; }
    event Action<DictationState>? StateChanged;
    event Action<string>? TranscriptionCompleted;
    event Action<float>? AudioLevelChanged;
}
