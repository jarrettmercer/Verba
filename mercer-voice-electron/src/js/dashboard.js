const { invoke, listen, platform } = window.api;
const isMac = platform === 'darwin';
const isWindows = platform === 'win32';

// ===== TAB NAVIGATION =====
const navButtons = document.querySelectorAll('.nav-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        navButtons.forEach(b => b.classList.remove('active'));
        tabPanels.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${tab}`).classList.add('active');
    });
});

// ===== STATS =====
async function loadStats() {
    try {
        const stats = await invoke('get_stats');
        document.getElementById('stat-dictations').textContent = stats.total_dictations.toLocaleString();
        document.getElementById('stat-words').textContent = stats.total_words.toLocaleString();

        // Time saved: assume typing speed 40 WPM, dictation is ~3x faster
        const minutesSaved = Math.round((stats.total_words / 40) * 0.66);
        if (minutesSaved >= 60) {
            const hours = Math.floor(minutesSaved / 60);
            const mins = minutesSaved % 60;
            document.getElementById('stat-time-saved').textContent = `${hours}h ${mins}m`;
        } else {
            document.getElementById('stat-time-saved').textContent = `${minutesSaved}m`;
        }

        const avg = stats.total_dictations > 0
            ? Math.round(stats.total_words / stats.total_dictations)
            : 0;
        document.getElementById('stat-avg-length').textContent = avg.toLocaleString();

        renderRecentActivity(stats.history || []);
    } catch (err) {
        console.error('Failed to load stats:', err);
    }
}

function renderRecentActivity(history) {
    const container = document.getElementById('recent-activity');
    const recent = history.slice(-8).reverse();

    if (recent.length === 0) {
        container.innerHTML = '<div class="empty-state">No dictations yet. Start talking!</div>';
        return;
    }

    container.innerHTML = recent.map(entry => {
        const words = entry.text.split(/\s+/).filter(w => w.length > 0).length;
        const time = formatTimeAgo(entry.timestamp);
        const truncated = entry.text.length > 80 ? entry.text.slice(0, 80) + '...' : entry.text;
        return `
            <div class="activity-item">
                <span class="activity-text">${escapeHtml(truncated)}</span>
                <span class="activity-words">${words} words</span>
                <span class="activity-meta">${time}</span>
            </div>
        `;
    }).join('');
}

// ===== DICTIONARY =====
let dictEntries = [];
let editingId = null;

async function loadDictionary() {
    try {
        dictEntries = await invoke('get_dictionary');
        renderDictionary();
    } catch (err) {
        console.error('Failed to load dictionary:', err);
    }
}

function renderDictionary(filter = '') {
    const container = document.getElementById('dict-list');
    const filtered = filter
        ? dictEntries.filter(e =>
            e.phrase.toLowerCase().includes(filter) ||
            (e.replacement || '').toLowerCase().includes(filter))
        : dictEntries;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state">No dictionary entries yet. Add custom words and replacements.</div>';
        return;
    }

    container.innerHTML = filtered.map(entry => {
        const typeClass = entry.entry_type || 'custom';
        const typeLabel = typeClass === 'replacement' ? 'Replace' : typeClass === 'blocked' ? 'Block' : 'Custom';
        const hasReplacement = entry.entry_type === 'replacement' && entry.replacement;

        return `
            <div class="dict-entry" data-id="${escapeHtml(entry.id)}">
                <span class="dict-phrase">${escapeHtml(entry.phrase)}</span>
                ${hasReplacement ? `
                    <span class="dict-arrow">&rarr;</span>
                    <span class="dict-replacement-text">${escapeHtml(entry.replacement)}</span>
                ` : '<span style="flex:1"></span>'}
                <span class="dict-type-badge ${typeClass}">${typeLabel}</span>
                <div class="dict-actions">
                    <button class="dict-action-btn edit" title="Edit" onclick="editEntry('${escapeHtml(entry.id)}')">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                        </svg>
                    </button>
                    <button class="dict-action-btn delete" title="Delete" onclick="deleteEntry('${escapeHtml(entry.id)}')">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// Dictionary form handling
const dictForm = document.getElementById('dict-form');
const btnAddWord = document.getElementById('btn-add-word');
const btnCancelWord = document.getElementById('btn-cancel-word');
const btnSaveWord = document.getElementById('btn-save-word');
const dictSearch = document.getElementById('dict-search');

btnAddWord.addEventListener('click', () => {
    editingId = null;
    document.getElementById('dict-phrase').value = '';
    document.getElementById('dict-replacement').value = '';
    document.getElementById('dict-type').value = 'custom';
    dictForm.style.display = 'block';
    document.getElementById('dict-phrase').focus();
});

btnCancelWord.addEventListener('click', () => {
    dictForm.style.display = 'none';
    editingId = null;
});

btnSaveWord.addEventListener('click', async () => {
    const phrase = document.getElementById('dict-phrase').value.trim();
    const replacement = document.getElementById('dict-replacement').value.trim();
    const entryType = document.getElementById('dict-type').value;

    if (!phrase) return;

    try {
        if (editingId) {
            await invoke('update_dictionary_entry', {
                id: editingId,
                phrase,
                replacement: replacement || null,
                entryType,
            });
        } else {
            await invoke('add_dictionary_entry', {
                phrase,
                replacement: replacement || null,
                entryType,
            });
        }

        dictForm.style.display = 'none';
        editingId = null;
        await loadDictionary();
    } catch (err) {
        console.error('Failed to save dictionary entry:', err);
    }
});

dictSearch.addEventListener('input', () => {
    renderDictionary(dictSearch.value.toLowerCase());
});

window.editEntry = function(id) {
    const entry = dictEntries.find(e => e.id === id);
    if (!entry) return;

    editingId = id;
    document.getElementById('dict-phrase').value = entry.phrase;
    document.getElementById('dict-replacement').value = entry.replacement || '';
    document.getElementById('dict-type').value = entry.entry_type || 'custom';
    dictForm.style.display = 'block';
    document.getElementById('dict-phrase').focus();
};

window.deleteEntry = async function(id) {
    try {
        await invoke('remove_dictionary_entry', { id });
        await loadDictionary();
    } catch (err) {
        console.error('Failed to delete entry:', err);
    }
};

// ===== HISTORY =====
let historyEntries = [];

async function loadHistory() {
    try {
        const stats = await invoke('get_stats');
        historyEntries = (stats.history || []).slice().reverse();
        renderHistory();
    } catch (err) {
        console.error('Failed to load history:', err);
    }
}

function renderHistory(filter = '') {
    const container = document.getElementById('history-list');
    const filtered = filter
        ? historyEntries.filter(e => e.text.toLowerCase().includes(filter))
        : historyEntries;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state">No history yet. Your dictations will appear here.</div>';
        return;
    }

    container.innerHTML = filtered.map((entry, i) => {
        const words = entry.text.split(/\s+/).filter(w => w.length > 0).length;
        const time = formatTimeAgo(entry.timestamp);
        return `
            <div class="history-item">
                <div class="history-text">${escapeHtml(entry.text)}</div>
                <div class="history-meta">
                    <span class="history-time">${time}</span>
                    <span class="history-word-count">${words} words</span>
                </div>
                <button class="history-copy-btn" title="Copy to clipboard" onclick="copyHistoryText(${i})">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                </button>
            </div>
        `;
    }).join('');
}

