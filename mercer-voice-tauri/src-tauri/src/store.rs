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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub sounds_enabled: bool,
    pub auto_paste: bool,
    pub launch_at_login: bool,
    #[serde(default)]
    pub api_config: ApiConfig,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sounds_enabled: true,
            auto_paste: true,
            launch_at_login: false,
            api_config: ApiConfig::default(),
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
}

impl Default for Store {
    fn default() -> Self {
        Self {
            data: Mutex::new(StoreData::default()),
            path: Mutex::new(None),
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

    /// Resolve the Whisper endpoint: store first, then env var.
    pub fn resolve_endpoint(&self) -> Option<String> {
        let cfg = self.get_api_config();
        if !cfg.endpoint.is_empty() {
            return Some(cfg.endpoint);
        }
        std::env::var("AZURE_WHISPER_ENDPOINT").ok()
    }

    /// Resolve the Whisper API key: store first, then env var.
    pub fn resolve_api_key(&self) -> Option<String> {
        let cfg = self.get_api_config();
        if !cfg.api_key.is_empty() {
            return Some(cfg.api_key);
        }
        std::env::var("AZURE_WHISPER_API_KEY").ok()
    }
}
