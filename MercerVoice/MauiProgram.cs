using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MercerVoice.Services;
#if MACCATALYST
using Microsoft.Maui.LifecycleEvents;
using UIKit;
using Foundation;
using ObjCRuntime;
using System.Runtime.InteropServices;
#endif

namespace MercerVoice;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
            });

        // Configuration (embedded appsettings.json)
        var config = ConfigurationService.BuildConfiguration();
        builder.Services.AddSingleton<IConfiguration>(config);

        // Blazor
        builder.Services.AddMauiBlazorWebView();

#if DEBUG
        builder.Services.AddBlazorWebViewDeveloperTools();
        builder.Logging.AddDebug();
        builder.Logging.AddConsole();
        builder.Logging.SetMinimumLevel(LogLevel.Debug);
#endif

        // Platform services
#if MACCATALYST
        builder.Services.AddSingleton<IAccessibilityService, MacAccessibilityService>();
        builder.Services.AddSingleton<ITextInputService, MacTextInputService>();
        builder.Services.AddSingleton<IAudioRecorderService, MacAudioRecorderService>();
#endif

        // Application services
        builder.Services.AddSingleton<AzureAiService>();
        builder.Services.AddSingleton<ISpeechRecognitionService, SpeechRecognitionService>();
        builder.Services.AddSingleton<HotkeyService>();
        builder.Services.AddSingleton<IDictationService, DictationService>();

#if MACCATALYST
        // Make the WKWebView transparent
        Microsoft.AspNetCore.Components.WebView.Maui.BlazorWebViewHandler
            .BlazorWebViewMapper.AppendToMapping("TransparentWebView", (handler, view) =>
        {
            if (handler.PlatformView is WebKit.WKWebView webView)
            {
                webView.SetValueForKey(NSNumber.FromBoolean(false), new NSString("opaque"));
                webView.BackgroundColor = UIColor.Clear;
                webView.ScrollView.BackgroundColor = UIColor.Clear;
            }
        });

        builder.ConfigureLifecycleEvents(events =>
        {
            events.AddiOS(ios => ios.SceneOnActivated(scene =>
            {
                // Delay to ensure the NSWindow is fully created
                NSTimer.CreateScheduledTimer(1.0, _ =>
                {
                    ConfigureNSWindowViaAppKit();
                });
            }));
        });
#endif

        return builder.Build();
    }

#if MACCATALYST
    [DllImport("/usr/lib/libSystem.B.dylib")]
    private static extern IntPtr dlopen(string path, int mode);

    [DllImport("/usr/lib/libobjc.dylib", EntryPoint = "objc_msgSend")]
    private static extern IntPtr IntPtr_objc_msgSend(IntPtr receiver, IntPtr selector);

    [DllImport("/usr/lib/libobjc.dylib", EntryPoint = "objc_msgSend")]
    private static extern void void_objc_msgSend_IntPtr(IntPtr receiver, IntPtr selector, IntPtr arg);

    [DllImport("/usr/lib/libobjc.dylib", EntryPoint = "objc_msgSend")]
    private static extern void void_objc_msgSend_bool(IntPtr receiver, IntPtr selector, [MarshalAs(UnmanagedType.I1)] bool arg);

    [DllImport("/usr/lib/libobjc.dylib", EntryPoint = "objc_msgSend")]
    private static extern IntPtr IntPtr_objc_msgSend_nint(IntPtr receiver, IntPtr selector, nint arg);

    [DllImport("/usr/lib/libobjc.dylib", EntryPoint = "objc_msgSend")]
    private static extern nint nint_objc_msgSend(IntPtr receiver, IntPtr selector);

    private static void ConfigureNSWindowViaAppKit()
    {
        try
        {
            // Load AppKit framework so NSApplication/NSWindow classes are available
            dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", 1);

            // NSApplication.sharedApplication
            var nsAppClass = Class.GetHandle("NSApplication");
            if (nsAppClass == IntPtr.Zero)
            {
                Console.WriteLine("MercerVoice: NSApplication class not found");
                return;
            }

            var sharedApp = IntPtr_objc_msgSend(nsAppClass, Selector.GetHandle("sharedApplication"));
            if (sharedApp == IntPtr.Zero)
            {
                Console.WriteLine("MercerVoice: NSApplication.sharedApplication is null");
                return;
            }

            // Get windows array
            var windowsArray = IntPtr_objc_msgSend(sharedApp, Selector.GetHandle("windows"));
            if (windowsArray == IntPtr.Zero)
            {
                Console.WriteLine("MercerVoice: No windows found");
                return;
            }

            var windowCount = nint_objc_msgSend(windowsArray, Selector.GetHandle("count"));
            Console.WriteLine($"MercerVoice: Found {windowCount} NSWindow(s)");

            if (windowCount == 0) return;

            // Get the first window (our main window)
            var nsWindow = IntPtr_objc_msgSend_nint(windowsArray, Selector.GetHandle("objectAtIndex:"), 0);
            if (nsWindow == IntPtr.Zero)
            {
                Console.WriteLine("MercerVoice: NSWindow at index 0 is null");
                return;
            }

            Console.WriteLine($"MercerVoice: Configuring NSWindow at {nsWindow}");

            // NSColor.clearColor
            var nsColorClass = Class.GetHandle("NSColor");
            var clearColor = IntPtr_objc_msgSend(nsColorClass, Selector.GetHandle("clearColor"));

            // Make borderless (styleMask = 0, removes all chrome)
            void_objc_msgSend_IntPtr(nsWindow, Selector.GetHandle("setStyleMask:"), IntPtr.Zero);

            // Transparent background
            void_objc_msgSend_IntPtr(nsWindow, Selector.GetHandle("setBackgroundColor:"), clearColor);
            void_objc_msgSend_bool(nsWindow, Selector.GetHandle("setOpaque:"), false);
            void_objc_msgSend_bool(nsWindow, Selector.GetHandle("setHasShadow:"), false);

            // Float above other windows (NSFloatingWindowLevel = 3)
            void_objc_msgSend_IntPtr(nsWindow, Selector.GetHandle("setLevel:"), (IntPtr)3);

            // Draggable from anywhere
            void_objc_msgSend_bool(nsWindow, Selector.GetHandle("setMovableByWindowBackground:"), true);

            // Transparent titlebar
            void_objc_msgSend_bool(nsWindow, Selector.GetHandle("setTitlebarAppearsTransparent:"), true);

            // Hide traffic light buttons
            for (nint i = 0; i < 3; i++)
            {
                var button = IntPtr_objc_msgSend_nint(nsWindow, Selector.GetHandle("standardWindowButton:"), i);
                if (button != IntPtr.Zero)
                {
                    void_objc_msgSend_bool(button, Selector.GetHandle("setHidden:"), true);
                }
            }

            Console.WriteLine("MercerVoice: NSWindow configured successfully!");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"MercerVoice: NSWindow config failed: {ex}");
        }
    }
#endif
}
