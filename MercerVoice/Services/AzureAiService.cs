using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace MercerVoice.Services;

public class AzureAiService
{
    private readonly ILogger<AzureAiService> _logger;

    public string? Endpoint { get; }
    public string? DeploymentName { get; }
    public bool IsConfigured { get; }

    public AzureAiService(IConfiguration config, ILogger<AzureAiService> logger)
    {
        _logger = logger;

        Endpoint = config["AzureOpenAI:Endpoint"];
        DeploymentName = config["AzureOpenAI:DeploymentName"];
        IsConfigured = !string.IsNullOrEmpty(Endpoint)
                    && !string.IsNullOrEmpty(config["AzureOpenAI:ApiKey"]);

        if (IsConfigured)
        {
            _logger.LogInformation(
                "Connected to Azure OpenAI endpoint: {Endpoint}, deployment: {Deployment}",
                Endpoint, DeploymentName);
        }
        else
        {
            _logger.LogWarning(
                "Azure OpenAI is not configured. Set AzureOpenAI:Endpoint and AzureOpenAI:ApiKey in appsettings.json.");
        }
    }
}
