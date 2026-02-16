//! Emits "pill-cursor-over" when the global cursor is over the main (pill) window,
//! so the pill can expand/glow on hover without the window needing focus.
//! On macOS we use a mouse-only CGEventTap (no keyboard events → no TSM/HIToolbox),
//! so global hover works when another app is focused. Other platforms use polling.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;

/// Extra pixels around the window to trigger "over" slightly early.
const HIT_SLOP: i32 = 12;

pub fn start_pill_hover_listener(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    macos_tap::start_pill_hover_listener_macos_tap(app);
    #[cfg(not(target_os = "macos"))]
    start_pill_hover_listener_poll(app);
}

// ── macOS: mouse-only CGEventTap (global hover, no TSM) ───────────────────

#[cfg(target_os = "macos")]
mod macos_tap {
    use std::ffi::c_void;
    use std::ptr;
    use std::sync::atomic::{AtomicPtr, AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    const KCG_EVENT_MOUSE_MOVED: u32 = 5;
    const KCG_EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFFFFFE;
    const KCG_HID_EVENT_TAP: u32 = 0;
    const KCG_HEAD_INSERT_EVENT_TAP: u32 = 0;
    const KCG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
    const THROTTLE_MS: u64 = 50;

    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    type CGEventRef = *mut c_void;
    type CFMachPortRef = *mut c_void;

    type CGEventTapCallBack = extern "C" fn(
        proxy: *mut c_void,
        event_type: u32,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef;

    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: CGEventTapCallBack,
            user_info: *mut c_void,
        ) -> CFMachPortRef;
        fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
        fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
        fn CFMachPortCreateRunLoopSource(
            allocator: *const c_void,
            port: CFMachPortRef,
            order: isize,
        ) -> *mut c_void;
        fn CFRunLoopGetCurrent() -> *mut c_void;
        fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopRun();
        static kCFRunLoopCommonModes: *const c_void;
    }

    static TAP_PORT: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
    static PILL_HOVER_TX: std::sync::OnceLock<mpsc::Sender<(i32, i32)>> = std::sync::OnceLock::new();
    static LAST_SENT_NS: AtomicU64 = AtomicU64::new(0);

    pub extern "C" fn mouse_tap_callback(
        _proxy: *mut c_void,
        event_type: u32,
        event: CGEventRef,
        _user_info: *mut c_void,
    ) -> CGEventRef {
        if event_type == KCG_EVENT_TAP_DISABLED_BY_TIMEOUT {
            let port = TAP_PORT.load(Ordering::SeqCst);
            if !port.is_null() {
                unsafe { CGEventTapEnable(port as CFMachPortRef, true); }
            }
            return event;
        }
        if event_type != KCG_EVENT_MOUSE_MOVED {
            return event;
        }
        let pt = unsafe { CGEventGetLocation(event) };
        let x = pt.x as i32;
        let y = pt.y as i32;
        let now_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let min_interval_ns = THROTTLE_MS * 1_000_000;
        if now_ns.saturating_sub(LAST_SENT_NS.load(Ordering::Relaxed)) < min_interval_ns {
            return event;
        }
        LAST_SENT_NS.store(now_ns, Ordering::Relaxed);
        if let Some(tx) = PILL_HOVER_TX.get() {
            let _ = tx.send((x, y));
        }
        event
    }

    pub fn start_pill_hover_listener_macos_tap(app: tauri::AppHandle) {
        let (tx, rx) = mpsc::channel::<(i32, i32)>();
        let _ = PILL_HOVER_TX.set(tx);
        let last_over = Arc::new(AtomicBool::new(false));

        // Receiver thread: get (x,y) from tap, run hit-test on main thread and emit
        let app_recv = app.clone();
        let last_over_recv = Arc::clone(&last_over);
        thread::spawn(move || {
            while let Ok((cx, cy)) = rx.recv() {
                let app_clone = app_recv.clone();
                let last_over_clone = Arc::clone(&last_over_recv);
                let _ = app_recv.run_on_main_thread(move || {
                    let over = is_cursor_over_pill_window_at(&app_clone, cx, cy);
                    if over != last_over_clone.load(Ordering::Relaxed) {
                        last_over_clone.store(over, Ordering::Relaxed);
                        let _ = app_clone.emit_to("main", "pill-cursor-over", over);
                    }
                });
            }
        });

        // Tap thread: run mouse-only event tap
        let app_fallback = app.clone();
        thread::spawn(move || {
            let event_mask: u64 = 1 << KCG_EVENT_MOUSE_MOVED;
            let port = unsafe {
                CGEventTapCreate(
                    KCG_HID_EVENT_TAP,
                    KCG_HEAD_INSERT_EVENT_TAP,
                    KCG_EVENT_TAP_OPTION_LISTEN_ONLY,
                    event_mask,
                    mouse_tap_callback,
                    ptr::null_mut(),
                )
            };
            if port.is_null() {
                eprintln!("[Verba] Pill hover: CGEventTapCreate (mouse) returned NULL — grant Input Monitoring in System Settings → Privacy & Security. Using polling (hover only when Verba is focused).");
                start_pill_hover_listener_poll(app_fallback);
                return;
            }
            TAP_PORT.store(port as *mut c_void, Ordering::SeqCst);
            unsafe {
                let source = CFMachPortCreateRunLoopSource(ptr::null(), port, 0);
                if source.is_null() {
                    eprintln!("[Verba] Pill hover: failed to create run loop source");
                    return;
                }
                let run_loop = CFRunLoopGetCurrent();
                CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
                CGEventTapEnable(port, true);
                eprintln!("[Verba] Pill hover: global mouse tap started (works when another app is focused)");
                CFRunLoopRun();
            }
        });
    }
}

