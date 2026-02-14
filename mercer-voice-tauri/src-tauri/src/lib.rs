mod audio;
mod hotkey;
mod hotkey_state;
mod paste;
mod permissions;
mod sounds;
mod store;
mod transcribe;

use store::{ApiConfig, DictionaryEntry, Settings, Stats, Store};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

// ===== DASHBOARD WINDOW =====

fn open_dashboard_window(app: &tauri::AppHandle) {
    // If the window already exists, just focus it
    if let Some(window) = app.get_webview_window("dashboard") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    // Create new dashboard window
    let _window = WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::App("dashboard.html".into()))
        .title("Verba — Dashboard")
        .inner_size(880.0, 620.0)
        .min_inner_size(640.0, 480.0)
        .center()
        .decorations(true)
        .resizable(true)
        .visible(true)
        .build();
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

// ===== APP SETUP =====

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env from current directory (dev when run from project root)
    dotenvy::dotenv().ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(audio::AudioState::default())
        .manage(hotkey_state::HotkeyState::default())
        .manage(Store::default())
        .setup(|app| {
            // Load .env from app data dir so installed app finds Azure config
            if let Ok(app_data_dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(app_data_dir.as_path());
                let env_path = app_data_dir.join(".env");
                if env_path.exists() {
                    dotenvy::from_path(&env_path).ok();
                }

                // Initialize the persistent store
                let store: tauri::State<'_, Store> = app.state();
                store.init(app_data_dir);
            }

            permissions::check_and_request_permissions();

            let app_handle = app.handle().clone();
            hotkey::start_hotkey_listener(app_handle);

            // Build system tray
            build_tray(app)?;

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