const historySearch = document.getElementById('history-search');
historySearch.addEventListener('input', () => {
    renderHistory(historySearch.value.toLowerCase());
});

document.getElementById('btn-clear-history').addEventListener('click', async () => {
    try {
        await invoke('clear_history');
        historyEntries = [];
        renderHistory();
        await loadStats();
    } catch (err) {
        console.error('Failed to clear history:', err);
    }
});

window.copyHistoryText = async function(index) {
    const entry = historyEntries[index];
    if (!entry) return;
    try {
        await navigator.clipboard.writeText(entry.text);
    } catch (_) {
        // Fallback: invoke main process to copy
        try {
            await invoke('paste_text', { text: entry.text, targetBundleId: null });
        } catch (e) {
            console.error('Failed to copy:', e);
        }
    }
};

// ===== SETTINGS =====
const settingSounds = document.getElementById('setting-sounds');
const settingAutoPaste = document.getElementById('setting-auto-paste');
const settingLaunchAtLogin = document.getElementById('setting-launch-at-login');
const settingHidePill = document.getElementById('setting-hide-pill');
const settingPillPosition = document.getElementById('setting-pill-position');
const settingPillSize = document.getElementById('setting-pill-size');
const settingPillOpacity = document.getElementById('setting-pill-opacity');
const pillOpacityValue = document.getElementById('pill-opacity-value');

