# Packaging Murmur for install

Build the app on **macOS** to get Mac installers, and on **Windows** to get Windows installers. You need each OS (or a VM/CI) to produce that platform’s packages.

---

## Prerequisites

- **Node.js** (v18+)
- **Rust**: [rustup.rs](https://rustup.rs) → then `rustup default stable`
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Windows**: Visual Studio Build Tools with “Desktop development with C++” (or full Visual Studio)

---

## Build (one-time setup per machine)

```bash
cd mercer-voice-tauri
npm install
```

If you ever need to regenerate the pill icon (transparent background):

```bash
npm run icon:strip-bg
```

---

## macOS: build and install

From the project root:

```bash
npm run tauri build
```

If you see an error about `--ci`, run:

```bash
CI=false npm run tauri build
```

**Outputs** (under `src-tauri/target/release/bundle/`):

| What | Path |
|------|------|
| **App bundle** (drag to Applications) | `src-tauri/target/release/bundle/macos/Murmur.app` |
| **DMG installer** (for sharing) | `src-tauri/target/release/bundle/dmg/Murmur_0.1.0_aarch64.dmg` (or `x64.dmg` on Intel) |

**Install on your Mac**

- **Option A:** Drag `Murmur.app` into **Applications**.
- **Option B:** Open the `.dmg`, then drag Murmur to Applications.

First launch: **System Settings → Privacy & Security** may require you to allow the app (because it’s not notarized).

**Right Command (push-to-talk)**  
For **Right Cmd** (hold to record, release to paste) to work as a **global** hotkey (even when another app like Messages has focus), Murmur needs permission to monitor input:

1. Open **System Settings → Privacy & Security**.
2. **Input Monitoring:** add **Murmur** and turn it **on**.
3. **Accessibility:** add **Murmur** and turn it **on** (some Macs need this when the app is in the background).
4. **Restart Murmur** (quit completely, then open again).

If the hotkey only works when Murmur’s window is focused, add Murmur to **Accessibility** as above and restart. You can still use **click-and-hold on the pill** to record without the hotkey.

**Azure Whisper (required for transcription)**  
The installed app does not use the repo’s `.env`. Put your Azure config in the app’s config folder:

1. Create a file named `.env` in:
   - **macOS:** `~/Library/Application Support/app.murmur/.env`
   - **Windows:** `%APPDATA%\app.murmur\.env` (e.g. `C:\Users\You\AppData\Roaming\app.murmur\.env`)

2. Put these two lines in that file (with your real values):

   ```
   AZURE_WHISPER_ENDPOINT=https://YOUR_RESOURCE.cognitiveservices.azure.com/openai/deployments/whisper/audio/translations?api-version=2024-06-01
   AZURE_WHISPER_API_KEY=your_api_key_here
   ```

3. Restart Murmur. You can copy from your project’s `.env` if you already have one.

---

## Windows: build and install

On a Windows machine (or Windows VM), in the project folder:

```bash
npm install
npm run tauri build
```

**Outputs** (under `src-tauri/target/release/bundle/`):

| What | Path |
|------|------|
| **NSIS installer (.exe)** | `src-tauri/target/release/bundle/nsis/Murmur_0.1.0_x64-setup.exe` (or `x86-setup.exe`) |

**Install on Windows**

- Run the `.exe` installer and follow the steps. You can install for the current user or for all users.

---

## Summary

| Goal | Command | Result |
|------|---------|--------|
| Mac app + DMG | On Mac: `npm run tauri build` | `Murmur.app` and `Murmur_*.dmg` in `src-tauri/target/release/bundle/` |
| Windows installer | On Windows: `npm run tauri build` | `Murmur_*_setup.exe` in `src-tauri/target/release/bundle/nsis/` |

To **ship to others**: share the `.dmg` on Mac and the `.exe` on Windows. For Mac App Store or notarization, you’d add signing; for Windows Store you’d use the store tooling.
