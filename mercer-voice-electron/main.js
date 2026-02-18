const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, screen, nativeImage, systemPreferences, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync, spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const Store = require('./store.js');
const { transcribe } = require('./transcribe.js');
const { pasteText } = require('./paste.js');
const { writeWavFromRendererBuffer } = require('./record.js');

// Route all logs to ~/Library/Logs/Verba/main.log (macOS) or %APPDATA%\Verba\logs\main.log (Windows)
log.transports.file.level = 'debug';
log.transports.console.level = 'debug';
Object.assign(console, log.functions);

// Resolve the actual Electron binary path (for Accessibility prompting)
const ELECTRON_BINARY = process.execPath;

let mainWindow = null;
let dashboardWindow = null;
let tray = null;
let store = null;
let updateDownloadedInfo = null;

function getAssetPath(...p) {
  return path.join(__dirname, 'src', ...p);
}

/**
 * Return the display area and margin for pill positioning.
 * On Windows, use workArea (excludes the taskbar) so the pill sits above it.
 * On macOS, use full bounds (macOS dock behaviour is already handled).
 */
function getPillArea() {
  const primary = screen.getPrimaryDisplay();
  if (process.platform === 'win32') {
    const wa = primary.workArea;
    return { x: wa.x, y: wa.y, width: wa.width, height: wa.height, margin: 10 };
  }
  return { x: primary.bounds.x, y: primary.bounds.y, width: primary.size.width, height: primary.size.height, margin: 28 };
}

function createMainWindow() {
  const preloadPath = path.resolve(__dirname, 'preload.js');
  const indexPath = path.resolve(__dirname, 'src', 'index.html');
  if (!fs.existsSync(indexPath)) console.error('[Verba] index.html not found at', indexPath);
  if (!fs.existsSync(preloadPath)) console.error('[Verba] preload.js not found at', preloadPath);

  const iconPath = path.join(__dirname, 'build', 'icon.png');

  const win = new BrowserWindow({
    width: 145,
    height: 36,
    resizable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    ...(process.platform === 'win32' ? { backgroundColor: '#00000000', thickFrame: false } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(indexPath);

  const area = getPillArea();
  const w = 145;
  const h = 36;
  win.setBounds({
    x: Math.floor(area.x + (area.width - w) / 2),
    y: Math.floor(area.y + area.height - h - area.margin),
    width: w,
    height: h,
  });

  win.once('ready-to-show', () => { win.show(); });
  win.on('closed', () => { mainWindow = null; });
  return win;
}

function createDashboardWindow() {
  if (dashboardWindow) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  dashboardWindow = new BrowserWindow({
    width: 880,
    height: 620,
    minWidth: 640,
    minHeight: 480,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dashboardWindow.loadFile(path.resolve(__dirname, 'src', 'dashboard.html'));
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
}

let setupWindow = null;
function createSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 520, height: 620, resizable: false, center: true,
    alwaysOnTop: false,
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.resolve(__dirname, 'src', 'permissions.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

function buildTray() {
  const iconPath = path.join(__dirname, 'src', 'icons', 'tray-icon.png');
  let icon = nativeImage.createEmpty();
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
    if (process.platform === 'darwin') {
      icon.setTemplateImage(true);
    }
  }
  tray = new Tray(icon);
  tray.setToolTip('Verba');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => createDashboardWindow() },
    { label: 'Open Developer Tools (pill)', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.openDevTools({ mode: 'detach' }); } },
    { type: 'separator' },
    { label: 'Quit Verba', click: () => app.quit() },
  ]));
  tray.on('click', () => createDashboardWindow());
}

// ---- Global hotkey ----
let hotkeyRecording = false;
let lastRegisteredAccelerator = null;
let hotkeyRegistered = false;
let fnTapProcess = null;
let rctrlHookProcess = null;

// ---- Pill visibility ----

function isPillHidden() {
  return store && store.getSettings().hide_pill === true;
}