async function loadSettings() {
    try {
        const settings = await invoke('get_settings');
        settingSounds.checked = settings.sounds_enabled !== false;
        settingAutoPaste.checked = settings.auto_paste !== false;
        settingLaunchAtLogin.checked = settings.launch_at_login === true;
        if (settingHidePill) settingHidePill.checked = settings.hide_pill === true;
        if (settingPillPosition) settingPillPosition.value = settings.pill_position ?? 'bottom-center';
        if (settingPillSize) settingPillSize.value = settings.pill_size ?? 'small';
        if (settingPillOpacity && pillOpacityValue) {
            const opacityPct = Math.round((settings.pill_opacity ?? 1) * 100);
            settingPillOpacity.value = opacityPct;
            pillOpacityValue.textContent = opacityPct + '%';
        }
    } catch (_) {
        // Defaults
    }

    const hotkeySelectEl = document.getElementById('hotkey-select');
    const statusEl = document.getElementById('hotkey-status');
    try {
        const acc = await invoke('get_hotkey_accelerator');
        if (hotkeySelectEl) {
            const match = Array.from(hotkeySelectEl.options).find(o => o.value === acc);
            if (match) hotkeySelectEl.value = acc;
            else hotkeySelectEl.value = hotkeySelectEl.options[0].value;
        }
    } catch (_) {}
    if (typeof updateFnKeyNote === 'function') {
        updateFnKeyNote();
    }
    if (statusEl) {
        invoke('get_hotkey_registered').then((ok) => {
            statusEl.textContent = ok ? 'Shortcut registered.' : 'Shortcut not registered — choose a different shortcut or free it in System Settings.';
            statusEl.style.color = ok ? 'var(--color-success)' : 'var(--color-error)';
        }).catch(() => { statusEl.textContent = ''; });
    }
}

settingSounds.addEventListener('change', () => {
    invoke('update_setting', { key: 'sounds_enabled', value: settingSounds.checked }).catch(console.error);
});

settingAutoPaste.addEventListener('change', () => {
    invoke('update_setting', { key: 'auto_paste', value: settingAutoPaste.checked }).catch(console.error);
});

settingLaunchAtLogin.addEventListener('change', () => {
    invoke('update_setting', { key: 'launch_at_login', value: settingLaunchAtLogin.checked }).catch(console.error);
});

if (settingHidePill) {
    settingHidePill.addEventListener('change', () => {
        invoke('update_setting', { key: 'hide_pill', value: settingHidePill.checked }).catch(console.error);
    });
}

if (settingPillPosition) {
    settingPillPosition.addEventListener('change', () => {
        invoke('update_setting', { key: 'pill_position', value: settingPillPosition.value }).catch(console.error);
    });
}

if (settingPillSize) {
    settingPillSize.addEventListener('change', () => {
        invoke('update_setting', { key: 'pill_size', value: settingPillSize.value }).catch(console.error);
    });
}

if (settingPillOpacity) {
    settingPillOpacity.addEventListener('input', () => {
        const pct = Number(settingPillOpacity.value);
        if (pillOpacityValue) pillOpacityValue.textContent = pct + '%';
        invoke('update_setting', { key: 'pill_opacity', value: pct / 100 }).catch(console.error);
    });
}

// ===== HOTKEY: DROPDOWN CHANGE =====
const hotkeySelect = document.getElementById('hotkey-select');
const hotkeyStatus = document.getElementById('hotkey-status');
const fnKeyNote = document.getElementById('fn-key-note');

// Populate hotkey options based on platform
(function populateHotkeyOptions() {
    if (!hotkeySelect) return;
    const options = isMac ? [
        { value: 'Fn', label: 'Fn (Globe key)' },
        { value: 'Command+Shift+Space', label: 'Cmd + Shift + Space' },
        { value: 'Control+Option+Space', label: 'Ctrl + Opt + Space' },
        { value: 'Command+Option+Space', label: 'Cmd + Opt + Space' },
        { value: 'Command+Shift+V', label: 'Cmd + Shift + V' },
        { value: 'F5', label: 'F5' },
        { value: 'F6', label: 'F6' },
        { value: 'F7', label: 'F7' },
        { value: 'F8', label: 'F8' },
    ] : [
        { value: 'RightControl', label: 'Right Ctrl (Push to Talk)' },
        { value: 'RightShift', label: 'Right Shift (Push to Talk)' },
        { value: 'RightAlt', label: 'Right Alt (Push to Talk)' },
        { value: 'Control+Shift+Space', label: 'Ctrl + Shift + Space' },
        { value: 'Alt+Shift+Space', label: 'Alt + Shift + Space' },
        { value: 'Control+Alt+Space', label: 'Ctrl + Alt + Space' },
        { value: 'Control+Shift+V', label: 'Ctrl + Shift + V' },
        { value: 'Control+Shift+D', label: 'Ctrl + Shift + D' },
        { value: 'Control+Space', label: 'Ctrl + Space' },
        { value: 'F5', label: 'F5' },
        { value: 'F6', label: 'F6' },
        { value: 'F7', label: 'F7' },
        { value: 'F8', label: 'F8' },
        { value: 'F9', label: 'F9' },
        { value: 'F10', label: 'F10' },
        { value: 'F11', label: 'F11' },
        { value: 'F12', label: 'F12' },
    ];
    hotkeySelect.innerHTML = '';
    options.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        hotkeySelect.appendChild(opt);
    });

    // Platform-specific hint text
    const hintEl = document.getElementById('hotkey-platform-hint');
    if (hintEl) {
        hintEl.textContent = isMac
            ? 'On Mac, if the shortcut doesn\'t work when another app is focused, add Verba (or Electron) in System Settings \u2192 Privacy & Security \u2192 Accessibility.'
            : 'If the shortcut conflicts with another app, try a different combination.';
    }
})();

