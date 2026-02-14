using System.Reflection;
using Microsoft.Extensions.Configuration;

namespace MercerVoice.Services;

public static class ConfigurationService
{
    public static IConfiguration BuildConfiguration()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = "MercerVoice.appsettings.json";

        using var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream is null)
        {
            var available = string.Join(", ", assembly.GetManifestResourceNames());
            throw new FileNotFoundException(
                $"Embedded resource '{resourceName}' not found. " +
                $"Available resources: [{available}]. " +
                "Ensure appsettings.json Build Action is set to EmbeddedResource.");
        }

        return new ConfigurationBuilder()
            .AddJsonStream(stream)
            .Build();
    }
}