/// Polling path: used on non-macOS, and on macOS when the event tap fails (e.g. no permission).
fn start_pill_hover_listener_poll(app: tauri::AppHandle) {
    use mouse_position::mouse_position::Mouse;
    let last_over = Arc::new(AtomicBool::new(false));
    thread::spawn(move || {
        loop {
            let (cx, cy) = match Mouse::get_mouse_position() {
                mouse_position::mouse_position::Mouse::Position { x, y } => (x as i32, y as i32),
                mouse_position::mouse_position::Mouse::Error => {
                    thread::sleep(Duration::from_millis(80));
                    continue;
                }
            };
            let app_clone = app.clone();
            let last_over_clone = Arc::clone(&last_over);
            let _ = app.run_on_main_thread(move || {
                let over = is_cursor_over_pill_window_at(&app_clone, cx, cy);
                if over != last_over_clone.load(Ordering::Relaxed) {
                    last_over_clone.store(over, Ordering::Relaxed);
                    let _ = app_clone.emit_to("main", "pill-cursor-over", over);
                }
            });
            thread::sleep(Duration::from_millis(80));
        }
    });
}

/// On macOS, cursor from CGEventGetLocation is in Core Graphics coords (origin bottom-left).
/// Tao window positions are top-left. Convert cy so hit-test matches.
#[cfg(target_os = "macos")]
fn cursor_to_top_left(win: &tauri::WebviewWindow, cx: i32, cy: i32) -> (i32, i32) {
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let h = monitor.size().height as i32;
        return (cx, h - cy);
    }
    (cx, cy)
}

#[cfg(not(target_os = "macos"))]
fn cursor_to_top_left(_win: &tauri::WebviewWindow, cx: i32, cy: i32) -> (i32, i32) {
    (cx, cy)
}

fn is_cursor_over_pill_window_at(app: &tauri::AppHandle, cx: i32, cy: i32) -> bool {
    let Some(win) = app.get_webview_window("main") else {
        return false;
    };
    let Ok(size) = win.outer_size() else {
        return false;
    };
    let (cx, cy) = cursor_to_top_left(&win, cx, cy);
    let (win_x, win_y) = pill_window_rect_top_left(app, &win, size.width as i32, size.height as i32);
    let x = win_x - HIT_SLOP;
    let y = win_y - HIT_SLOP;
    let w = size.width as i32 + 2 * HIT_SLOP;
    let h = size.height as i32 + 2 * HIT_SLOP;
    cx >= x && cx < x + w && cy >= y && cy < y + h
}

/// Returns (x, y) top-left of the pill window in screen coordinates (same as rdev's MouseMove).
/// On macOS, outer_position() often returns (0,0) when another app is focused, so we fall back
/// to primary monitor + our known bottom-center placement.
fn pill_window_rect_top_left(
    _app: &tauri::AppHandle,
    win: &tauri::WebviewWindow,
    width: i32,
    height: i32,
) -> (i32, i32) {
    if let Ok(pos) = win.outer_position() {
        let (px, py) = (pos.x as i32, pos.y as i32);
        #[cfg(target_os = "macos")]
        if (px, py) != (0, 0) {
            return (px, py);
        }
        #[cfg(not(target_os = "macos"))]
        return (px, py);
    }
    #[cfg(target_os = "macos")]
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let mon_pos = monitor.position();
        let mon_size = monitor.size();
        const MARGIN_BOTTOM: i32 = 28;
        let x = mon_pos.x + (mon_size.width as i32 - width) / 2;
        let y = mon_pos.y + mon_size.height as i32 - height - MARGIN_BOTTOM;
        return (x, y);
    }
    (0, 0)
}