const pushToTalkLabels = {
    RightControl: 'Hold the Right Ctrl key to record, release to stop and transcribe. The left Ctrl key is unaffected.',
    RightShift: 'Hold the Right Shift key to record, release to stop and transcribe. The left Shift key is unaffected.',
    RightAlt: 'Hold the Right Alt key to record, release to stop and transcribe. The left Alt key is unaffected.',
};

function updateFnKeyNote() {
    if (fnKeyNote) {
        const val = hotkeySelect && hotkeySelect.value;
        if (val === 'Fn') {
            fnKeyNote.style.display = '';
            // Reset to macOS Fn key content
            const nameEl = fnKeyNote.querySelector('.setting-name');
            const descEl = fnKeyNote.querySelector('.setting-description');
            const btnEl = fnKeyNote.querySelector('#btn-open-keyboard-settings');
            if (nameEl) nameEl.textContent = 'Globe / Fn key tip';
            if (descEl) descEl.innerHTML = 'Verba remaps the Globe key to F18 at the system level while running. To prevent the emoji picker from also opening, set <strong>"Press globe key to: Do Nothing"</strong> in System Settings &gt; Keyboard. The remap is automatically removed when Verba quits.';
            if (btnEl) btnEl.style.display = '';
        } else if (pushToTalkLabels[val]) {
            fnKeyNote.style.display = '';
            const nameEl = fnKeyNote.querySelector('.setting-name');
            const descEl = fnKeyNote.querySelector('.setting-description');
            const btnEl = fnKeyNote.querySelector('#btn-open-keyboard-settings');
            if (nameEl) nameEl.textContent = 'Push to Talk';
            if (descEl) descEl.textContent = pushToTalkLabels[val];
            if (btnEl) btnEl.style.display = 'none';
        } else {
            fnKeyNote.style.display = 'none';
        }
    }
}

if (hotkeySelect) {
    updateFnKeyNote();
    hotkeySelect.addEventListener('change', async () => {
        const accelerator = hotkeySelect.value;
        updateFnKeyNote();
        if (hotkeyStatus) hotkeyStatus.textContent = '';
        try {
            const result = await invoke('set_hotkey_accelerator', { accelerator });
            if (hotkeyStatus) {
                hotkeyStatus.textContent = result.ok ? 'Shortcut registered.' : 'Shortcut in use elsewhere — try another.';
                hotkeyStatus.style.color = result.ok ? 'var(--color-success)' : 'var(--color-error)';
            }
        } catch (err) {
            if (hotkeyStatus) {
                hotkeyStatus.textContent = err?.message || 'Failed to set shortcut';
                hotkeyStatus.style.color = 'var(--color-error)';
            }
        }
    });
}

// ===== FN KEY HELPERS =====
const btnOpenKeyboardSettings = document.getElementById('btn-open-keyboard-settings');
if (btnOpenKeyboardSettings) {
    btnOpenKeyboardSettings.addEventListener('click', () => {
        invoke('open_keyboard_settings').catch(console.error);
    });
}

// ===== TRANSCRIPTION CONFIG (Azure vs Local) =====
const sourceAzure = document.getElementById('source-azure');
const sourceLocal = document.getElementById('source-local');
const transcriptionAzureFields = document.getElementById('transcription-azure-fields');
const transcriptionLocalFields = document.getElementById('transcription-local-fields');
const localModelPathInput = document.getElementById('setting-local-model-path');
const localModelSizeSelect = document.getElementById('setting-local-model-size');
const btnSaveTranscription = document.getElementById('btn-save-transcription');
const transcriptionStatus = document.getElementById('transcription-status');

