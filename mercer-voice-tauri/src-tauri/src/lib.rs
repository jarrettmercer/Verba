mod audio;
mod hotkey;
mod hotkey_state;
mod paste;
mod permissions;
mod sounds;
mod store;
mod transcribe;

use std::path::Path;
use futures_util::StreamExt;
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use store::{ApiConfig, DictionaryEntry, Settings, Stats, Store, TranscriptionConfig};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::PhysicalPosition;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

// ===== DASHBOARD WINDOW =====

fn open_dashboard_window(app: &tauri::AppHandle) {
    // If the window already exists, just focus it
    if let Some(window) = app.get_webview_window("dashboard") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    // Create new dashboard window
    match WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::App("dashboard.html".into()))
        .title("Verba — Dashboard")
        .inner_size(880.0, 620.0)
        .min_inner_size(640.0, 480.0)
        .center()
        .decorations(true)
        .resizable(true)
        .visible(true)
        .build()
    {
        Ok(_) => eprintln!("[Verba] Dashboard window created"),
        Err(e) => eprintln!("[Verba] Failed to create dashboard window: {}", e),
    }
}

#[tauri::command]
fn open_dashboard(app: tauri::AppHandle) {
    open_dashboard_window(&app);
}

// ===== STATS COMMANDS =====

#[tauri::command]
fn get_stats(store: tauri::State<'_, Store>) -> Stats {
    store.get_stats()
}

#[tauri::command]
fn record_dictation(app: tauri::AppHandle, store: tauri::State<'_, Store>, text: String) {
    store.record_dictation(&text);
    // Notify dashboard (if open) to refresh
    let _ = app.emit("stats-updated", ());
}

#[tauri::command]
fn clear_history(store: tauri::State<'_, Store>) {
    store.clear_history();
}

// ===== DICTIONARY COMMANDS =====

#[tauri::command]
fn get_dictionary(store: tauri::State<'_, Store>) -> Vec<DictionaryEntry> {
    store.get_dictionary()
}

#[tauri::command]
fn add_dictionary_entry(
    store: tauri::State<'_, Store>,
    phrase: String,
    replacement: Option<String>,
    entry_type: String,
) -> DictionaryEntry {
    store.add_dictionary_entry(phrase, replacement, entry_type)
}

#[tauri::command]
fn update_dictionary_entry(
    store: tauri::State<'_, Store>,
    id: String,
    phrase: String,
    replacement: Option<String>,
    entry_type: String,
) -> Result<(), String> {
    store.update_dictionary_entry(&id, phrase, replacement, entry_type)
}

#[tauri::command]
fn remove_dictionary_entry(
    store: tauri::State<'_, Store>,
    id: String,
) -> Result<(), String> {
    store.remove_dictionary_entry(&id)
}

// ===== SETTINGS COMMANDS =====

#[tauri::command]
fn get_settings(store: tauri::State<'_, Store>) -> Settings {
    store.get_settings()
}

#[tauri::command]
fn update_setting(store: tauri::State<'_, Store>, key: String, value: bool) {
    store.update_setting(&key, value);
}

// ===== API CONFIG COMMANDS =====

#[tauri::command]
fn get_api_config(store: tauri::State<'_, Store>) -> ApiConfig {
    store.get_api_config()
}

#[tauri::command]
fn set_api_config(store: tauri::State<'_, Store>, endpoint: String, api_key: String) {
    store.set_api_config(endpoint, api_key);
}

// ===== TRANSCRIPTION CONFIG (Azure vs Local) =====

#[tauri::command]
fn get_transcription_config(store: tauri::State<'_, Store>) -> TranscriptionConfig {
    store.get_transcription_config()
}

#[tauri::command]
fn set_transcription_config(
    store: tauri::State<'_, Store>,
    source: String,
    local_model_path: String,
    local_model_size: String,
) {
    store.set_transcription_config(source, local_model_path, local_model_size);
}

#[tauri::command]
fn get_default_local_model_path(store: tauri::State<'_, Store>) -> Option<String> {
    store.get_default_local_model_path()
}

#[tauri::command]
fn get_default_local_model_path_for_size(
    store: tauri::State<'_, Store>,
    size: String,
) -> Option<String> {
    store.get_default_local_model_path_for_size(&size)
}

const GGML_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

