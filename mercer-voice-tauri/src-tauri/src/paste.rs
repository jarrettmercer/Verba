use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::panic::{self, AssertUnwindSafe};
use std::process::Command;
use std::thread;
use std::time::Duration;

/// Our app's bundle id — we never activate ourselves.
const VERBA_BUNDLE_ID: &str = "app.verba";

/// Core paste logic. Used by both the Tauri command and the hotkey flow.
pub fn paste_text_impl(text: String, target_bundle_id: Option<String>) -> Result<(), String> {
    let result = panic::catch_unwind(AssertUnwindSafe(|| do_paste(text, target_bundle_id)));
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(panic_any) => {
            let msg = panic_any
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| panic_any.downcast_ref::<&str>().copied())
                .unwrap_or("paste panic");
            eprintln!("[Verba] Paste panic (grant Accessibility?): {}", msg);
            Err(format!(
                "Paste failed. Add Verba in System Settings → Privacy & Security → Accessibility, then try again."
            ))
        }
    }
}

fn do_paste(text: String, target_bundle_id: Option<String>) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    eprintln!("[Verba] Paste: setting clipboard ({} chars)", text.len());
    let mut clipboard =
        Clipboard::new().map_err(|e| format!("Failed to access clipboard: {}", e))?;

    clipboard
        .set_text(&text)
        .map_err(|e| format!("Failed to set clipboard text: {}", e))?;

    thread::sleep(Duration::from_millis(50));

    let do_keystroke = target_bundle_id.is_some();

    #[cfg(target_os = "macos")]
    if let Some(ref bid) = target_bundle_id {
        let bid = bid.trim();
        let valid_target = !bid.is_empty()
            && !bid.eq_ignore_ascii_case("missing value")
            && bid != VERBA_BUNDLE_ID;
        if valid_target {
            eprintln!("[Verba] Paste: activating app {}", bid);
            let script = format!(
                r#"tell application "System Events" to set frontmost of first process whose bundle identifier is "{}" to true"#,
                bid.replace('"', "\\\"")
            );
            let out = Command::new("osascript").args(["-e", &script]).output();
            if let Ok(ref o) = out {
                if !o.status.success() {
                    eprintln!("[Verba] Paste: osascript failed {:?}", o.status);
                }
            } else {
                eprintln!("[Verba] Paste: osascript error");
            }
            thread::sleep(Duration::from_millis(200));
        }
    }

    if do_keystroke {
        eprintln!("[Verba] Paste: sending Cmd+V (needs Accessibility permission)");
        let mut enigo =
            Enigo::new(&Settings::default()).map_err(|e| format!("Failed to create Enigo (grant Accessibility?): {}", e))?;

        #[cfg(target_os = "macos")]
        {
            enigo
                .key(Key::Meta, Direction::Press)
                .map_err(|e| format!("Key press failed (grant Accessibility?): {}", e))?;
            enigo
                .key(Key::Unicode('v'), Direction::Click)
                .map_err(|e| format!("Key click failed: {}", e))?;
            enigo
                .key(Key::Meta, Direction::Release)
                .map_err(|e| format!("Key release failed: {}", e))?;
        }

        #[cfg(not(target_os = "macos"))]
        {
            enigo
                .key(Key::Control, Direction::Press)
                .map_err(|e| format!("Key press failed: {}", e))?;
            enigo
                .key(Key::Unicode('v'), Direction::Click)
                .map_err(|e| format!("Key click failed: {}", e))?;
            enigo
                .key(Key::Control, Direction::Release)
                .map_err(|e| format!("Key release failed: {}", e))?;
        }
        eprintln!("[Verba] Paste: Cmd+V sent");
    }

    Ok(())
}

#[tauri::command]
pub fn paste_text(text: String, target_bundle_id: Option<String>) -> Result<(), String> {
    do_paste(text, target_bundle_id)
}