function updateTranscriptionFieldsVisibility() {
    const useLocal = sourceLocal && sourceLocal.checked;
    if (transcriptionAzureFields) transcriptionAzureFields.style.display = useLocal ? 'none' : 'block';
    if (transcriptionLocalFields) transcriptionLocalFields.style.display = useLocal ? 'block' : 'none';
}

async function updateDefaultPathForSize(size) {
    try {
        const path = await invoke('get_default_local_model_path_for_size', { size: size || 'tiny' });
        const pathEl = document.getElementById('local-model-default-path');
        if (pathEl) pathEl.textContent = path ? `Default: ${path}` : 'Default: (unknown)';
    } catch (_) {}
}

async function loadTranscriptionConfig() {
    try {
        const [config, defaultPath] = await Promise.all([
            invoke('get_transcription_config'),
            invoke('get_default_local_model_path').catch(() => null),
        ]);
        const source = (config.source || 'azure').toLowerCase();
        if (source === 'local') {
            if (sourceLocal) sourceLocal.checked = true;
            if (sourceAzure) sourceAzure.checked = false;
        } else {
            if (sourceAzure) sourceAzure.checked = true;
            if (sourceLocal) sourceLocal.checked = false;
        }
        if (localModelPathInput) localModelPathInput.value = config.local_model_path || '';
        const size = (config.local_model_size || 'tiny').toLowerCase();
        if (localModelSizeSelect) localModelSizeSelect.value = ['tiny', 'small', 'medium', 'large'].includes(size) ? size : 'tiny';
        const pathEl = document.getElementById('local-model-default-path');
        if (pathEl) pathEl.textContent = defaultPath ? `Default: ${defaultPath}` : 'Default: (unknown)';
        updateTranscriptionFieldsVisibility();
    } catch (_) {}
}

if (sourceAzure) sourceAzure.addEventListener('change', updateTranscriptionFieldsVisibility);
if (sourceLocal) sourceLocal.addEventListener('change', updateTranscriptionFieldsVisibility);

if (localModelSizeSelect) {
    localModelSizeSelect.addEventListener('change', () => {
        updateDefaultPathForSize(localModelSizeSelect.value);
    });
}

btnSaveTranscription.addEventListener('click', async () => {
    const source = sourceLocal && sourceLocal.checked ? 'local' : 'azure';
    const localModelPath = (localModelPathInput && localModelPathInput.value.trim()) || '';
    const localModelSize = (localModelSizeSelect && localModelSizeSelect.value) || 'tiny';

    try {
        await invoke('set_transcription_config', { source, localModelPath, localModelSize });
        if (transcriptionStatus) {
            transcriptionStatus.textContent = 'Saved';
            transcriptionStatus.className = 'api-status success';
            setTimeout(() => { transcriptionStatus.textContent = ''; }, 3000);
        }
    } catch (err) {
        if (transcriptionStatus) {
            transcriptionStatus.textContent = 'Failed to save';
            transcriptionStatus.className = 'api-status error';
        }
        console.error('Failed to save transcription config:', err);
    }
});

// Download local model in-app with progress bar
const btnDownloadModel = document.getElementById('btn-download-model');
const modelDownloadStatus = document.getElementById('model-download-status');
const modelDownloadProgressWrap = document.getElementById('model-download-progress-wrap');
const modelDownloadProgressFill = document.getElementById('model-download-progress-fill');
const modelDownloadProgressText = document.getElementById('model-download-progress-text');

function showDownloadProgress(show) {
    if (modelDownloadProgressWrap) modelDownloadProgressWrap.style.display = show ? 'flex' : 'none';
    if (modelDownloadProgressFill) modelDownloadProgressFill.style.width = '0%';
    if (modelDownloadProgressText) modelDownloadProgressText.textContent = '0%';
}

function setDownloadProgress(loaded, total) {
    if (!modelDownloadProgressFill || !modelDownloadProgressText) return;
    const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    modelDownloadProgressFill.style.width = pct + '%';
    if (total > 0) {
        const loadedMB = (loaded / 1024 / 1024).toFixed(1);
        const totalMB = (total / 1024 / 1024).toFixed(1);
        modelDownloadProgressText.textContent = pct + '% (' + loadedMB + ' / ' + totalMB + ' MB)';
    } else {
        modelDownloadProgressText.textContent = (loaded / 1024 / 1024).toFixed(1) + ' MB…';
    }
}

