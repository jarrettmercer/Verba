const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// State machine
const states = ['idle', 'recording', 'transcribing', 'error'];
let currentState = 'idle';
/** When set (e.g. from hotkey), we paste into this app's window instead of current focus. */
let pasteTargetBundleId = null;

// Drag vs hold-to-record: any movement = drag; no movement for this long = start recording
const HOLD_TO_RECORD_MS = 280;
// Double-tap on pill (within time/distance) opens dashboard
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_MAX_DIST = 25;
let pointerDownAt = null;
let holdTimer = null;
let isDragging = false;
let lastTapAt = 0;
let lastTapX = 0;
let lastTapY = 0;

// DOM elements
const pill = document.getElementById('pill');
const stateElements = {};

function startWindowDrag() {
    try {
        const tauri = window.__TAURI__;
        const win = tauri?.window?.getCurrentWindow?.() ?? tauri?.webviewWindow?.getCurrentWebviewWindow?.();
        if (win && typeof win.startDragging === 'function') win.startDragging();
    } catch (_) {}
}

function init() {
    states.forEach(s => {
        stateElements[s] = document.getElementById(`state-${s}`);
    });

    // Peel button — opens the dashboard window
    const peelBtn = document.getElementById('peel-btn');
    if (peelBtn) {
        peelBtn.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); // Don't trigger pill drag/record
        });
        peelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            invoke('open_dashboard').catch(err => console.error('Failed to open dashboard:', err));
        });
    }

    // Click-and-hold to record, or drag anywhere to move the window
    const pill = document.getElementById('pill');
    pill.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (currentState !== 'idle') return;
        pointerDownAt = { x: e.clientX, y: e.clientY };
        isDragging = false;
        holdTimer = setTimeout(() => {
            holdTimer = null;
            if (!isDragging && pointerDownAt) onHotkeyPressed();
        }, HOLD_TO_RECORD_MS);
    });
    pill.addEventListener('pointermove', (e) => {
        if (!pointerDownAt) return;
        const dx = e.clientX - pointerDownAt.x;
        const dy = e.clientY - pointerDownAt.y;
        // Any real movement (2px+) = drag, so moving the pill never starts recording
        if (Math.abs(dx) >= 2 || Math.abs(dy) >= 2) {
            isDragging = true;
            if (holdTimer) {
                clearTimeout(holdTimer);
                holdTimer = null;
            }
            pointerDownAt = null;
            startWindowDrag();
        }
    });
    pill.addEventListener('pointerup', (e) => {
        if (holdTimer) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }
        if (currentState === 'recording' && !isDragging) onHotkeyReleased();
        // Double-tap (idle, no drag) opens dashboard
        if (currentState === 'idle' && !isDragging && pointerDownAt !== null) {
            const now = Date.now();
            const dx = e.clientX - lastTapX;
            const dy = e.clientY - lastTapY;
            if (now - lastTapAt <= DOUBLE_TAP_MS && (dx * dx + dy * dy) <= DOUBLE_TAP_MAX_DIST * DOUBLE_TAP_MAX_DIST) {
                lastTapAt = 0;
                invoke('open_dashboard').catch(err => console.error('Failed to open dashboard:', err));
            } else {
                lastTapAt = now;
                lastTapX = e.clientX;
                lastTapY = e.clientY;
            }
        }
        pointerDownAt = null;
        isDragging = false;
    });
    pill.addEventListener('pointerleave', () => {
        if (holdTimer) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }
        if (currentState === 'recording') onHotkeyReleased();
        pointerDownAt = null;
        isDragging = false;
    });

    // Listen for hotkey events from Rust backend (emitted to main window)
    // Payload can be the frontmost app's bundle id so we paste into that app
    listen('hotkey-pressed', (event) => {
        console.log('[Verba] hotkey-pressed received');
        pasteTargetBundleId = event.payload ?? null;
        onHotkeyPressed();
    });
    listen('hotkey-released', () => {
        console.log('[Verba] hotkey-released received');
        onHotkeyReleased();
    });
    listen('audio-level', (event) => onAudioLevel(event.payload));
    listen('recording-started', () => {
        if (currentState === 'idle') setState('recording');
    });
    listen('recording-stopped', () => {
        if (currentState === 'recording') {
            waveform.reset();
            setState('transcribing');
        }
    });
    listen('dictation-complete', () => {
        waveform.reset();
        setState('idle');
    });
    listen('recording-failed', (event) => {
        setErrorMessage(event.payload || 'Microphone failed');
        setState('error');
        waveform.reset();
        setTimeout(() => setState('idle'), 6000);
    });
}

function setErrorMessage(msg) {
    const el = document.getElementById('state-error-message');
    if (el) el.textContent = msg && msg.length ? msg : 'Error';
}

function setState(newState) {
    currentState = newState;

    // Update pill class
    pill.className = `pill-overlay state-${newState}`;

    // Show/hide state elements
    states.forEach(s => {
        if (stateElements[s]) {
            stateElements[s].style.display = s === newState ? 'flex' : 'none';
        }
    });
    if (newState === 'error' && !document.getElementById('state-error-message')?.textContent) {
        setErrorMessage('Error');
    }
}

async function onHotkeyPressed() {
    if (currentState !== 'idle') return;

    try {
        setState('recording');
        await invoke('start_recording');
    } catch (err) {
        console.error('Failed to start recording:', err);
        waveform.reset();
        setErrorMessage(err && (err.message || String(err)));
        setState('error');
        setTimeout(() => setState('idle'), 5000);
    }
}

async function onHotkeyReleased() {
    if (currentState !== 'recording') return;

    waveform.reset();

    try {
        setState('transcribing');
        const wavPath = await invoke('stop_recording');

        const text = await invoke('transcribe', { wavPath });

        const hadTargetApp = !!pasteTargetBundleId;
        await invoke('paste_text', { text, targetBundleId: pasteTargetBundleId });
        pasteTargetBundleId = null;

        // Record dictation stats (pill click flow)
        invoke('record_dictation', { text }).catch(() => {});

        setState('idle');
    } catch (err) {
        console.error('Dictation error:', err);
        setErrorMessage(err && (err.message || String(err)));
        setState('error');
        setTimeout(() => setState('idle'), 5000);
    }
}

function onAudioLevel(payload) {
    if (currentState !== 'recording') return;
    const level = typeof payload === 'number' ? payload : (payload?.level ?? 0);
    const n = Number(level);
    if (Number.isFinite(n) && n >= 0) waveform.pushLevel(Math.min(1, n));
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
