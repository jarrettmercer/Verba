(function checkApi() {
    if (!window.api?.invoke) {
        console.error('[Verba] Preload API missing — pill will not work. Restart the app.');
        var el = document.getElementById('api-error-overlay');
        if (el) el.style.display = 'flex';
        return;
    }
})();
const invoke = window.api?.invoke ?? (() => Promise.reject(new Error('API not loaded')));
const send = window.api?.send ?? (() => {});
const listen = window.api?.listen ?? (() => () => {});

const states = ['idle', 'recording', 'transcribing', 'error'];
let currentState = 'idle';
let pasteTargetBundleId = null;

const HOLD_TO_RECORD_MS = 280;
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_MAX_DIST = 25;
let pointerDownAt = null;
let holdTimer = null;
let isDragging = false;
let lastTapAt = 0;
let lastTapX = 0;
let lastTapY = 0;
let isWindowDragging = false;
let dragMoveHandler = null;
let dragEndHandler = null;

const pill = document.getElementById('pill');
const stateElements = {};

let stopAudioCapture = null;
let soundsEnabled = true;

// Feedback sounds
const SOUND_SAMPLE_RATE = 48000;
const SOUND_VOLUME = 0.24;

function generateTone(hz, durationMs, decayRate) {
    const numSamples = Math.floor(SOUND_SAMPLE_RATE * durationMs / 1000);
    const leadIn = Math.floor(SOUND_SAMPLE_RATE * 2 / 1000);
    const trail = Math.floor(SOUND_SAMPLE_RATE * 3 / 1000);
    const total = leadIn + numSamples + trail;
    const buf = new Float32Array(total);
    const twoPi = 2 * Math.PI;
    const tailLen = Math.max(Math.floor(numSamples / 4), 8);
    const tailStart = Math.max(numSamples - tailLen, 0);

    for (let i = 0; i < numSamples; i++) {
        const t = i / SOUND_SAMPLE_RATE;
        const attack = Math.min(1.0, 1.0 - Math.exp(-t * 1200.0));
        const decay = Math.exp(-t * decayRate);
        let envelope = attack * decay;
        if (i >= tailStart) {
            const fade = (numSamples - 1 - i) / Math.max(tailLen - 1, 1);
            envelope *= fade;
        }
        buf[leadIn + i] = Math.sin(twoPi * hz * t) * envelope;
    }
    return buf;
}

const beepSamples = generateTone(380, 14, 70.0);
const boopSamples = generateTone(280, 16, 65.0);

function playSound(samples) {
    if (!soundsEnabled) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SOUND_SAMPLE_RATE });
        const buffer = ctx.createBuffer(1, samples.length, SOUND_SAMPLE_RATE);
        buffer.copyToChannel(samples, 0);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = SOUND_VOLUME;
        source.connect(gain);
        gain.connect(ctx.destination);
        source.onended = () => ctx.close().catch(() => {});
        source.start();
    } catch (_) {}
}

function playBeep() { playSound(beepSamples); }
function playBoop() { playSound(boopSamples); }

const PILL_SIZE_MAP = { small: [76, 12], medium: [100, 18], large: [124, 24] };

function applyAppearanceVars({ opacity, size }) {
    console.log('[Verba] applyAppearanceVars opacity:', opacity, 'size:', size);
    const root = document.documentElement;
    root.style.setProperty('--pill-idle-opacity', opacity ?? 1);
    const [w, h] = PILL_SIZE_MAP[size] ?? PILL_SIZE_MAP.small;
    root.style.setProperty('--pill-idle-w', w + 'px');
    root.style.setProperty('--pill-idle-h', h + 'px');
    console.log('[Verba] CSS vars set — opacity:', opacity ?? 1, 'w:', w + 'px', 'h:', h + 'px');
}