if (btnDownloadModel) {
    let unlistenProgress = null;
    btnDownloadModel.addEventListener('click', async () => {
        if (modelDownloadStatus) {
            modelDownloadStatus.textContent = 'Starting…';
            modelDownloadStatus.className = 'api-status';
        }
        showDownloadProgress(true);
        setDownloadProgress(0, 0);
        btnDownloadModel.disabled = true;
        unlistenProgress = await listen('model-download-progress', (event) => {
            const p = event.payload;
            if (p && typeof p.loaded === 'number') setDownloadProgress(p.loaded, p.total || 0);
        });
        try {
            const selectedSize = (localModelSizeSelect && localModelSizeSelect.value) || 'tiny';
            const path = await invoke('download_local_model', { size: selectedSize });
            if (modelDownloadStatus) {
                modelDownloadStatus.textContent = 'Downloaded';
                modelDownloadStatus.className = 'api-status success';
                setTimeout(() => { modelDownloadStatus.textContent = ''; }, 5000);
            }
        } catch (err) {
            if (modelDownloadStatus) {
                modelDownloadStatus.textContent = err && (err.message || String(err)) || 'Download failed';
                modelDownloadStatus.className = 'api-status error';
            }
            console.error('Model download failed:', err);
        }
        if (unlistenProgress && typeof unlistenProgress === 'function') unlistenProgress();
        showDownloadProgress(false);
        btnDownloadModel.disabled = false;
    });
}

// ===== API CONFIG =====
const apiEndpointInput = document.getElementById('setting-api-endpoint');
const apiKeyInput = document.getElementById('setting-api-key');
const btnToggleKey = document.getElementById('btn-toggle-key');
const btnSaveApi = document.getElementById('btn-save-api');
const apiStatus = document.getElementById('api-status');

async function loadApiConfig() {
    try {
        const config = await invoke('get_api_config');
        apiEndpointInput.value = config.endpoint || '';
        apiKeyInput.value = config.api_key || '';
    } catch (_) {}
}

btnToggleKey.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
});

btnSaveApi.addEventListener('click', async () => {
    const endpoint = apiEndpointInput.value.trim();
    const apiKey = apiKeyInput.value.trim();

    if (!endpoint || !apiKey) {
        apiStatus.textContent = 'Both endpoint and API key are required';
        apiStatus.className = 'api-status error';
        return;
    }

    try {
        await invoke('set_api_config', { endpoint, apiKey: apiKey });
        apiStatus.textContent = 'Saved successfully';
        apiStatus.className = 'api-status success';
        setTimeout(() => { apiStatus.textContent = ''; }, 3000);
    } catch (err) {
        apiStatus.textContent = 'Failed to save';
        apiStatus.className = 'api-status error';
        console.error('Failed to save API config:', err);
    }
});

// ===== UTILITY =====
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    const now = Date.now();
    const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    const diff = now - ts;

    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
}

// ===== LIVE UPDATES =====
// Listen for stats updates from the pill window's dictation flow
listen('stats-updated', () => {
    loadStats();
    loadHistory();
});

// ===== AUTO-UPDATE NOTIFICATIONS =====
const updateBanner = document.getElementById('update-banner');
const updateBannerText = document.getElementById('update-banner-text');
const btnRestartUpdate = document.getElementById('btn-restart-update');
const btnCheckUpdates = document.getElementById('btn-check-updates');
const updateProgress = document.getElementById('update-progress');
const updateProgressText = document.getElementById('update-progress-text');
const updateProgressPct = document.getElementById('update-progress-pct');
const updateProgressFill = document.getElementById('update-progress-fill');
let checkUpdateTimer = null;

function clearCheckTimer() { clearTimeout(checkUpdateTimer); checkUpdateTimer = null; }

function setCheckUpdatesState(state, label) {
    if (!btnCheckUpdates) return;
    btnCheckUpdates.textContent = label;
    btnCheckUpdates.disabled = state === 'busy';
}

listen('update-error', (event) => {
    clearCheckTimer();
    const msg = event.payload && event.payload.message;
    console.error('[Verba updater] Error received in UI:', msg);
    if (updateProgress) updateProgress.style.display = 'none';
    if (btnCheckUpdates) {
        btnCheckUpdates.textContent = 'Update check failed';
        btnCheckUpdates.title = msg || 'Unknown error';
        btnCheckUpdates.disabled = false;
        setTimeout(() => {
            setCheckUpdatesState('idle', 'Check for updates');
            btnCheckUpdates.title = '';
        }, 4000);
    }
});

listen('update-available', (event) => {
    clearCheckTimer();
    const version = event.payload && event.payload.version;
    setCheckUpdatesState('busy', version ? `Downloading v${version}…` : 'Downloading…');
    if (updateProgress) updateProgress.style.display = 'block';
    if (updateProgressText) updateProgressText.textContent = version ? `Downloading v${version}` : 'Downloading update…';
});

