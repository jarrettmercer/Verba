using MercerVoice.Services;

namespace MercerVoice;

public partial class App : Application
{
    private readonly IAccessibilityService? _accessibilityService;

    public App(IAccessibilityService? accessibilityService = null)
    {
        InitializeComponent();
        _accessibilityService = accessibilityService;

        if (_accessibilityService is not null &&
            !_accessibilityService.HasAccessibilityPermission())
        {
            _accessibilityService.RequestAccessibilityPermission();
        }
    }

    protected override Window CreateWindow(IActivationState? activationState)
    {
        var window = new Window(new MainPage()) { Title = "MercerVoice" };

#if MACCATALYST
        window.Width = 360;
        window.Height = 80;
#endif

        return window;
    }
}