function positionPillForRecording() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const area = getPillArea();
  const w = 145, h = 36, margin = 12;
  const bounds = { x: Math.floor(area.x + area.width - w - margin), y: Math.floor(area.y + margin), width: w, height: h };
  console.log('[Verba] positionPillForRecording ->', bounds);
  mainWindow.setBounds(bounds);
}

function positionPillDefault() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const area = getPillArea();
  const w = 145, h = 36;
  const position = store ? (store.getSettings().pill_position || 'bottom-center') : 'bottom-center';
  const margin = area.margin;
  let x, y;
  switch (position) {
    case 'bottom-left':
      x = Math.floor(area.x + margin);
      y = Math.floor(area.y + area.height - h - margin);
      break;
    case 'bottom-right':
      x = Math.floor(area.x + area.width - w - margin);
      y = Math.floor(area.y + area.height - h - margin);
      break;
    case 'top-center':
      x = Math.floor(area.x + (area.width - w) / 2);
      y = Math.floor(area.y + margin);
      break;
    case 'top-left':
      x = Math.floor(area.x + margin);
      y = Math.floor(area.y + margin);
      break;
    case 'top-right':
      x = Math.floor(area.x + area.width - w - margin);
      y = Math.floor(area.y + margin);
      break;
    case 'bottom-center':
    default:
      x = Math.floor(area.x + (area.width - w) / 2);
      y = Math.floor(area.y + area.height - h - margin);
      break;
  }
  console.log('[Verba] positionPillDefault position=%s bounds={x:%d,y:%d}', position, x, y);
  mainWindow.setBounds({ x, y, width: w, height: h });
}

/**
 * Calculate bounds for the expanded toast+pill window, respecting pill_position.
 * For bottom positions the window grows upward; for top positions it grows downward.
 */
function getToastBounds(TOAST_W, TOAST_H) {
  const area = getPillArea();
  const position = store ? (store.getSettings().pill_position || 'bottom-center') : 'bottom-center';
  const margin = area.margin;
  const isTop = position.startsWith('top');
  let x, y;
  if (position.endsWith('left')) {
    x = Math.floor(area.x + margin);
  } else if (position.endsWith('right')) {
    x = Math.floor(area.x + area.width - TOAST_W - margin);
  } else {
    x = Math.floor(area.x + (area.width - TOAST_W) / 2);
  }
  y = isTop
    ? Math.floor(area.y + margin)
    : Math.floor(area.y + area.height - TOAST_H - margin);
  console.log('[Verba] getToastBounds position=%s isTop=%s bounds={x:%d,y:%d,w:%d,h:%d}', position, isTop, x, y, TOAST_W, TOAST_H);
  return { x, y, width: TOAST_W, height: TOAST_H };
}

function hidePillIfNeeded() {
  if (isPillHidden() && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
}

function showPillForRecording() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  console.log('[Verba] showPillForRecording isPillHidden=%s', isPillHidden());
  if (isPillHidden()) {
    positionPillForRecording();
  }
  mainWindow.showInactive();
}

function getFrontmostAppBundleIdAsync(callback) {
  if (process.platform !== 'darwin') { callback(null); return; }
  exec(
    'osascript -e \'tell application "System Events" to get bundle identifier of first application process whose frontmost is true\'',
    { encoding: 'utf8', timeout: 2000 },
    (err, stdout) => {
      if (err || !stdout) { callback(null); return; }
      const bid = stdout.trim();
      callback(bid && bid.toLowerCase() !== 'missing value' ? bid : null);
    }
  );
}

function runHotkeyAction(press, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed() || wc.isCrashed()) return;
    if (press) {
      showPillForRecording();
    } else {
      mainWindow.showInactive();
    }
    wc.send(press ? 'hotkey-pressed' : 'hotkey-released', payload !== undefined ? payload : undefined);
  } catch (e) {
    if (e.message && e.message.includes('disposed')) return;
    console.error('[Verba] Hotkey send failed', e);
  }
}

