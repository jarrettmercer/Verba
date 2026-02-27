const { clipboard } = require('electron');
const { execSync, exec } = require('child_process');

const VERBA_BUNDLE_ID = 'com.mercer.verba';

function pasteText(text, targetBundleId, opts = {}) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return Promise.resolve();

  const delayMs = typeof opts.delayMs === 'number' && opts.delayMs >= 0 ? opts.delayMs : 200;

  console.log('[Verba] Paste: setting clipboard (' + t.length + ' chars, delay=' + delayMs + 'ms)');
  clipboard.writeText(t);

  const bid = targetBundleId && typeof targetBundleId === 'string' ? targetBundleId.trim() : null;
  const hasMacTarget = !!bid && bid !== '' && bid.toLowerCase() !== 'missing value' && bid !== VERBA_BUNDLE_ID;

  // On Windows we always try to paste (no bundle ID needed, just Ctrl+V into the foreground app)
  if (!hasMacTarget && process.platform !== 'win32') {
    console.log('[Verba] Paste: no target app, clipboard set only');
    return Promise.resolve();
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

    return new Promise((resolve) => {
      setTimeout(() => {
        console.log('[Verba] Paste: sending Cmd+V');
        exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, { timeout: 3000 }, (error) => {
          if (error) {
            console.warn('[Verba] Paste: keystroke failed (grant Accessibility?)', error.message);
          } else {
            console.log('[Verba] Paste: Cmd+V sent');
          }
          resolve();
        });
      }, delayMs);
    });
  }

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      setTimeout(() => {
        console.log('[Verba] Paste: sending Ctrl+V on Windows');
        exec(
          'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"',
          { timeout: 5000, windowsHide: true },
          (error) => {
            if (error) {
              console.warn('[Verba] Paste: SendKeys failed', error.message);
            } else {
              console.log('[Verba] Paste: Ctrl+V sent');
            }
            resolve();
          }
        );
      }, delayMs);
    });
  }

  return Promise.resolve();
}

module.exports = { pasteText };