async function applyPillAppearance() {
    try {
        const s = await invoke('get_pill_appearance');
        console.log('[Verba] applyPillAppearance got:', s);
        applyAppearanceVars(s);
    } catch (err) {
        console.error('[Verba] applyPillAppearance failed:', err);
    }
}

function startAudioCapture() {
    return new Promise((resolve, reject) => {
        navigator.mediaDevices.getUserMedia({ audio: {
            channelCount: 1,
            autoGainControl: true,
            noiseSuppression: true,
            echoCancellation: false,
        } })
            .then((stream) => {
                const chunks = [];
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const src = ctx.createMediaStreamSource(stream);
                const bufferSize = 4096;
                const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
                let levelChunkAccum = 0;
                let levelChunkCount = 0;
                const levelChunkSize = Math.floor(ctx.sampleRate / 30);

                processor.onaudioprocess = (e) => {
                    const input = e.inputBuffer.getChannelData(0);
                    const out = new Int16Array(input.length);
                    for (let i = 0; i < input.length; i++) {
                        const s = Math.max(-1, Math.min(1, input[i]));
                        out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                        levelChunkAccum += s * s;
                        levelChunkCount++;
                        if (levelChunkCount >= levelChunkSize) {
                            const rms = Math.sqrt(levelChunkAccum / levelChunkCount);
                            const level = Math.min(1.0, rms * 8.0);
                            waveform.pushLevel(level);
                            levelChunkAccum = 0;
                            levelChunkCount = 0;
                        }
                    }
                    chunks.push(out);
                };
                src.connect(processor);
                processor.connect(ctx.destination);

                stopAudioCapture = () => {
                    return new Promise((res) => {
                        try {
                            processor.disconnect();
                            src.disconnect();
                            stream.getTracks().forEach((t) => t.stop());
                            ctx.close();
                        } catch (_) {}
                        const total = chunks.reduce((n, c) => n + c.length, 0);
                        const merged = new Int16Array(total);
                        let offset = 0;
                        for (const c of chunks) {
                            merged.set(c, offset);
                            offset += c.length;
                        }
                        res({ buffer: merged.buffer, sampleRate: ctx.sampleRate });
                    });
                };
                resolve();
            })
            .catch((err) => reject(err));
    });
}

function startWindowDrag(offsetX, offsetY) {
    if (isWindowDragging) return;
    isWindowDragging = true;
    try {
        if (typeof send === 'function') send('window-drag-start', { offsetX, offsetY });
    } catch (_) {}
    dragMoveHandler = (e) => {
        if (typeof send === 'function') send('window-drag-move', { screenX: e.screenX, screenY: e.screenY });
    };
    dragEndHandler = () => {
        isWindowDragging = false;
        document.removeEventListener('pointermove', dragMoveHandler);
        document.removeEventListener('pointerup', dragEndHandler);
        document.removeEventListener('pointerleave', dragEndHandler);
        if (typeof send === 'function') send('window-drag-end');
    };
    document.addEventListener('pointermove', dragMoveHandler);
    document.addEventListener('pointerup', dragEndHandler);
    document.addEventListener('pointerleave', dragEndHandler);
}

