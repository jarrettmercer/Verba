const { clipboard } = require('electron');
const { execSync } = require('child_process');

const VERBA_BUNDLE_ID = 'com.mercer.verba';

function pasteText(text, targetBundleId) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return;

  console.log('[Verba] Paste: setting clipboard (' + t.length + ' chars)');
  clipboard.writeText(t);

  const bid = targetBundleId && typeof targetBundleId === 'string' ? targetBundleId.trim() : null;
  const hasMacTarget = !!bid && bid !== '' && bid.toLowerCase() !== 'missing value' && bid !== VERBA_BUNDLE_ID;

  // On Windows we always try to paste (no bundle ID needed, just Ctrl+V into the foreground app)
  if (!hasMacTarget && process.platform !== 'win32') {
    console.log('[Verba] Paste: no target app, clipboard set only');
    return;
  }

  if (process.platform === 'darwin') {
    // Activate the target app (bring it to front)
    console.log('[Verba] Paste: activating app', bid);
    try {
      const activateScript = `tell application "System Events" to set frontmost of first process whose bundle identifier is "${bid.replace(/"/g, '\\"')}" to true`;
      execSync(`osascript -e '${activateScript.replace(/'/g, "'\"'\"'")}'`, { timeout: 3000 });
    } catch (e) {
      console.warn('[Verba] Paste: activate failed', e.message);
    }

    // Brief delay for the app to become frontmost, then send Cmd+V
    return new Promise((resolve) => {
      setTimeout(() => {
        try {
          console.log('[Verba] Paste: sending Cmd+V');
          execSync(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, { timeout: 3000 });
          console.log('[Verba] Paste: Cmd+V sent');
        } catch (e) {
          console.warn('[Verba] Paste: keystroke failed (grant Accessibility?)', e.message);
        }
        resolve();
      }, 200);
    });
  }

  if (process.platform === 'win32') {
    // On Windows, send Ctrl+V using PowerShell and .NET SendKeys
    return new Promise((resolve) => {
      setTimeout(() => {
        try {
          console.log('[Verba] Paste: sending Ctrl+V on Windows');
          execSync(
            'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"',
            { timeout: 5000, windowsHide: true }
          );
          console.log('[Verba] Paste: Ctrl+V sent');
        } catch (e) {
          console.warn('[Verba] Paste: SendKeys failed', e.message);
        }
        resolve();
      }, 200);
    });
  }
}

module.exports = { pasteText };