listen('update-not-available', () => {
    clearCheckTimer();
    setCheckUpdatesState('idle', 'Up to date ✓');
    setTimeout(() => setCheckUpdatesState('idle', 'Check for updates'), 3000);
});

listen('update-download-progress', (event) => {
    const pct = event.payload && Math.round(event.payload.percent);
    if (updateProgressPct) updateProgressPct.textContent = `${pct}%`;
    if (updateProgressFill) updateProgressFill.style.width = `${pct}%`;
});

let updateReady = false;

function showUpdateReadyUI(version) {
    updateReady = true;
    if (updateProgress) updateProgress.style.display = 'none';
    setCheckUpdatesState('idle', 'Restart to update');
    if (updateBannerText) {
        updateBannerText.textContent = version
            ? `Verba v${version} is ready to install.`
            : 'A new version of Verba is ready to install.';
    }
    if (updateBanner) updateBanner.style.display = 'flex';
}

listen('update-downloaded', (event) => {
    const version = event.payload && event.payload.version;
    console.log('[Verba updater] update-downloaded event received, version:', version);
    showUpdateReadyUI(version);
});

// Catch updates that finished downloading before the dashboard opened
invoke('get_update_ready').then((info) => {
    if (info && info.version) {
        console.log('[Verba updater] update already ready on dashboard open, version:', info.version);
        showUpdateReadyUI(info.version);
    }
}).catch(() => {});

function triggerInstallUpdate() {
    console.log('[Verba updater] Restart to update clicked — invoking install-update');
    invoke('install-update')
        .then(() => console.log('[Verba updater] install-update IPC resolved'))
        .catch((err) => console.error('[Verba updater] install-update IPC rejected:', err));
}

if (btnCheckUpdates) {
    btnCheckUpdates.addEventListener('click', () => {
        // If update is downloaded, install instead of checking
        if (updateReady) {
            triggerInstallUpdate();
            return;
        }
        setCheckUpdatesState('busy', 'Checking…');
        // Safety timeout — reset if no event fires within 15 seconds
        clearCheckTimer();
        checkUpdateTimer = setTimeout(() => {
            if (btnCheckUpdates.disabled) {
                setCheckUpdatesState('idle', 'Check for updates');
            }
        }, 15000);
        invoke('check_for_updates').catch(() => {
            clearCheckTimer();
            setCheckUpdatesState('idle', 'Check for updates');
        });
    });
}

if (btnRestartUpdate) {
    btnRestartUpdate.addEventListener('click', triggerInstallUpdate);
}

// ===== PLATFORM-SPECIFIC UI =====
(function adjustPlatformUI() {
    if (!isMac) {
        // Hide Mac-only settings rows on Windows/Linux
        const rowAccessibility = document.getElementById('row-accessibility');
        if (rowAccessibility) rowAccessibility.style.display = 'none';

        // Update microphone description for Windows
        const micDesc = document.getElementById('microphone-description');
        if (micDesc) micDesc.textContent = 'Verba needs microphone access. If recording doesn\'t work, open Microphone Settings and make sure apps can access your microphone.';

        // Relabel the "Open Microphone Settings" button for Windows
        const btnOpenMic = document.getElementById('btn-open-microphone');
        if (btnOpenMic) btnOpenMic.textContent = 'Open Microphone Settings';
    }
})();

// ===== INIT =====
async function initDashboard() {
    await Promise.all([
        loadStats(),
        loadDictionary(),
        loadHistory(),
        loadSettings(),
        loadTranscriptionConfig(),
        loadApiConfig(),
    ]);
}

// ===== LICENSE GATE (dashboard is used for activation at same size as dashboard) =====
const licenseScreen = document.getElementById('license-screen');
const licenseContent = document.getElementById('dashboard-content');

/** Format license key as user types: VERBA-XXXX-XXXX-XXXX-XXXX (uppercase, alphanumeric only). */
function formatLicenseKeyInput(inputEl) {
    if (!inputEl) return;
    const raw = inputEl.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 21);
    const parts = [];
    parts.push(raw.slice(0, 5));   // VERBA
    parts.push(raw.slice(5, 9));   // XXXX
    parts.push(raw.slice(9, 13));
    parts.push(raw.slice(13, 17));
    parts.push(raw.slice(17, 21));
    const formatted = parts.filter(Boolean).join('-');
    const contentBefore = inputEl.value.slice(0, inputEl.selectionStart).replace(/[^A-Za-z0-9]/g, '').length;

    inputEl.value = formatted;

    let newPos = 0;
    let count = 0;
    for (let i = 0; i < formatted.length && count < contentBefore; i++) {
        newPos = i + 1;
        if (formatted[i] !== '-') count++;
    }
    inputEl.setSelectionRange(newPos, newPos);
}