#[derive(Clone, Serialize)]
struct DownloadProgress {
    loaded: u64,
    total: u64,
}

#[tauri::command]
async fn download_local_model(
    app: AppHandle,
    store: tauri::State<'_, Store>,
    size: String,
) -> Result<String, String> {
    // Use the size passed from the UI (dropdown selection), not the saved config
    let size = size.trim().to_lowercase();
    let size = if matches!(size.as_str(), "small" | "medium" | "large") {
        size
    } else {
        "tiny".to_string()
    };
    let filename = match size.as_str() {
        "small" => "ggml-small.en.bin",
        "medium" => "ggml-medium.en.bin",
        "large" => "ggml-large-v3.bin",
        _ => "ggml-tiny.en.bin",
    };
    let url = format!("{}/{}", GGML_BASE_URL, filename);

    let path_str = store
        .get_default_local_model_path_for_size(&size)
        .ok_or_else(|| "Could not get default model path".to_string())?;
    let path = Path::new(&path_str).to_path_buf();
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid model path".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Could not create models folder: {}", e))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed: server returned {}",
            response.status()
        ));
    }

    let total = response.content_length().unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("Failed to create model file: {}", e))?;
    let mut loaded: u64 = 0;
    let mut last_emit_pct = 0u8;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        let len = bytes.len() as u64;
        loaded += len;
        tokio::io::AsyncWriteExt::write_all(&mut file, &bytes)
            .await
            .map_err(|e| format!("Failed to write model file: {}", e))?;
        let pct = if total > 0 {
            ((loaded as f64 / total as f64) * 100.0) as u8
        } else {
            0
        };
        if pct >= last_emit_pct + 2 || loaded == len || (total > 0 && loaded >= total) {
            last_emit_pct = pct;
            let _ = app.emit_to(
                "dashboard",
                "model-download-progress",
                DownloadProgress { loaded, total },
            );
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush model file: {}", e))?;

    eprintln!("[Verba] Downloaded {} to {}", filename, path_str);
    Ok(path_str)
}

// ===== APP SETUP =====

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(audio::AudioState::default())
        .manage(hotkey_state::HotkeyState::default())
        .manage(Store::default())
        .setup(|app| {
            // Load .env from app data dir so installed app finds Azure config
            if let Ok(app_data_dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(app_data_dir.as_path());
                // Azure credentials come from Dashboard → Settings only (we do not load .env).

                // Initialize the persistent store
                let store: tauri::State<'_, Store> = app.state();
                store.init(app_data_dir);
            }

            permissions::check_and_request_permissions();

            let app_handle = app.handle().clone();
            hotkey::start_hotkey_listener(app_handle);

            // Build system tray
            build_tray(app)?;

            // Dock pill at bottom-center of primary monitor on first load
            if let Some(main_win) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = main_win.primary_monitor() {
                    if let Ok(win_size) = main_win.outer_size() {
                        let mon_pos = monitor.position();
                        let mon_size = monitor.size();
                        const MARGIN_BOTTOM: i32 = 28;
                        let x = mon_pos.x + (mon_size.width as i32 - win_size.width as i32) / 2;
                        // Top-left origin: place window so its top is (margin) above the bottom of the monitor
                        let y = mon_pos.y + mon_size.height as i32 - win_size.height as i32 - MARGIN_BOTTOM;
                        let _ = main_win.set_position(PhysicalPosition::new(x, y));
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio::start_recording,
            audio::stop_recording,
            transcribe::transcribe,
            paste::paste_text,
            open_dashboard,
            get_stats,
            record_dictation,
            clear_history,
            get_dictionary,
            add_dictionary_entry,
            update_dictionary_entry,
            remove_dictionary_entry,
            get_settings,
            update_setting,
            get_api_config,
            set_api_config,
            get_transcription_config,
            set_transcription_config,
            get_default_local_model_path,
            get_default_local_model_path_for_size,
            download_local_model,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn build_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dashboard_item = MenuItemBuilder::with_id("dashboard", "Open Dashboard").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit Verba").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&dashboard_item, &quit_item])
        .build()?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .tooltip("Verba — Voice Dictation")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "dashboard" => {
                open_dashboard_window(app);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Double-click (or single click on macOS) opens dashboard
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                open_dashboard_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
