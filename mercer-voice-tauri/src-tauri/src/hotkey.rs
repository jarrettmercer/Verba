use std::sync::atomic::AtomicBool;
#[cfg(target_os = "windows")]
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio;
use crate::hotkey_state::HotkeyState;
use crate::paste;
use crate::sounds;
use crate::store::Store;
use crate::transcribe;

// ── macOS-specific imports, constants, FFI, and tap callback ─────────

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::ptr;
    use std::sync::atomic::{AtomicPtr, Ordering};

    pub const KVK_FUNCTION: i64 = 0x3F;
    pub const KCGEVENT_FLAGS_CHANGED: u32 = 12;
    pub const KCGEVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFFFFFE;
    pub const KCG_EVENT_FLAG_MASK_SECONDARY_FN: u64 = 0x0080_0000;
    pub const KCG_KEYBOARD_EVENT_KEYCODE: u32 = 9;

    pub const KCG_HID_EVENT_TAP: u32 = 0;
    pub const KCG_HEAD_INSERT_EVENT_TAP: u32 = 0;
    pub const KCG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;

    pub type CGEventRef = *mut c_void;
    pub type CFMachPortRef = *mut c_void;

    pub type CGEventTapCallBack = extern "C" fn(
        proxy: *mut c_void,
        event_type: u32,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef;

    extern "C" {
        pub fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: CGEventTapCallBack,
            user_info: *mut c_void,
        ) -> CFMachPortRef;

        pub fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
        pub fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
        pub fn CGEventGetFlags(event: CGEventRef) -> u64;

        pub fn CFMachPortCreateRunLoopSource(
            allocator: *const c_void,
            port: CFMachPortRef,
            order: isize,
        ) -> *mut c_void;

        pub fn CFRunLoopGetCurrent() -> *mut c_void;
        pub fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        pub fn CFRunLoopRun();

        pub static kCFRunLoopCommonModes: *const c_void;
    }

    pub static TAP_PORT: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());

    pub extern "C" fn tap_callback(
        _proxy: *mut c_void,
        event_type: u32,
        event: CGEventRef,
        _user_info: *mut c_void,
    ) -> CGEventRef {
        // Re-enable the tap if macOS disabled it due to timeout
        if event_type == KCGEVENT_TAP_DISABLED_BY_TIMEOUT {
            eprintln!("[Verba] Event tap was disabled by timeout — re-enabling");
            let port = TAP_PORT.load(Ordering::SeqCst);
            if !port.is_null() {
                unsafe { CGEventTapEnable(port, true); }
            }
            return event;
        }

        if event_type != KCGEVENT_FLAGS_CHANGED {
            return event;
        }

        let keycode = unsafe { CGEventGetIntegerValueField(event, KCG_KEYBOARD_EVENT_KEYCODE) };
        if keycode != KVK_FUNCTION {
            return event;
        }

        let flags = unsafe { CGEventGetFlags(event) };
        let fn_down = flags & KCG_EVENT_FLAG_MASK_SECONDARY_FN != 0;

        if fn_down && !super::HOTKEY_ACTIVE.load(Ordering::SeqCst) {
            super::HOTKEY_ACTIVE.store(true, Ordering::SeqCst);
            if let Some(tx) = super::EVENT_TX.get() {
                let _ = tx.send(super::HotkeyEvent::Press);
            }
        } else if !fn_down && super::HOTKEY_ACTIVE.load(Ordering::SeqCst) {
            super::HOTKEY_ACTIVE.store(false, Ordering::SeqCst);
            if let Some(tx) = super::EVENT_TX.get() {
                let _ = tx.send(super::HotkeyEvent::Release);
            }
        }

        event
    }
}

// ── Globals ────────────────────────────────────────────────────────────

static HOTKEY_ACTIVE: AtomicBool = AtomicBool::new(false);

enum HotkeyEvent {
    Press,
    Release,
}

static EVENT_TX: OnceLock<mpsc::Sender<HotkeyEvent>> = OnceLock::new();

// ── Worker thread — all heavy work happens here, off the tap thread ───

fn run_worker(rx: mpsc::Receiver<HotkeyEvent>, app_handle: AppHandle) {
    while let Ok(evt) = rx.recv() {
        match evt {
            HotkeyEvent::Press => {
                sounds::play_beep();
                eprintln!("[Verba] Hotkey PRESSED");
                let bundle_id = get_frontmost_app_bundle_id();
                if let Some(ref id) = bundle_id {
                    eprintln!("[Verba] Frontmost app: {}", id);
                }
                let app = app_handle.clone();
                let _ = app_handle.run_on_main_thread(move || {
                    app.state::<HotkeyState>().set_paste_target(bundle_id);
                    if let Err(e) = audio::start_recording_impl(&app) {
                        eprintln!("[Verba] start_recording failed: {}", e);
                    }
                });
            }
            HotkeyEvent::Release => {
                sounds::play_boop();
                eprintln!("[Verba] Hotkey RELEASED");
                let app = app_handle.clone();
                let _ = app_handle.run_on_main_thread(move || {
                    let wav_path = match audio::stop_recording_impl(&app) {
                        Ok(p) => p,
                        Err(e) => {
                            eprintln!("[Verba] stop_recording failed: {}", e);
                            return;
                        }
                    };
                    let bundle_id = app.state::<HotkeyState>().take_paste_target();
                    // Resolve API credentials from store before async spawn
                    let store: tauri::State<'_, Store> = app.state();
                    let api_endpoint = store.resolve_endpoint();
                    let api_key = store.resolve_api_key();
                    let app_for_paste = app.clone();
                    tauri::async_runtime::spawn(async move {
                        eprintln!("[Verba] Transcribing...");
                        match transcribe::transcribe_impl(wav_path, api_endpoint, api_key).await {
                            Ok(text) if !text.is_empty() => {
                                eprintln!("[Verba] Pasting into target app");
                                let text_for_stats = text.clone();
                                let app_for_stats = app_for_paste.clone();
                                let paste_target = Some(bundle_id.unwrap_or_default());
                                let _ = app_for_paste.run_on_main_thread(move || {
                                    // Record dictation stats
                                    let store: tauri::State<'_, Store> = app_for_stats.state();
                                    store.record_dictation(&text_for_stats);
                                    let _ = app_for_stats.emit("stats-updated", ());

                                    if let Err(e) =
                                        paste::paste_text_impl(text, paste_target)
                                    {
                                        eprintln!("[Verba] paste failed: {}", e);
                                    }
                                });
                            }
                            Ok(_) => {
                                eprintln!("[Verba] No speech detected, skipping paste");
                            }
                            Err(e) => {
                                eprintln!("[Verba] Transcribe error: {}", e);
                            }
                        }
                        let app_emit = app_for_paste.clone();
                        let _ = app_for_paste.run_on_main_thread(move || {
                            let _ = app_emit.emit_to("main", "dictation-complete", ());
                        });
                    });
                });
            }
        }
    }
}

