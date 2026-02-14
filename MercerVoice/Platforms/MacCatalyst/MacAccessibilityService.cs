using System.Runtime.InteropServices;
using Foundation;
using Microsoft.Extensions.Logging;
using UIKit;

namespace MercerVoice.Services;

public class MacAccessibilityService : IAccessibilityService
{
    private readonly ILogger<MacAccessibilityService> _logger;

    [DllImport("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")]
    private static extern bool AXIsProcessTrusted();

    [DllImport("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")]
    private static extern bool AXIsProcessTrustedWithOptions(IntPtr options);

    public MacAccessibilityService(ILogger<MacAccessibilityService> logger)
    {
        _logger = logger;
    }

    public bool HasAccessibilityPermission()
    {
        var hasAccess = AXIsProcessTrusted();
        _logger.LogInformation("Accessibility permission check: {HasAccess}", hasAccess);
        return hasAccess;
    }

    public bool RequestAccessibilityPermission()
    {
        // AXIsProcessTrustedWithOptions with kAXTrustedCheckOptionPrompt = true
        // prompts the user to grant Accessibility permission
        using var key = new NSString("AXTrustedCheckOptionPrompt");
        using var value = NSNumber.FromBoolean(true);
        using var options = NSDictionary.FromObjectAndKey(value, key);
        var granted = AXIsProcessTrustedWithOptions(options.Handle);
        _logger.LogInformation("Accessibility permission request result: {Granted}", granted);
        return granted;
    }

    public void OpenAccessibilitySettings()
    {
        var url = new NSUrl(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
        if (url is not null)
        {
            UIApplication.SharedApplication.OpenUrl(url, new UIApplicationOpenUrlOptions(), null);
        }
    }
}
