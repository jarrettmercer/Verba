# rctrl-hook.ps1 — Low-level keyboard hook for Right Control push-to-talk
# Outputs PRESS / RELEASE on stdout (same protocol as macOS fn-key-tap helper)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;

public class RCtrlHook {
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN    = 0x0100;
    private const int WM_KEYUP      = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP   = 0x0105;
    private const int VK_RCONTROL   = 0xA3;

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int pt_x;
        public int pt_y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT {
        public int vkCode;
        public int scanCode;
        public int flags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    private static IntPtr hookId = IntPtr.Zero;
    private static bool pressed = false;
    // prevent GC from collecting the delegate
    private static LowLevelKeyboardProc procDelegate;

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            var info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            if (info.vkCode == VK_RCONTROL) {
                int msg = wParam.ToInt32();
                if ((msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) && !pressed) {
                    pressed = true;
                    Console.WriteLine("PRESS");
                    Console.Out.Flush();
                } else if ((msg == WM_KEYUP || msg == WM_SYSKEYUP) && pressed) {
                    pressed = false;
                    Console.WriteLine("RELEASE");
                    Console.Out.Flush();
                }
            }
        }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }

    public static void Run() {
        procDelegate = HookCallback;
        using (var curProcess = Process.GetCurrentProcess())
        using (var curModule = curProcess.MainModule) {
            hookId = SetWindowsHookEx(WH_KEYBOARD_LL, procDelegate, GetModuleHandle(curModule.ModuleName), 0);
        }
        if (hookId == IntPtr.Zero) {
            Console.Error.WriteLine("Failed to install keyboard hook");
            return;
        }
        Console.Error.WriteLine("RCtrl hook installed");
        Console.Error.Flush();
        // Message loop — required for low-level hooks to receive callbacks
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
        UnhookWindowsHookEx(hookId);
    }
}
"@

[RCtrlHook]::Run()
