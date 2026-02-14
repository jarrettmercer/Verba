namespace MercerVoice.Services;

public interface ISpeechRecognitionService : IDisposable
{
    bool IsConfigured { get; }
    Task StartRecognitionAsync(CancellationToken cancellationToken = default);
    Task<string?> StopRecognitionAndGetResultAsync(CancellationToken cancellationToken = default);
}
