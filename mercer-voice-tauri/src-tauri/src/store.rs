use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

// ===== DATA MODELS =====

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictionaryEntry {
    pub id: String,
    pub phrase: String,
    pub replacement: Option<String>,
    pub entry_type: String, // "custom", "replacement", "blocked"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub text: String,
    pub timestamp: u64, // milliseconds since epoch
    pub word_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stats {
    pub total_dictations: u64,
    pub total_words: u64,
    pub history: Vec<HistoryEntry>,
}

impl Default for Stats {
    fn default() -> Self {
        Self {
            total_dictations: 0,
            total_words: 0,
            history: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiConfig {
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub api_key: String,
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            endpoint: String::new(),
            api_key: String::new(),
        }
    }
}

/// "azure" = cloud Whisper API; "local" = embedded whisper.cpp model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionConfig {
    #[serde(default)]
    pub source: String,
    /// Optional path to ggml model. If empty, default path under app data is used (based on local_model_size).
    #[serde(default)]
    pub local_model_path: String,
    /// Model size for default path and download: "tiny" | "small" | "medium" | "large".
    #[serde(default)]
    pub local_model_size: String,
}

impl Default for TranscriptionConfig {
    fn default() -> Self {
        Self {
            source: "azure".to_string(),
            local_model_path: String::new(),
            local_model_size: "tiny".to_string(),
        }
    }
}

/// Stored after a successful product key activation. Not the key itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseData {
    pub activated_at: u64,
}

/// Validates a product key. Returns Ok(()) if valid.
/// For production, replace this with an HTTP call to your license server.
fn validate_license_key(key: &str) -> Result<(), String> {
    let key = key.trim().to_uppercase();
    if key.is_empty() {
        return Err("Please enter a product key".to_string());
    }
    // Development key (remove or restrict in production)
    if key == "VERBA-DEV-KEY-0000-0000" {
        return Ok(());
    }
    // Format: VERBA-XXXX-XXXX-XXXX-XXXX (4 groups of 4 alphanumeric)
    let parts: Vec<&str> = key.split('-').collect();
    if parts.len() != 5 || parts[0] != "VERBA" {
        return Err("Invalid format. Use VERBA-XXXX-XXXX-XXXX-XXXX".to_string());
    }
    for part in parts.iter().skip(1) {
        if part.len() != 4 || !part.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err("Invalid format. Use VERBA-XXXX-XXXX-XXXX-XXXX".to_string());
        }
    }
    // Placeholder: accept any key that matches format. Replace with server validation or checksum.
    Ok(())
}

/// Filename for the given model size (English .en models where available).
fn model_filename_for_size(size: &str) -> &'static str {
    match size {
        "small" => "ggml-small.en.bin",
        "medium" => "ggml-medium.en.bin",
        "large" => "ggml-large-v3.bin",
        _ => "ggml-tiny.en.bin",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub sounds_enabled: bool,
    pub auto_paste: bool,
    pub launch_at_login: bool,
    #[serde(default)]
    pub api_config: ApiConfig,
    #[serde(default)]
    pub transcription: TranscriptionConfig,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sounds_enabled: true,
            auto_paste: true,
            launch_at_login: false,
            api_config: ApiConfig::default(),
            transcription: TranscriptionConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreData {
    pub stats: Stats,
    pub dictionary: Vec<DictionaryEntry>,
    pub settings: Settings,
}

impl Default for StoreData {
    fn default() -> Self {
        Self {
            stats: Stats::default(),
            dictionary: Vec::new(),
            settings: Settings::default(),
        }
    }
}

// ===== STORE STATE =====

pub struct Store {
    data: Mutex<StoreData>,
    path: Mutex<Option<PathBuf>>,
    /// Set at init; used for default local model path.
    app_data_dir: Mutex<Option<PathBuf>>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            data: Mutex::new(StoreData::default()),
            path: Mutex::new(None),
            app_data_dir: Mutex::new(None),
        }
    }
}

