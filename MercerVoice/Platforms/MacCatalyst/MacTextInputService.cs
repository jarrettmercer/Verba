using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;
using UIKit;

namespace MercerVoice.Services;

public class MacTextInputService : ITextInputService
{
    private readonly ILogger<MacTextInputService> _logger;

    [DllImport("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")]
    private static extern IntPtr CGEventCreateKeyboardEvent(IntPtr source, ushort virtualKey, bool keyDown);

    [DllImport("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")]
    private static extern void CGEventSetFlags(IntPtr eventRef, ulong flags);

    [DllImport("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")]
    private static extern void CGEventPost(uint tap, IntPtr eventRef);

    [DllImport("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")]
    private static extern void CFRelease(IntPtr obj);

    private const ushort kVK_ANSI_V = 0x09;
    private const ulong kCGEventFlagMaskCommand = 0x00100000UL;
    private const uint kCGHIDEventTap = 0;

    public MacTextInputService(ILogger<MacTextInputService> logger)
    {
        _logger = logger;
    }

    public async Task TypeTextAsync(string text)
    {
        _logger.LogInformation("Typing text via clipboard+paste ({Length} chars)", text.Length);

        // Copy text to clipboard on the main thread
        await MainThread.InvokeOnMainThreadAsync(() =>
        {
            UIPasteboard.General.String = text;
        });

        // Brief delay to ensure clipboard is set
        await Task.Delay(50);

        // Simulate Cmd+V to paste
        SimulatePaste();

        _logger.LogInformation("Paste command sent.");
    }

    private void SimulatePaste()
    {
        var keyDown = CGEventCreateKeyboardEvent(IntPtr.Zero, kVK_ANSI_V, true);
        CGEventSetFlags(keyDown, kCGEventFlagMaskCommand);

        var keyUp = CGEventCreateKeyboardEvent(IntPtr.Zero, kVK_ANSI_V, false);
        CGEventSetFlags(keyUp, kCGEventFlagMaskCommand);

        CGEventPost(kCGHIDEventTap, keyDown);
        CGEventPost(kCGHIDEventTap, keyUp);

        CFRelease(keyDown);
        CFRelease(keyUp);
    }
}
