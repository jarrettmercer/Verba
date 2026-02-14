namespace MercerVoice.Services;

public interface IAccessibilityService
{
    bool HasAccessibilityPermission();
    bool RequestAccessibilityPermission();
    void OpenAccessibilitySettings();
}