impl Store {
    pub fn init(&self, app_data_dir: PathBuf) {
        let store_path = app_data_dir.join("store.json");

        // Load existing data
        if store_path.exists() {
            if let Ok(contents) = fs::read_to_string(&store_path) {
                if let Ok(data) = serde_json::from_str::<StoreData>(&contents) {
                    *self.data.lock().unwrap() = data;
                }
            }
        }

        *self.path.lock().unwrap() = Some(store_path);
        *self.app_data_dir.lock().unwrap() = Some(app_data_dir.clone());
        // Create default models dir so user has a known place to put ggml-tiny.en.bin
        let models_dir = app_data_dir.join("models");
        let _ = fs::create_dir_all(models_dir);
    }

    fn save(&self) {
        let path_lock = self.path.lock().unwrap();
        if let Some(ref path) = *path_lock {
            let data = self.data.lock().unwrap();
            if let Ok(json) = serde_json::to_string_pretty(&*data) {
                let _ = fs::write(path, json);
            }
        }
    }

    // --- Stats ---

    pub fn get_stats(&self) -> Stats {
        self.data.lock().unwrap().stats.clone()
    }

    pub fn record_dictation(&self, text: &str) {
        let word_count = text.split_whitespace().count() as u32;
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let mut data = self.data.lock().unwrap();
        data.stats.total_dictations += 1;
        data.stats.total_words += word_count as u64;
        data.stats.history.push(HistoryEntry {
            text: text.to_string(),
            timestamp,
            word_count,
        });

        // Keep last 500 history entries
        if data.stats.history.len() > 500 {
            let len = data.stats.history.len();
            data.stats.history = data.stats.history[len - 500..].to_vec();
        }

        drop(data);
        self.save();
    }

    pub fn clear_history(&self) {
        let mut data = self.data.lock().unwrap();
        data.stats.history.clear();
        // Keep aggregate stats, just clear the list
        drop(data);
        self.save();
    }

    // --- Dictionary ---

    pub fn get_dictionary(&self) -> Vec<DictionaryEntry> {
        self.data.lock().unwrap().dictionary.clone()
    }

    pub fn add_dictionary_entry(&self, phrase: String, replacement: Option<String>, entry_type: String) -> DictionaryEntry {
        let id = format!("dict_{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis());

        let entry = DictionaryEntry {
            id: id.clone(),
            phrase,
            replacement,
            entry_type,
        };

        let mut data = self.data.lock().unwrap();
        data.dictionary.push(entry.clone());
        drop(data);
        self.save();
        entry
    }

    pub fn update_dictionary_entry(
        &self,
        id: &str,
        phrase: String,
        replacement: Option<String>,
        entry_type: String,
    ) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        if let Some(entry) = data.dictionary.iter_mut().find(|e| e.id == id) {
            entry.phrase = phrase;
            entry.replacement = replacement;
            entry.entry_type = entry_type;
            drop(data);
            self.save();
            Ok(())
        } else {
            Err("Entry not found".to_string())
        }
    }

