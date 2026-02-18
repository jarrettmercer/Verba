const fs = require('fs');
const path = require('path');

function validateLicenseKey(key) {
  const k = String(key).trim().toUpperCase();
  if (!k) throw new Error('Please enter a product key');
  if (k === 'VERBA-DEV-KEY-0000-0000') return;
  const parts = k.split('-');
  if (parts.length !== 5 || parts[0] !== 'VERBA') throw new Error('Invalid format. Use VERBA-XXXX-XXXX-XXXX-XXXX');
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].length !== 4 || !/^[A-Z0-9]+$/.test(parts[i])) throw new Error('Invalid format. Use VERBA-XXXX-XXXX-XXXX-XXXX');
  }
}

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
        transcription: { source: 'local', local_model_path: '', local_model_size: 'tiny' },
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

  getLicenseStatus() {
    const licensePath = path.join(this.appDataDir, 'license.json');
    if (!fs.existsSync(licensePath)) return false;
    try {
      JSON.parse(fs.readFileSync(licensePath, 'utf8'));
      return true;
    } catch (_) {
      return false;
    }
  }

  activateLicense(key) {
    validateLicenseKey(key);
    const licensePath = path.join(this.appDataDir, 'license.json');
    const data = { activated_at: Math.floor(Date.now() / 1000) };
    fs.writeFileSync(licensePath, JSON.stringify(data, null, 2));
  }

  deactivateLicense() {
    const licensePath = path.join(this.appDataDir, 'license.json');
    if (fs.existsSync(licensePath)) fs.unlinkSync(licensePath);
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
    const allowed = ['sounds_enabled', 'auto_paste', 'launch_at_login', 'hotkey_accelerator', 'hide_pill'];
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