function onHotkeyPress() {
  if (hotkeyRecording) return;
  hotkeyRecording = true;
  console.log('[Verba] Hotkey PRESSED');
  runHotkeyAction(true, null);
  // Resolve frontmost app asynchronously so we don't block recording start
  getFrontmostAppBundleIdAsync((bundleId) => {
    console.log('[Verba] Frontmost app resolved:', bundleId);
    if (bundleId && mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('set-paste-target', bundleId); } catch (_) {}
    }
  });
}

function onHotkeyRelease() {
  if (!hotkeyRecording) return;
  hotkeyRecording = false;
  console.log('[Verba] Hotkey RELEASED');
  runHotkeyAction(false);
}

// Toggle for keyboard shortcuts (press once = start, again = stop)
function toggleHotkey() {
  if (!hotkeyRecording) {
    onHotkeyPress();
  } else {
    onHotkeyRelease();
  }
}

// ---- Fn/Globe key via CGEventTap (hold-to-record) ----

function startFnKeyTap() {
  if (process.platform !== 'darwin') return false;
  const helperPath = path.join(__dirname, 'helpers', 'fn-key-tap').replace('app.asar', 'app.asar.unpacked');
  if (!fs.existsSync(helperPath)) {
    console.warn('[Verba] fn-key-tap helper not found at', helperPath);
    return false;
  }

  stopFnKeyTap();

  fnTapProcess = spawn(helperPath, [], { stdio: ['ignore', 'pipe', 'pipe'] });

  let lineBuffer = '';
  fnTapProcess.stdout.on('data', (data) => {
    lineBuffer += data.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop();
    for (const line of lines) {
      const cmd = line.trim();
      if (cmd === 'PRESS') onHotkeyPress();
      else if (cmd === 'RELEASE') onHotkeyRelease();
    }
  });

  fnTapProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log('[Verba][fn-tap]', msg);
  });

  fnTapProcess.on('exit', (code) => {
    console.log('[Verba] fn-key-tap exited with code', code);
    fnTapProcess = null;
  });

  console.log('[Verba] Fn key listener started (CGEventTap, hold-to-record)');
  return true;
}

function stopFnKeyTap() {
  if (fnTapProcess) {
    fnTapProcess.kill();
    fnTapProcess = null;
  }
}

// ---- Push-to-talk via low-level keyboard hook (Windows, hold-to-record) ----

// Map push-to-talk key names to Windows virtual key codes
const PUSH_TO_TALK_KEYS = {
  RightControl: 0xA3,
  RightShift:   0xA1,
  RightAlt:     0xA5,
};

function startRCtrlHook(keyName) {
  if (process.platform !== 'win32') return false;
  const helperPath = path.join(__dirname, 'helpers', 'rctrl-hook.ps1').replace('app.asar', 'app.asar.unpacked');
  if (!fs.existsSync(helperPath)) {
    console.warn('[Verba] rctrl-hook.ps1 not found at', helperPath);
    return false;
  }

  stopRCtrlHook();

  const vkCode = PUSH_TO_TALK_KEYS[keyName] || 0xA3;

  rctrlHookProcess = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath, '-VkCode', String(vkCode),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let lineBuffer = '';
  rctrlHookProcess.stdout.on('data', (data) => {
    lineBuffer += data.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop();
    for (const line of lines) {
      const cmd = line.trim();
      if (cmd === 'PRESS') onHotkeyPress();
      else if (cmd === 'RELEASE') onHotkeyRelease();
    }
  });

  rctrlHookProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log('[Verba][key-hook]', msg);
  });

  rctrlHookProcess.on('exit', (code) => {
    console.log('[Verba] key-hook exited with code', code);
    rctrlHookProcess = null;
  });

  console.log('[Verba] Push-to-talk hook started for', keyName, '(VK 0x' + vkCode.toString(16).toUpperCase() + ')');
  return true;
}

function stopRCtrlHook() {
  if (rctrlHookProcess) {
    rctrlHookProcess.kill();
    rctrlHookProcess = null;
  }
}