    pub fn remove_dictionary_entry(&self, id: &str) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        let before = data.dictionary.len();
        data.dictionary.retain(|e| e.id != id);
        if data.dictionary.len() == before {
            return Err("Entry not found".to_string());
        }
        drop(data);
        self.save();
        Ok(())
    }

    // --- Settings ---

    pub fn get_settings(&self) -> Settings {
        self.data.lock().unwrap().settings.clone()
    }

    pub fn update_setting(&self, key: &str, value: bool) {
        let mut data = self.data.lock().unwrap();
        match key {
            "sounds_enabled" => data.settings.sounds_enabled = value,
            "auto_paste" => data.settings.auto_paste = value,
            "launch_at_login" => data.settings.launch_at_login = value,
            _ => {}
        }
        drop(data);
        self.save();
    }

    #[allow(dead_code)]
    pub fn is_sounds_enabled(&self) -> bool {
        self.data.lock().unwrap().settings.sounds_enabled
    }

    #[allow(dead_code)]
    pub fn is_auto_paste_enabled(&self) -> bool {
        self.data.lock().unwrap().settings.auto_paste
    }

    // --- API Config ---

    pub fn get_api_config(&self) -> ApiConfig {
        self.data.lock().unwrap().settings.api_config.clone()
    }

    pub fn set_api_config(&self, endpoint: String, api_key: String) {
        let mut data = self.data.lock().unwrap();
        data.settings.api_config.endpoint = endpoint;
        data.settings.api_config.api_key = api_key;
        drop(data);
        self.save();
    }

    /// Resolve the Whisper endpoint from dashboard settings only (no .env or env var fallback).
    pub fn resolve_endpoint(&self) -> Option<String> {
        let cfg = self.get_api_config();
        if !cfg.endpoint.is_empty() {
            return Some(cfg.endpoint);
        }
        None
    }

    /// Resolve the Whisper API key from dashboard settings only (no .env or env var fallback).
    pub fn resolve_api_key(&self) -> Option<String> {
        let cfg = self.get_api_config();
        if !cfg.api_key.is_empty() {
            return Some(cfg.api_key);
        }
        None
    }

    // --- Transcription config (Azure vs Local) ---

    pub fn get_transcription_config(&self) -> TranscriptionConfig {
        self.data.lock().unwrap().settings.transcription.clone()
    }

    pub fn set_transcription_config(
        &self,
        source: String,
        local_model_path: String,
        local_model_size: String,
    ) {
        let mut data = self.data.lock().unwrap();
        data.settings.transcription.source = source;
        data.settings.transcription.local_model_path = local_model_path;
        data.settings.transcription.local_model_size = normalize_model_size(&local_model_size);
        drop(data);
        self.save();
    }

    /// Default path for a given size (for UI preview). Does not use custom path.
    pub fn get_default_local_model_path_for_size(&self, size: &str) -> Option<String> {
        let app_dir = self.app_data_dir.lock().unwrap().clone()?;
        let name = model_filename_for_size(size);
        let p = app_dir.join("models").join(name);
        Some(p.to_string_lossy().to_string())
    }

    /// Preferred transcription source: "azure" or "local".
    pub fn transcription_source(&self) -> String {
        let s = self.data.lock().unwrap().settings.transcription.source.clone();
        if s == "local" { "local".to_string() } else { "azure".to_string() }
    }

    /// Path to the local Whisper model file. Uses custom path if set, else default under app data for current size.
    pub fn resolve_local_model_path(&self) -> Option<PathBuf> {
        let cfg = self.get_transcription_config();
        if !cfg.local_model_path.is_empty() {
            let p = PathBuf::from(&cfg.local_model_path);
            return Some(p);
        }
        let app_dir = self.app_data_dir.lock().unwrap().clone()?;
        let name = model_filename_for_size(&cfg.local_model_size);
        let default_path = app_dir.join("models").join(name);
        Some(default_path)
    }

    /// Default path where the app looks for the local model (for display in UI). Uses current size from config.
    pub fn get_default_local_model_path(&self) -> Option<String> {
        let cfg = self.get_transcription_config();
        self.get_default_local_model_path_for_size(&cfg.local_model_size)
    }

    // --- License (product key) ---

    fn license_path(&self) -> Result<PathBuf, String> {
        self.app_data_dir
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "App not initialized".to_string())
            .map(|d| d.join("license.json"))
    }

    pub fn get_license_status(&self) -> bool {
        let path = match self.license_path() {
            Ok(p) => p,
            Err(_) => return false,
        };
        if !path.exists() {
            return false;
        }
        if let Ok(contents) = fs::read_to_string(&path) {
            if let Ok(_data) = serde_json::from_str::<LicenseData>(&contents) {
                return true;
            }
        }
        false
    }

    pub fn activate_license(&self, key: &str) -> Result<(), String> {
        validate_license_key(key)?;
        let path = self.license_path()?;
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let activated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let data = LicenseData { activated_at };
        let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn deactivate_license(&self) -> Result<(), String> {
        let path = self.license_path()?;
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn normalize_model_size(s: &str) -> String {
    let t = s.trim().to_lowercase();
    match t.as_str() {
        "small" | "medium" | "large" => t,
        _ => "tiny".to_string(),
    }
}