// Attach formatter once so it works on first load and after Deactivate
const licenseKeyInputEl = document.getElementById('license-key-input');
if (licenseKeyInputEl) {
    licenseKeyInputEl.addEventListener('input', function () {
        formatLicenseKeyInput(licenseKeyInputEl);
    });
}

async function checkLicenseAndInit() {
    try {
        const licensed = await invoke('get_license_status');
        if (licensed) {
            if (licenseScreen) licenseScreen.style.display = 'none';
            if (licenseContent) licenseContent.style.display = 'flex';
            await initDashboard();
        } else {
            if (licenseScreen) licenseScreen.style.display = 'flex';
            if (licenseContent) licenseContent.style.display = 'none';
            const input = document.getElementById('license-key-input');
            const btn = document.getElementById('license-activate-btn');
            const errEl = document.getElementById('license-error');
            async function doActivate() {
                const key = (input && input.value) ? input.value.trim() : '';
                if (errEl) errEl.textContent = '';
                if (!key) {
                    if (errEl) errEl.textContent = 'Please enter a product key.';
                    return;
                }
                try {
                    await invoke('activate_license', { key });
                    if (licenseScreen) licenseScreen.style.display = 'none';
                    if (licenseContent) licenseContent.style.display = 'flex';
                    await initDashboard();
                } catch (e) {
                    if (errEl) errEl.textContent = (e && (e.message || String(e))) || 'Invalid key.';
                }
            }
            if (btn) btn.addEventListener('click', doActivate);
            if (input) {
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doActivate(); });
                input.focus();
            }
        }
    } catch (_) {
        if (licenseScreen) licenseScreen.style.display = 'flex';
        if (licenseContent) licenseContent.style.display = 'none';
    }
}

// Reset license / Deactivate — show license screen again (Settings → About)
const btnOpenAccessibility = document.getElementById('btn-open-accessibility');
if (btnOpenAccessibility) {
    btnOpenAccessibility.addEventListener('click', () => {
        invoke('open_accessibility_settings').catch(console.error);
    });
}
const btnOpenMicrophone = document.getElementById('btn-open-microphone');
if (btnOpenMicrophone) {
    btnOpenMicrophone.addEventListener('click', () => {
        invoke('open_microphone_settings').catch(console.error);
    });
}
const btnRequestMicrophone = document.getElementById('btn-request-microphone');
if (btnRequestMicrophone) {
    btnRequestMicrophone.addEventListener('click', async () => {
        try {
            const result = await invoke('request_microphone_access');
            if (result && result.granted) {
                btnRequestMicrophone.textContent = 'Access granted';
                setTimeout(() => { btnRequestMicrophone.textContent = 'Request access'; }, 3000);
            } else if (isWindows && result && result.error) {
                // Windows: settings page was opened, show helpful message
                btnRequestMicrophone.textContent = 'Settings opened — enable mic, then retry';
                setTimeout(() => { btnRequestMicrophone.textContent = 'Request access'; }, 8000);
            } else {
                btnRequestMicrophone.textContent = 'Denied — open Microphone Settings to enable';
                setTimeout(() => { btnRequestMicrophone.textContent = 'Request access'; }, 5000);
            }
        } catch (e) {
            console.error(e);
            btnRequestMicrophone.textContent = 'Failed — try Open Microphone Settings';
            setTimeout(() => { btnRequestMicrophone.textContent = 'Request access'; }, 4000);
        }
    });
}
const btnDeactivateLicense = document.getElementById('btn-deactivate-license');
if (btnDeactivateLicense) {
    btnDeactivateLicense.addEventListener('click', async () => {
        try {
            await invoke('deactivate_license');
            if (licenseScreen) licenseScreen.style.display = 'flex';
            if (licenseContent) licenseContent.style.display = 'none';
            const input = document.getElementById('license-key-input');
            if (input) {
                input.value = '';
                input.focus();
            }
        } catch (e) {
            console.error('Deactivate failed', e);
        }
    });
}

// ===== APP VERSION =====
invoke('get_app_version').then(version => {
    const sidebarVersion = document.getElementById('sidebar-version');
    const aboutVersion = document.getElementById('about-version');
    if (sidebarVersion) sidebarVersion.textContent = `v${version}`;
    if (aboutVersion) aboutVersion.textContent = `Version ${version} — Voice dictation for your desktop`;
}).catch(() => {});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkLicenseAndInit);
} else {
    checkLicenseAndInit();
}