// ── Frontmost app detection ────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn get_frontmost_app_bundle_id() -> Option<String> {
    let out = std::process::Command::new("osascript")
        .args([
            "-e",
            r#"tell application "System Events" to get bundle identifier of first application process whose frontmost is true"#,
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        return None;
    }
    if s.eq_ignore_ascii_case("missing value") {
        eprintln!("[Verba] Frontmost app: AppleScript returned 'missing value'");
        return None;
    }
    Some(s)
}

#[cfg(not(target_os = "macos"))]
fn get_frontmost_app_bundle_id() -> Option<String> {
    // On Windows the overlay doesn't steal focus, so the correct app is
    // already frontmost — no bundle ID needed.
    None
}

// ── Public entry point ─────────────────────────────────────────────────

pub fn start_hotkey_listener(app_handle: AppHandle) {
    // Channel from the lightweight tap/listener callback → worker thread
    let (tx, rx) = mpsc::channel();
    EVENT_TX.set(tx).expect("EVENT_TX already initialized");

    // Worker thread handles recording, transcription, paste
    let app_for_worker = app_handle.clone();
    std::thread::spawn(move || run_worker(rx, app_for_worker));

    // ── macOS: CGEventTap on a dedicated thread ────────────────────
    #[cfg(target_os = "macos")]
    {
        use std::ptr;
        use std::sync::atomic::Ordering;

        let app_for_error = app_handle;
        std::thread::spawn(move || {
            let event_mask: u64 = 1 << macos::KCGEVENT_FLAGS_CHANGED;

            let port = unsafe {
                macos::CGEventTapCreate(
                    macos::KCG_HID_EVENT_TAP,
                    macos::KCG_HEAD_INSERT_EVENT_TAP,
                    macos::KCG_EVENT_TAP_OPTION_LISTEN_ONLY,
                    event_mask,
                    macos::tap_callback,
                    ptr::null_mut(),
                )
            };

            if port.is_null() {
                let msg = "Global hotkey failed — grant Input Monitoring AND Accessibility in System Settings → Privacy & Security, then restart Verba.";
                eprintln!("[Verba] CGEventTapCreate returned NULL!");
                eprintln!("[Verba] {}", msg);
                let app = app_for_error.clone();
                let _ = app_for_error.run_on_main_thread(move || {
                    let _ = app.emit_to("main", "recording-failed", msg);
                });
                return;
            }

            macos::TAP_PORT.store(port, Ordering::SeqCst);

            unsafe {
                let source = macos::CFMachPortCreateRunLoopSource(ptr::null(), port, 0);
                if source.is_null() {
                    eprintln!("[Verba] Failed to create run loop source");
                    return;
                }
                let run_loop = macos::CFRunLoopGetCurrent();
                macos::CFRunLoopAddSource(run_loop, source, macos::kCFRunLoopCommonModes);
                macos::CGEventTapEnable(port, true);
                eprintln!("[Verba] Global hotkey listener started (Fn/Globe key, HID tap)");
                macos::CFRunLoopRun();
            }
        });
    }

    // ── Windows: rdev global listener for Right Ctrl ───────────────
    #[cfg(target_os = "windows")]
    {
        std::thread::spawn(move || {
            eprintln!("[Verba] Starting global hotkey listener (Right Ctrl, rdev)");
            if let Err(e) = rdev::listen(|event| {
                match event.event_type {
                    rdev::EventType::KeyPress(rdev::Key::ControlRight) => {
                        if !HOTKEY_ACTIVE.load(Ordering::SeqCst) {
                            HOTKEY_ACTIVE.store(true, Ordering::SeqCst);
                            if let Some(tx) = EVENT_TX.get() {
                                let _ = tx.send(HotkeyEvent::Press);
                            }
                        }
                    }
                    rdev::EventType::KeyRelease(rdev::Key::ControlRight) => {
                        if HOTKEY_ACTIVE.load(Ordering::SeqCst) {
                            HOTKEY_ACTIVE.store(false, Ordering::SeqCst);
                            if let Some(tx) = EVENT_TX.get() {
                                let _ = tx.send(HotkeyEvent::Release);
                            }
                        }
                    }
                    _ => {}
                }
            }) {
                eprintln!("[Verba] rdev listen error: {:?}", e);
            }
        });
    }
}