// ---- Accessibility check ----
function requestAccessibilityIfNeeded() {
  if (process.platform !== 'darwin') return;
  try {
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    console.log('[Verba] Accessibility trusted:', trusted);
    if (!trusted) {
      systemPreferences.isTrustedAccessibilityClient(true);
      console.log('[Verba] Prompted user for Accessibility permission');
    }
  } catch (e) {
    console.warn('[Verba] Accessibility check failed:', e.message);
  }
}

// ---- Accelerator-based shortcuts ----

function getHotkeyAccelerators() {
  const preferred = (store.getSettings().hotkey_accelerator || '').trim();
  if (preferred === 'Fn') return process.platform === 'darwin'
    ? ['Command+Shift+Space', 'Control+Option+Space']
    : ['Control+Shift+Space', 'Alt+Shift+Space'];
  const fallbacks = process.platform === 'darwin'
    ? ['Command+Shift+Space', 'Control+Option+Space']
    : ['Control+Shift+Space', 'Alt+Shift+Space'];
  const list = preferred && preferred !== fallbacks[0] ? [preferred, ...fallbacks] : fallbacks;
  return [...new Set(list)];
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  stopFnKeyTap();
  stopRCtrlHook();
  lastRegisteredAccelerator = null;

  const preferred = (store.getSettings().hotkey_accelerator || '').trim();
  console.log('[Verba] registerHotkey() preferred:', JSON.stringify(preferred));

  // Fn/Globe key: use CGEventTap helper for hold-to-record
  if (preferred === 'Fn' && process.platform === 'darwin') {
    if (startFnKeyTap()) {
      lastRegisteredAccelerator = 'Fn';
      return true;
    }
    console.warn('[Verba] Fn key tap failed, falling back to keyboard shortcut');
  }

  // Push-to-talk keys: use low-level keyboard hook for hold-to-record (Windows)
  if (PUSH_TO_TALK_KEYS[preferred] && process.platform === 'win32') {
    if (startRCtrlHook(preferred)) {
      lastRegisteredAccelerator = preferred;
      return true;
    }
    console.warn('[Verba] Push-to-talk hook failed for', preferred, ', falling back to keyboard shortcut');
  }

  const accelerators = getHotkeyAccelerators();
  let registered = false;
  for (const accelerator of accelerators) {
    if (!accelerator) continue;
    const ok = globalShortcut.register(accelerator, toggleHotkey);
    if (ok) {
      registered = true;
      lastRegisteredAccelerator = accelerator;
      console.log('[Verba] Global hotkey registered:', accelerator);
      break;
    }
    console.warn('[Verba] Hotkey already in use:', accelerator);
  }
  if (!registered) {
    console.error('[Verba] Could not register any global hotkey.');
  }
  return registered;
}

// ---- IPC handlers (registered when app is ready) ----
let dragOffset = null;

