const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, screen, nativeImage, systemPreferences, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync, spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const Store = require('./store.js');
const { transcribe } = require('./transcribe.js');
const { pasteText } = require('./paste.js');
const { writeWavFromRendererBuffer } = require('./record.js');

// Resolve the actual Electron binary path (for Accessibility prompting)
const ELECTRON_BINARY = process.execPath;

let mainWindow = null;
let dashboardWindow = null;
let tray = null;
let store = null;

function getAssetPath(...p) {
  return path.join(__dirname, 'src', ...p);
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

  const primary = screen.getPrimaryDisplay();
  const marginBottom = 28;
  const w = 145;
  const h = 36;
  win.setBounds({
    x: Math.floor(primary.bounds.x + (primary.size.width - w) / 2),
    y: Math.floor(primary.bounds.y + primary.size.height - h - marginBottom),
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
    mainWindow.showInactive();
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

// ---- Right Ctrl key via low-level keyboard hook (Windows, hold-to-record) ----

function startRCtrlHook() {
  if (process.platform !== 'win32') return false;
  const helperPath = path.join(__dirname, 'helpers', 'rctrl-hook.ps1').replace('app.asar', 'app.asar.unpacked');
  if (!fs.existsSync(helperPath)) {
    console.warn('[Verba] rctrl-hook.ps1 not found at', helperPath);
    return false;
  }

  stopRCtrlHook();

  rctrlHookProcess = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
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
    if (msg) console.log('[Verba][rctrl-hook]', msg);
  });

  rctrlHookProcess.on('exit', (code) => {
    console.log('[Verba] rctrl-hook exited with code', code);
    rctrlHookProcess = null;
  });

  console.log('[Verba] Right Ctrl hook started (low-level keyboard hook, hold-to-record)');
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

  // Right Control: use low-level keyboard hook for hold-to-record (Windows)
  if (preferred === 'RightControl' && process.platform === 'win32') {
    if (startRCtrlHook()) {
      lastRegisteredAccelerator = 'RightControl';
      return true;
    }
    console.warn('[Verba] RCtrl hook failed, falling back to keyboard shortcut');
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
      mainWindow.setSize(145, 36);
      const primary = screen.getPrimaryDisplay();
      const marginBottom = 28;
      const w = 145, h = 36;
      mainWindow.setBounds({
        x: Math.floor(primary.bounds.x + (primary.size.width - w) / 2),
        y: Math.floor(primary.bounds.y + primary.size.height - h - marginBottom),
        width: w,
        height: h,
      });
    }
    return Promise.resolve();
  });

  // Recording
  ipcMain.handle('start_recording', async () => {
    if (!store.getLicenseStatus()) return Promise.reject(new Error('Please activate with a product key first'));
    if (process.platform === 'darwin') {
      try {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (!granted) {
          if (mainWindow) mainWindow.webContents.send('recording-failed', 'Microphone access was denied. Enable it in System Settings → Privacy & Security → Microphone.');
          return Promise.reject(new Error('Microphone access denied'));
        }
      } catch (err) {
        if (mainWindow) mainWindow.webContents.send('recording-failed', err.message || 'Microphone access failed');
        return Promise.reject(err);
      }
    }
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
    }
    return Promise.resolve();
  });

  ipcMain.handle('open_keyboard_settings', () => {
    if (process.platform === 'darwin') {
      require('child_process').spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Keyboard'], { detached: true, stdio: 'ignore' });
    }
    return Promise.resolve();
  });

  // Microphone permission
  ipcMain.handle('request_microphone_access', async () => {
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
  ipcMain.handle('update_setting', (_, { key, value }) => store.updateSetting(key, value));

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
    autoUpdater.quitAndInstall();
  });

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
  const MARGIN_BOTTOM = 28;

  ipcMain.on('toast-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const primary = screen.getPrimaryDisplay();
    mainWindow.setBounds({
      x: Math.floor(primary.bounds.x + (primary.size.width - TOAST_STACK_W) / 2),
      y: Math.floor(primary.bounds.y + primary.size.height - TOAST_STACK_H - MARGIN_BOTTOM),
      width: TOAST_STACK_W,
      height: TOAST_STACK_H,
    });
  });

  ipcMain.on('toast-hide', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const primary = screen.getPrimaryDisplay();
    mainWindow.setBounds({
      x: Math.floor(primary.bounds.x + (primary.size.width - PILL_W) / 2),
      y: Math.floor(primary.bounds.y + primary.size.height - PILL_H - MARGIN_BOTTOM),
      width: PILL_W,
      height: PILL_H,
    });
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
  buildTray();

  // Request Accessibility permission (needed for global shortcuts on newer macOS)
  if (process.platform === 'darwin') {
    requestAccessibilityIfNeeded();
  }

  hotkeyRegistered = registerHotkey();

  mainWindow.webContents.on('did-finish-load', () => {
    if (!store.getLicenseStatus()) createDashboardWindow();
  });

  // Request microphone access at startup
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone').then((granted) => {
      if (!granted) console.log('[Verba] Microphone access not yet granted — enable in System Settings → Privacy & Security → Microphone.');
    }).catch(() => {});
  }

  // Auto-update: check after a short delay, then periodically
  autoUpdater.logger = console;
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

  autoUpdater.on('update-available', (info) => {
    console.log('[Verba] Update available:', info.version);
    sendUpdateStatus('update-available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus('update-download-progress', {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Verba] Update downloaded:', info.version);
    sendUpdateStatus('update-downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[Verba] Auto-update error:', err.message);
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.log('[Verba] Update check failed:', err.message);
    });
  }, 10000);

  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
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
