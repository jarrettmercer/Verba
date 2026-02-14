using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace MercerVoice.Services;

public class SpeechRecognitionService : ISpeechRecognitionService
{
    private readonly ILogger<SpeechRecognitionService> _logger;
    private readonly IAudioRecorderService _audioRecorder;
    private readonly HttpClient _httpClient;
    private readonly string? _whisperEndpoint;
    private readonly string? _whisperApiKey;

    public bool IsConfigured { get; }

    public SpeechRecognitionService(
        IConfiguration config,
        IAudioRecorderService audioRecorder,
        ILogger<SpeechRecognitionService> logger)
    {
        _logger = logger;
        _audioRecorder = audioRecorder;
        _httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };

        _whisperEndpoint = config["Whisper:Endpoint"];
        _whisperApiKey = config["Whisper:ApiKey"];

        if (!string.IsNullOrEmpty(_whisperEndpoint) && !string.IsNullOrEmpty(_whisperApiKey))
        {
            IsConfigured = true;
            _logger.LogInformation("Whisper configured: {Endpoint}", _whisperEndpoint);
        }
        else
        {
            _logger.LogWarning("Whisper not configured. Set Whisper:Endpoint and Whisper:ApiKey in appsettings.json.");
        }
    }

    public async Task StartRecognitionAsync(CancellationToken cancellationToken = default)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("Whisper is not configured.");

        await _audioRecorder.StartRecordingAsync();
        _logger.LogInformation("Audio recording started for Whisper transcription.");
    }

    public async Task<string?> StopRecognitionAndGetResultAsync(CancellationToken cancellationToken = default)
    {
        var audioFilePath = await _audioRecorder.StopRecordingAsync();

        if (string.IsNullOrEmpty(audioFilePath) || !File.Exists(audioFilePath))
        {
            _logger.LogWarning("No audio file produced.");
            return null;
        }

        try
        {
            var fileInfo = new FileInfo(audioFilePath);
            _logger.LogInformation("Sending audio to Whisper ({Size} bytes)...", fileInfo.Length);

            if (fileInfo.Length < 1000)
            {
                _logger.LogWarning("Audio file too small ({Size} bytes), likely no speech captured.", fileInfo.Length);
                return null;
            }

            var result = await TranscribeWithWhisperAsync(audioFilePath, cancellationToken);
            return result;
        }
        finally
        {
            // Clean up temp file
            try { File.Delete(audioFilePath); }
            catch { /* ignore cleanup errors */ }
        }
    }

    private async Task<string?> TranscribeWithWhisperAsync(string filePath, CancellationToken cancellationToken)
    {
        const int maxRetries = 3;

        for (int attempt = 0; attempt <= maxRetries; attempt++)
        {
            using var content = new MultipartFormDataContent();

            var fileBytes = await File.ReadAllBytesAsync(filePath, cancellationToken);
            var fileContent = new ByteArrayContent(fileBytes);
            fileContent.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
            content.Add(fileContent, "file", Path.GetFileName(filePath));

            using var request = new HttpRequestMessage(HttpMethod.Post, _whisperEndpoint);
            request.Headers.Add("api-key", _whisperApiKey);
            request.Content = content;

            var response = await _httpClient.SendAsync(request, cancellationToken);

            if (response.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
            {
                if (attempt < maxRetries)
                {
                    var retryAfter = response.Headers.RetryAfter?.Delta
                                     ?? TimeSpan.FromSeconds(Math.Pow(2, attempt + 1));
                    _logger.LogWarning("Rate limited by Whisper API. Retrying in {Seconds}s (attempt {Attempt}/{Max})...",
                        retryAfter.TotalSeconds, attempt + 1, maxRetries);
                    await Task.Delay(retryAfter, cancellationToken);
                    continue;
                }
            }

            if (!response.IsSuccessStatusCode)
            {
                var errorBody = await response.Content.ReadAsStringAsync(cancellationToken);
                _logger.LogError("Whisper API error {Status}: {Body}", response.StatusCode, errorBody);
                throw new HttpRequestException($"Whisper API returned {response.StatusCode}: {errorBody}");
            }

            var json = await response.Content.ReadAsStringAsync(cancellationToken);
            _logger.LogInformation("Whisper response: {Json}", json);

            if (string.IsNullOrWhiteSpace(json))
            {
                _logger.LogWarning("Whisper API returned an empty response.");
                return null;
            }

            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("text", out var textElement))
            {
                var text = textElement.GetString()?.Trim();
                return string.IsNullOrEmpty(text) ? null : text;
            }

            return null;
        }

        return null;
    }

    public void Dispose()
    {
        _httpClient.Dispose();
    }
}