function registerIpcHandlers() {
  // License
  ipcMain.handle('get_license_status', () => store.getLicenseStatus());
  ipcMain.handle('activate_license', (_, arg) => {
    const key = arg && typeof arg === 'object' && 'key' in arg ? arg.key : arg;
    return store.activateLicense(key);
  });
  ipcMain.handle('deactivate_license', () => store.deactivateLicense());
  ipcMain.handle('finish_activation', () => {
    if (mainWindow) {
      console.log('[Verba] finish_activation — repositioning pill');
      positionPillDefault();
    }
    return Promise.resolve();
  });

  // Recording
  ipcMain.handle('start_recording', async () => {
    if (!store.getLicenseStatus()) return Promise.reject(new Error('Please activate with a product key first'));
    if (mainWindow) mainWindow.webContents.send('recording-started');
    return Promise.resolve();
  });

  ipcMain.handle('stop_recording', async (_, payload) => {
    const dir = app.getPath('temp');
    if (mainWindow) mainWindow.webContents.send('recording-stopped');
    if (!payload || !payload.buffer) {
      return { ok: false, error: 'Microphone access needed. Enable "Verba" (or "Electron" in dev) in System Settings → Privacy & Security → Microphone, then restart.' };
    }
    const buf = payload.buffer;
    let buffer;
    try {
      buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer || buf);
    } catch (e) {
      return { ok: false, error: 'Could not read audio. Try again or grant microphone access.' };
    }
    const sampleRate = payload.sampleRate || 44100;
    const wavPath = writeWavFromRendererBuffer(buffer, sampleRate, dir);
    if (!wavPath) {
      return { ok: false, error: 'Recording too short. Hold the hotkey or pill longer while speaking.' };
    }
    return { ok: true, wavPath };
  });

  ipcMain.handle('transcribe', async (_, payload) => {
    const wavPath = payload && payload.wavPath;
    if (!wavPath) return Promise.reject(new Error('No audio path'));
    return transcribe(store, wavPath);
  });

  ipcMain.handle('paste_text', async (_, { text, targetBundleId }) => {
    return pasteText(text, targetBundleId);
  });

  // Navigation
  ipcMain.handle('open_dashboard', () => {
    createDashboardWindow();
    return Promise.resolve();
  });

  // System settings openers
  ipcMain.handle('open_accessibility_settings', () => {
    if (process.platform === 'darwin') {
      require('child_process').spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], { detached: true, stdio: 'ignore' });
    }
    return Promise.resolve();
  });

  ipcMain.handle('open_microphone_settings', () => {
    if (process.platform === 'darwin') {
      require('child_process').spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'], { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      exec('start ms-settings:privacy-microphone', { shell: true });
    }
    return Promise.resolve();
  });

  ipcMain.handle('open_keyboard_settings', () => {
    if (process.platform === 'darwin') {
      require('child_process').spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Keyboard'], { detached: true, stdio: 'ignore' });
    }
    return Promise.resolve();
  });

  ipcMain.handle('open_input_monitoring_settings', () => {
    if (process.platform === 'darwin') {
      require('child_process').spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'], { detached: true, stdio: 'ignore' });
    }
    return Promise.resolve();
  });

  ipcMain.handle('check_permissions', () => {
    if (process.platform !== 'darwin') return { mic: 'granted', accessibility: true };
    const mic = systemPreferences.getMediaAccessStatus('microphone');
    const accessibility = systemPreferences.isTrustedAccessibilityClient(false);
    return { mic, accessibility };
  });

  ipcMain.handle('get_app_version', () => app.getVersion());

  ipcMain.handle('check_for_updates', () => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[Verba updater] Manual check failed:', err.message);
    });
  });

  // Microphone permission
  ipcMain.handle('request_microphone_access', async () => {
    if (process.platform === 'win32') {
      // On Windows, trigger the mic permission prompt by requesting media access
      // through the renderer's getUserMedia (Electron will show the OS prompt)
      try {
        const status = systemPreferences.getMediaAccessStatus('microphone');
        if (status === 'granted') return { granted: true };
        // Open Windows microphone privacy settings so user can enable it
        exec('start ms-settings:privacy-microphone', { shell: true });
        return { granted: false, error: 'Please enable microphone access for Verba in the Settings window that just opened, then try again.' };
      } catch (err) {
        return { granted: false, error: err.message };
      }
    }
    if (process.platform !== 'darwin') return { granted: true };
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      return { granted };
    } catch (err) {
      return { granted: false, error: err.message };
    }
  });

  // Stats / dictation
  ipcMain.handle('get_stats', () => store.getStats());
  ipcMain.handle('record_dictation', (_, { text }) => {
    store.recordDictation(text);
    if (dashboardWindow) dashboardWindow.webContents.send('stats-updated');
  });
  ipcMain.handle('clear_history', () => store.clearHistory());

  // Dictionary
  ipcMain.handle('get_dictionary', () => store.getDictionary());
  ipcMain.handle('add_dictionary_entry', (_, arg) =>
    store.addDictionaryEntry(arg.phrase, arg.replacement, arg.entry_type || arg.entryType));
  ipcMain.handle('update_dictionary_entry', (_, arg) =>
    store.updateDictionaryEntry(arg.id, arg.phrase, arg.replacement, arg.entry_type || arg.entryType));
  ipcMain.handle('remove_dictionary_entry', (_, { id }) => store.removeDictionaryEntry(id));

  // Settings
  ipcMain.handle('get_settings', () => store.getSettings());
  ipcMain.handle('update_setting', (_, { key, value }) => {
    store.updateSetting(key, value);
    if (key === 'hide_pill') {
      if (value) {
        hidePillIfNeeded();
      } else if (!value && mainWindow && !mainWindow.isDestroyed()) {
        positionPillDefault();
        mainWindow.showInactive();
      }
    } else if (key === 'pill_position') {
      positionPillDefault();
    } else if (key === 'pill_opacity' || key === 'pill_size') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const s = store.getSettings();
        const payload = { opacity: s.pill_opacity, size: s.pill_size };
        console.log('[Verba] pill-appearance-changed ->', payload);
        mainWindow.webContents.send('pill-appearance-changed', payload);
      }
    }
  });

  ipcMain.handle('get_pill_appearance', () => {
    const s = store.getSettings();
    return { position: s.pill_position, opacity: s.pill_opacity, size: s.pill_size, hide_pill: s.hide_pill };
  });

  // Pill returned to idle — hide if setting is on
  ipcMain.on('pill-idle', () => {
    if (isPillHidden()) {
      positionPillDefault();
      hidePillIfNeeded();
    }
  });

  // Hotkey
  ipcMain.handle('get_hotkey_accelerator', () =>
    store.getSettings().hotkey_accelerator || (process.platform === 'darwin' ? 'Command+Shift+Space' : 'Control+Shift+Space'));
  ipcMain.handle('set_hotkey_accelerator', (_, { accelerator }) => {
    if (!accelerator || typeof accelerator !== 'string') return { ok: false, error: 'Invalid shortcut' };
    store.updateSetting('hotkey_accelerator', accelerator.trim());
    hotkeyRegistered = registerHotkey();
    return { ok: hotkeyRegistered, accelerator: lastRegisteredAccelerator || accelerator.trim() };
  });
  ipcMain.handle('get_hotkey_registered', () => hotkeyRegistered);

  // API / transcription config
  ipcMain.handle('get_api_config', () => store.getApiConfig());
  ipcMain.handle('set_api_config', (_, { endpoint, apiKey }) => store.setApiConfig(endpoint, apiKey));

  ipcMain.handle('get_transcription_config', () => store.getTranscriptionConfig());
  ipcMain.handle('set_transcription_config', (_, { source, localModelPath, localModelSize }) =>
    store.setTranscriptionConfig(source, localModelPath, localModelSize));
  ipcMain.handle('get_default_local_model_path', () => store.getDefaultLocalModelPath());
  ipcMain.handle('get_default_local_model_path_for_size', (_, { size }) => store.getDefaultLocalModelPathForSize(size));
  ipcMain.handle('download_local_model', async (_, { size }) => {
    const { downloadLocalModel } = require('./download-model.js');
    return downloadLocalModel(app, dashboardWindow, store, size);
  });

  // Auto-update
  ipcMain.handle('install-update', () => {
    console.log('[Verba updater] install-update IPC received — scheduling quitAndInstall() via setImmediate');
    // Use setImmediate so the IPC response is sent back to the renderer before
    // quitAndInstall() triggers app.quit(), which would otherwise close the
    // IPC channel mid-response and abort the install on macOS.
    setImmediate(() => {
      try {
        console.log('[Verba updater] calling quitAndInstall()');
        autoUpdater.quitAndInstall(false, true);
      } catch (err) {
        console.error('[Verba updater] quitAndInstall() threw:', err.message, err.stack);
      }
    });
    return Promise.resolve();
  });

  ipcMain.handle('get_update_ready', () => updateDownloadedInfo);

  // Window drag
  ipcMain.on('window-drag-start', (_, { offsetX, offsetY }) => {
    dragOffset = { x: offsetX, y: offsetY };
  });
  ipcMain.on('window-drag-move', (_, { screenX, screenY }) => {
    if (!mainWindow || !dragOffset) return;
    mainWindow.setPosition(Math.round(screenX - dragOffset.x), Math.round(screenY - dragOffset.y));
  });
  ipcMain.on('window-drag-end', () => {
    dragOffset = null;
  });

  // Toast resize — expand window to fit toast above pill, shrink back when dismissed
  const PILL_W = 145, PILL_H = 36;
  const TOAST_STACK_W = 380, TOAST_STACK_H = 106;

  ipcMain.on('toast-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    console.log('[Verba] toast-show — expanding window');
    mainWindow.setBounds(getToastBounds(TOAST_STACK_W, TOAST_STACK_H));
  });

  ipcMain.on('toast-hide', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    console.log('[Verba] toast-hide — restoring pill position');
    if (isPillHidden()) {
      positionPillForRecording();
      return;
    }
    positionPillDefault();
  });
}

