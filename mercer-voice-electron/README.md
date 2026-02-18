# Verba (Electron)

Voice dictation pill — hold the pill or use the hotkey to record, then transcribe and paste.

## Run

**You must run from this folder:**

```bash
cd mercer-voice-electron
npm install
npm start
```

If you run from the parent folder or elsewhere, the app may not find its files.

## First run

1. **Activate** — The dashboard opens; enter your product key.
2. **Microphone** — On first launch the app requests mic access; macOS should show a prompt and add the app to System Settings → Privacy & Security → Microphone (listed as **Electron** when run via `npm start`). If you don’t see a prompt or “Electron” isn’t in the list, quit Verba completely, open **System Settings → Privacy & Security → Microphone**, then start Verba again — the prompt may appear on the second launch.
3. **Hotkey** — If Cmd+Shift+Space doesn’t work, it may be taken. Free it in System Settings → Keyboard → Shortcuts, or the app will try Control+Option+Space. Restart after changing. If the shortcut still doesn’t work when another app is focused, add Verba/Electron in **Accessibility** (same Privacy & Security page).

## If nothing works

1. **Tray** — Right‑click the tray icon → **Open Developer Tools (pill)**. Check the Console for errors (e.g. "Preload API missing" = restart the app).
2. **Pill** — If you see "Verba couldn’t load — restart the app" on the pill, the preload script didn’t load; restart from `mercer-voice-electron` with `npm start`.
3. **Terminal** — Run `npm start` from `mercer-voice-electron` and watch for `[Verba] Starting — app path: ...` and `[Verba] Global hotkey registered: ...`. If you see "index.html not found", you’re in the wrong directory.