function init() {
    states.forEach(s => {
        stateElements[s] = document.getElementById(`state-${s}`);
    });

    const licenseOverlay = document.getElementById('license-overlay');
    const openDashboardBtn = document.getElementById('license-open-dashboard-btn');
    if (openDashboardBtn) openDashboardBtn.addEventListener('click', () => invoke('open_dashboard').catch(() => {}));

    (async function checkLicense() {
        try {
            const licensed = await invoke('get_license_status');
            if (licensed) licenseOverlay.style.display = 'none';
            else licenseOverlay.style.display = 'flex';
        } catch (_) {
            licenseOverlay.style.display = 'flex';
        }
    })();

    invoke('get_settings').then((s) => {
        if (s && typeof s.sounds_enabled === 'boolean') soundsEnabled = s.sounds_enabled;
    }).catch(() => {});

    applyPillAppearance();
    listen('pill-appearance-changed', (e) => applyAppearanceVars(e.payload));

    const peelBtn = document.getElementById('peel-btn');
    if (peelBtn) {
        peelBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
        peelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            invoke('open_dashboard').catch(() => {});
        });
    }

    if (!pill) { console.error('[Verba] Pill element not found'); return; }
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
        if (Math.abs(dx) >= 2 || Math.abs(dy) >= 2) {
            isDragging = true;
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
            const ox = pointerDownAt.x;
            const oy = pointerDownAt.y;
            pointerDownAt = null;
            startWindowDrag(ox, oy);
        }
    });
    pill.addEventListener('pointerup', (e) => {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (currentState === 'recording' && !isDragging) onHotkeyReleased();
        if (currentState === 'idle' && !isDragging && pointerDownAt !== null) {
            const now = Date.now();
            const dx = e.clientX - lastTapX;
            const dy = e.clientY - lastTapY;
            if (now - lastTapAt <= DOUBLE_TAP_MS && (dx * dx + dy * dy) <= DOUBLE_TAP_MAX_DIST * DOUBLE_TAP_MAX_DIST) {
                lastTapAt = 0;
                invoke('open_dashboard').catch(() => {});
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
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (currentState === 'recording') onHotkeyReleased();
        pointerDownAt = null;
        isDragging = false;
    });

    listen('hotkey-pressed', () => onHotkeyPressed());
    listen('hotkey-released', () => onHotkeyReleased());
    listen('set-paste-target', (event) => {
        pasteTargetBundleId = event.payload ?? null;
    });
    listen('license-activated', () => { if (licenseOverlay) licenseOverlay.style.display = 'none'; });
    listen('license-deactivated', () => { if (licenseOverlay) licenseOverlay.style.display = 'flex'; });
    listen('pill-cursor-over', (event) => {
        const over = event.payload === true;
        if (pill) pill.classList.toggle('cursor-over', over && currentState === 'idle');
    });
    listen('audio-level', (event) => onAudioLevel(event.payload));
    listen('recording-started', () => {
        if (currentState !== 'idle') return;
        setState('recording');
        startAudioCapture().catch((err) => {
            console.error('Microphone access failed:', err);
            const msg = (err && err.name === 'NotAllowedError')
                ? 'Microphone blocked — enable in System Settings → Microphone'
                : (err && err.message) || 'Microphone access denied or unavailable';
            waveform.reset();
            setState('idle');
            showToast(msg, { type: 'error', duration: 6000 });
        });
    });
    listen('recording-stopped', () => {
        if (currentState === 'recording') {
            waveform.reset();
            setState('transcribing');
        }
    });
    listen('dictation-complete', () => { waveform.reset(); setState('idle'); });
    listen('recording-failed', (event) => {
        waveform.reset();
        setState('idle');
        showToast(event.payload || 'Microphone failed', { type: 'error', duration: 6000 });
    });
}

function setErrorMessage(msg) {
    const el = document.getElementById('state-error-message');
    if (el) el.textContent = msg && msg.length ? msg : 'Error';
}

// ===== TOAST NOTIFICATION SYSTEM =====
let activeToastTimer = null;
let activeToastAnimation = null;

function showToast(message, opts = {}) {
    const { type = 'info', duration = 4000, actionLabel, onAction } = opts;
    const toast = document.getElementById('toast');
    const msgEl = document.getElementById('toast-message');
    const iconEl = document.getElementById('toast-icon');
    const actionBtn = document.getElementById('toast-action');
    const progressBar = document.getElementById('toast-progress-bar');
    if (!toast || !msgEl) return;

    // Clear any existing toast
    if (activeToastTimer) { clearTimeout(activeToastTimer); activeToastTimer = null; }
    if (activeToastAnimation) { cancelAnimationFrame(activeToastAnimation); activeToastAnimation = null; }

    msgEl.textContent = message;

    // Icon styling
    iconEl.classList.remove('toast-icon-error', 'toast-icon-success');
    if (type === 'error') iconEl.classList.add('toast-icon-error');
    else if (type === 'success') iconEl.classList.add('toast-icon-success');

    // Action button
    if (actionLabel && onAction) {
        actionBtn.textContent = actionLabel;
        actionBtn.style.display = '';
        actionBtn.onclick = () => { onAction(); hideToast(); };
    } else {
        actionBtn.style.display = 'none';
        actionBtn.onclick = null;
    }

    // Resize window to fit toast + pill stacked
    if (typeof send === 'function') send('toast-show');

    // Show with animation
    toast.style.display = '';
    requestAnimationFrame(() => {
        toast.classList.add('toast-visible');
    });

    // Progress bar animation
    if (progressBar) {
        progressBar.style.transition = 'none';
        progressBar.style.transform = 'scaleX(1)';
        requestAnimationFrame(() => {
            progressBar.style.transition = `transform ${duration}ms linear`;
            progressBar.style.transform = 'scaleX(0)';
        });
    }

    // Auto-dismiss
    activeToastTimer = setTimeout(() => {
        hideToast();
    }, duration);
}

function hideToast() {
    const toast = document.getElementById('toast');
    if (!toast) return;
    if (activeToastTimer) { clearTimeout(activeToastTimer); activeToastTimer = null; }
    toast.classList.remove('toast-visible');
    setTimeout(() => {
        toast.style.display = 'none';
        if (typeof send === 'function') send('toast-hide');
    }, 300);
}

function setState(newState) {
    currentState = newState;
    if (pill) pill.className = `pill-overlay state-${newState}`;
    states.forEach(s => {
        if (stateElements[s]) stateElements[s].style.display = s === newState ? 'flex' : 'none';
    });
    if (newState === 'error' && !document.getElementById('state-error-message')?.textContent) setErrorMessage('Error');
    // Notify main process when pill returns to idle so it can hide the window if needed
    if (newState === 'idle' && typeof send === 'function') send('pill-idle');
}

async function onHotkeyPressed() {
    // Dismiss any active toast first
    if (activeToastTimer) hideToast();
    if (currentState !== 'idle') return;
    playBeep();
    try {
        await invoke('start_recording');
    } catch (err) {
        console.error('Failed to start recording:', err);
        waveform.reset();
        setState('idle');
        showToast(err && (err.message || String(err)), { type: 'error', duration: 5000 });
    }
}

async function onHotkeyReleased() {
    if (currentState !== 'recording') return;
    playBoop();
    waveform.reset();
    try {
        setState('transcribing');
        const { buffer, sampleRate } = stopAudioCapture ? await stopAudioCapture() : { buffer: null, sampleRate: 16000 };
        stopAudioCapture = null;
        const result = await invoke('stop_recording', { buffer: buffer || undefined, sampleRate });
        const wavPath = result && result.ok === true ? result.wavPath : null;
        if (!wavPath) {
            const msg = (result && result.error) || 'Microphone access needed.';
            setState('idle');
            showToast(msg, { type: 'error', duration: 5000 });
            return;
        }
        const text = await invoke('transcribe', { wavPath });
        if (text && text.trim().length > 0) {
            await invoke('paste_text', { text, targetBundleId: pasteTargetBundleId });
            invoke('record_dictation', { text }).catch(() => {});
        }
        pasteTargetBundleId = null;
        setState('idle');
    } catch (err) {
        console.error('Dictation error:', err);
        setState('idle');
        showToast(err && (err.message || String(err)), { type: 'error', duration: 5000 });
    }
}

function onAudioLevel(payload) {
    if (currentState !== 'recording') return;
    const level = typeof payload === 'number' ? payload : (payload?.level ?? 0);
    const n = Number(level);
    if (Number.isFinite(n) && n >= 0) waveform.pushLevel(Math.min(1, n));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