app.whenReady().then(() => {
  console.log('[Verba] Starting — app path:', __dirname);
  console.log('[Verba] Electron binary:', ELECTRON_BINARY);
  console.log('[Verba] macOS version:', process.getSystemVersion ? process.getSystemVersion() : 'unknown');
  app.setName('Verba');

  // Set dock icon on macOS
  if (process.platform === 'darwin' && app.dock) {
    const dockIconPath = path.join(__dirname, 'build', 'icon.png');
    if (fs.existsSync(dockIconPath)) {
      app.dock.setIcon(dockIconPath);
    }
  }

  // Set explicit application menu so macOS menu bar shows "Verba"
  const appMenu = Menu.buildFromTemplate([
    {
      label: 'Verba',
      submenu: [
        { role: 'about', label: 'About Verba' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Verba' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Verba' },
      ],
    },
    { role: 'editMenu' },
  ]);
  Menu.setApplicationMenu(appMenu);

  store = new Store(app);
  store.init(app.getPath('userData'));

  registerIpcHandlers();

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') {
      callback(true);
      return;
    }
    callback(false);
  });

  mainWindow = createMainWindow();
  console.log('[Verba] Applying startup pill position from store:', store.getSettings().pill_position || 'bottom-center (default)');
  positionPillDefault();
  buildTray();

  hotkeyRegistered = registerHotkey();

  mainWindow.webContents.on('did-finish-load', () => {
    if (!store.getLicenseStatus()) createDashboardWindow();
    if (process.platform === 'darwin') {
      const mic = systemPreferences.getMediaAccessStatus('microphone');
      const accessibility = systemPreferences.isTrustedAccessibilityClient(false);
      if (mic !== 'granted' || !accessibility) {
        createSetupWindow();
      }
    }
    // Hide pill on startup if setting is enabled
    hidePillIfNeeded();
  });

  // Auto-update: check after a short delay, then periodically
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  function sendUpdateStatus(channel, payload) {
    const windows = [dashboardWindow, mainWindow];
    for (const win of windows) {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send(channel, payload); } catch (_) {}
      }
    }
  }

  autoUpdater.on('checking-for-update', () => {
    console.log('[Verba updater] Checking for update... (current version:', app.getVersion() + ')');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[Verba updater] Update available:', info.version);
    sendUpdateStatus('update-available', { version: info.version });
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[Verba updater] Already up to date. Latest:', info.version);
    sendUpdateStatus('update-not-available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[Verba updater] Downloading... ${Math.round(progress.percent)}% (${progress.transferred}/${progress.total} bytes)`);
    sendUpdateStatus('update-download-progress', {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Verba updater] Update downloaded:', info.version, '— will install on next quit');
    updateDownloadedInfo = { version: info.version };
    sendUpdateStatus('update-downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[Verba updater] Error:', err.message);
    sendUpdateStatus('update-error', { message: err.message });
  });

  setTimeout(() => {
    console.log('[Verba updater] Running initial update check...');
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[Verba updater] Initial check failed:', err.message);
    });
  }, 10000);

  setInterval(() => {
    console.log('[Verba updater] Running periodic update check...');
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[Verba updater] Periodic check failed:', err.message);
    });
  }, 30 * 60 * 1000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopFnKeyTap();
  stopRCtrlHook();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    mainWindow = createMainWindow();
    hotkeyRegistered = registerHotkey();
  }
});
