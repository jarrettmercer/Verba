#!/usr/bin/env node
// Patches Electron.app for Verba development on macOS:
// - Changes bundle identifier to com.mercer.verba
// - Renames dock label from "Electron" to "Verba"
// - Replaces dock icon with Verba icon
// - Adds NSMicrophoneUsageDescription for mic permission prompt
// NOTE: Do NOT re-codesign — it breaks Electron's internal module loading

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

if (process.platform !== 'darwin') process.exit(0);

let electronApp = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
const verbaAppPath = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Verba.app');
if (!fs.existsSync(electronApp) && fs.existsSync(verbaAppPath)) {
  electronApp = verbaAppPath;
}
const plist = path.join(electronApp, 'Contents', 'Info.plist');

if (!fs.existsSync(plist)) {
  console.log('[postinstall] Electron.app not found, skipping patch');
  process.exit(0);
}

try {
  execSync(`plutil -replace CFBundleIdentifier -string "com.mercer.verba" "${plist}"`);
  execSync(`plutil -replace CFBundleName -string "Verba" "${plist}"`);
  execSync(`plutil -replace CFBundleDisplayName -string "Verba" "${plist}"`);
  execSync(`plutil -replace NSMicrophoneUsageDescription -string "Verba needs microphone access for voice dictation." "${plist}"`);

  // Patch helper app bundle identifiers and names
  const helpers = [
    { dir: 'Electron Helper.app', name: 'Verba Helper' },
    { dir: 'Electron Helper (GPU).app', name: 'Verba Helper (GPU)' },
    { dir: 'Electron Helper (Plugin).app', name: 'Verba Helper (Plugin)' },
    { dir: 'Electron Helper (Renderer).app', name: 'Verba Helper (Renderer)' },
  ];
  const fwDir = path.join(electronApp, 'Contents', 'Frameworks');
  for (const h of helpers) {
    const hp = path.join(fwDir, h.dir, 'Contents', 'Info.plist');
    if (fs.existsSync(hp)) {
      try {
        execSync(`plutil -replace CFBundleIdentifier -string "com.mercer.verba.helper" "${hp}"`);
        execSync(`plutil -replace CFBundleName -string "${h.name}" "${hp}"`);
      } catch (_) {}
    }
  }

  const iconSrc = path.join(__dirname, '..', 'build', 'icon.icns');
  if (fs.existsSync(iconSrc)) {
    try {
      const iconFile = execSync(`plutil -extract CFBundleIconFile raw "${plist}"`, { encoding: 'utf8' }).trim();
      if (iconFile) {
        const iconDst = path.join(electronApp, 'Contents', 'Resources', iconFile);
        fs.copyFileSync(iconSrc, iconDst);
      }
    } catch (_) {}
  }

  // Write localized InfoPlist.strings so macOS uses "Verba" everywhere
  const enLproj = path.join(electronApp, 'Contents', 'Resources', 'en.lproj');
  try { fs.mkdirSync(enLproj, { recursive: true }); } catch (_) {}
  const stringsContent = `CFBundleName = "Verba";\nCFBundleDisplayName = "Verba";\n`;
  fs.writeFileSync(path.join(enLproj, 'InfoPlist.strings'), stringsContent, 'utf8');

  // Touch the .app so macOS re-reads metadata
  const now = new Date();
  fs.utimesSync(electronApp, now, now);

  // Re-register with LaunchServices to flush cached name/icon
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  if (fs.existsSync(lsregister)) {
    try {
      execSync(`"${lsregister}" -kill -r -domain local -domain system -domain user 2>&1`, { encoding: 'utf8', timeout: 10000 });
    } catch (_) {}
    try {
      execSync(`"${lsregister}" -f "${electronApp}" 2>&1`, { encoding: 'utf8' });
    } catch (_) {}
  }

  // Rename Electron.app → Verba.app so macOS dock shows "Verba"
  const verbaApp = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Verba.app');
  if (!fs.existsSync(verbaApp)) {
    fs.renameSync(electronApp, verbaApp);
    // Update electron's path.txt so it finds the renamed binary
    const pathTxt = path.join(__dirname, '..', 'node_modules', 'electron', 'path.txt');
    fs.writeFileSync(pathTxt, 'Verba.app/Contents/MacOS/Electron');
  }

  console.log('[postinstall] Patched Electron.app for Verba');
} catch (e) {
  console.warn('[postinstall] Error:', e.message);
}

// Compile Fn key CGEventTap helper (hold-to-record)
try {
  const helperSrc = path.join(__dirname, '..', 'helpers', 'fn-key-tap.swift');
  const helperBin = path.join(__dirname, '..', 'helpers', 'fn-key-tap');
  if (fs.existsSync(helperSrc)) {
    const needsBuild = !fs.existsSync(helperBin) ||
      fs.statSync(helperSrc).mtimeMs > fs.statSync(helperBin).mtimeMs;
    if (needsBuild) {
      execSync(`swiftc -O -o "${helperBin}" "${helperSrc}" -framework Cocoa`, { stdio: 'pipe' });
      console.log('[postinstall] Compiled fn-key-tap helper');
    }
  }
} catch (e) {
  console.warn('[postinstall] fn-key-tap compile error:', e.message);
}

// Fix whisper-node-addon: platform directory naming + dylib rpaths
try {
  const whisperDist = path.join(__dirname, '..', 'node_modules', '@kutalia', 'whisper-node-addon', 'dist');
  if (fs.existsSync(whisperDist)) {
    // Symlink darwin-* → mac-* (loader uses darwin- but dirs are mac-)
    const links = { 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64' };
    for (const [link, target] of Object.entries(links)) {
      const linkPath = path.join(whisperDist, link);
      if (fs.existsSync(path.join(whisperDist, target)) && !fs.existsSync(linkPath)) {
        fs.symlinkSync(target, linkPath);
      }
    }

    // Fix rpaths — prebuilt binaries have CI build paths baked in
    const CI_RPATH = '/Users/runner/work/whisper-node-addon/whisper-node-addon/deps/whisper.cpp/build/Release';
    for (const dir of ['mac-arm64', 'mac-x64']) {
      const dirPath = path.join(whisperDist, dir);
      if (!fs.existsSync(dirPath)) continue;
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.node') || f.endsWith('.dylib'));
      for (const f of files) {
        const fp = path.join(dirPath, f);
        try { execSync(`install_name_tool -add_rpath @loader_path/ "${fp}" 2>/dev/null`); } catch (_) {}
        try { execSync(`install_name_tool -delete_rpath "${CI_RPATH}" "${fp}" 2>/dev/null`); } catch (_) {}
      }
    }

    console.log('[postinstall] Patched whisper-node-addon (symlinks + rpaths)');
  }
} catch (e) {
  console.warn('[postinstall] Whisper patch error:', e.message);
}
