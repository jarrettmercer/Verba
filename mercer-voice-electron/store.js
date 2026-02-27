const fs = require('fs');
const path = require('path');

function modelFilenameForSize(size) {
  switch (String(size).toLowerCase()) {
    case 'small': return 'ggml-small.en.bin';
    case 'medium': return 'ggml-medium.en.bin';
    case 'large': return 'ggml-large-v3.bin';
    default: return 'ggml-tiny.en.bin';
  }
}

class Store {
  constructor(app) {
    this.app = app;
    this.data = null;
    this.storePath = null;
    this.appDataDir = null;
  }

  init(userDataPath) {
    this.appDataDir = userDataPath;
    this.storePath = path.join(userDataPath, 'store.json');
    this.data = {
      stats: { totalDictations: 0, totalWords: 0, history: [] },
      dictionary: [],
      settings: {
        sounds_enabled: true,
        auto_paste: true,
        launch_at_login: false,
        hotkey_accelerator: process.platform === 'darwin' ? 'Command+Shift+Space' : 'Control+Shift+Space',
        api_config: { endpoint: '', api_key: '' },
        transcription: { source: 'local', local_model_path: '', local_model_size: 'small' },
      },
    };
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf8');
        const loaded = JSON.parse(raw);
        if (loaded.stats) this.data.stats = loaded.stats;
        if (Array.isArray(loaded.dictionary)) this.data.dictionary = loaded.dictionary;
        if (loaded.settings) this.data.settings = { ...this.data.settings, ...loaded.settings };
      }
    } catch (_) {}
    const modelsDir = path.join(userDataPath, 'models');
    try { fs.mkdirSync(modelsDir, { recursive: true }); } catch (_) {}
    this.save();
  }

  save() {
    if (!this.storePath) return;
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('[Store] save failed', e);
    }
  }

  getStats() {
    const s = this.data.stats;
    return {
      total_dictations: s.totalDictations || 0,
      total_words: s.totalWords || 0,
      history: [...(s.history || [])],
    };
  }

  recordDictation(text) {
    const wordCount = (text || '').split(/\s+/).filter(Boolean).length;
    this.data.stats.totalDictations = (this.data.stats.totalDictations || 0) + 1;
    this.data.stats.totalWords = (this.data.stats.totalWords || 0) + wordCount;
    this.data.stats.history = this.data.stats.history || [];
    this.data.stats.history.push({ text: String(text), timestamp: Date.now(), word_count: wordCount });
    if (this.data.stats.history.length > 500) this.data.stats.history = this.data.stats.history.slice(-500);
    this.save();
  }

  clearHistory() {
    this.data.stats.history = [];
    this.save();
  }

  getDictionary() {
    return [...(this.data.dictionary || [])];
  }

  addDictionaryEntry(phrase, replacement, entry_type) {
    const id = 'dict_' + Date.now();
    const entry = { id, phrase, replacement: replacement || null, entry_type };
    this.data.dictionary.push(entry);
    this.save();
    return entry;
  }

  updateDictionaryEntry(id, phrase, replacement, entry_type) {
    const i = (this.data.dictionary || []).findIndex(e => e.id === id);
    if (i === -1) throw new Error('Entry not found');
    this.data.dictionary[i] = { ...this.data.dictionary[i], phrase, replacement: replacement || null, entry_type };
    this.save();
  }

  removeDictionaryEntry(id) {
    const before = (this.data.dictionary || []).length;
    this.data.dictionary = (this.data.dictionary || []).filter(e => e.id !== id);
    if (this.data.dictionary.length === before) throw new Error('Entry not found');
    this.save();
  }

  getSettings() {
    return { ...this.data.settings };
  }

  updateSetting(key, value) {
    const allowed = ['sounds_enabled', 'auto_paste', 'launch_at_login', 'hotkey_accelerator', 'hide_pill', 'paste_delay_ms'];
    if (this.data.settings[key] !== undefined || allowed.includes(key)) this.data.settings[key] = value;
    this.save();
  }

  getApiConfig() {
    return { ...this.data.settings.api_config };
  }

  setApiConfig(endpoint, apiKey) {
    this.data.settings.api_config = { endpoint: String(endpoint), api_key: String(apiKey) };
    this.save();
  }

  getTranscriptionConfig() {
    return { ...this.data.settings.transcription };
  }

  setTranscriptionConfig(source, localModelPath, localModelSize) {
    const size = ['small', 'medium', 'large'].includes(String(localModelSize).toLowerCase()) ? String(localModelSize).toLowerCase() : 'tiny';
    this.data.settings.transcription = { source: String(source), local_model_path: String(localModelPath), local_model_size: size };
    this.save();
  }

  getDefaultLocalModelPath() {
    return this.getDefaultLocalModelPathForSize(this.data.settings.transcription.local_model_size || 'tiny');
  }

  getDefaultLocalModelPathForSize(size) {
    const name = modelFilenameForSize(size);
    return path.join(this.appDataDir, 'models', name);
  }

  resolveLocalModelPath() {
    const cfg = this.data.settings.transcription || {};
    const custom = (cfg.local_model_path || '').trim();
    if (custom && fs.existsSync(custom)) return custom;
    return this.getDefaultLocalModelPath();
  }
}

module.exports = Store;
