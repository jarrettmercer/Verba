const fs = require('fs');
const path = require('path');

const TARGET_SAMPLE_RATE = 16000;
const CHANNELS = 1;

function writeWavHeader(buffer, numSamples, sampleRate) {
  const dataSize = numSamples * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, buffer]);
}

function resampleTo16kHz(pcm16Buffer, fromRate) {
  if (fromRate === TARGET_SAMPLE_RATE) return pcm16Buffer;
  const numSamples = pcm16Buffer.length / 2;
  const ratio = fromRate / TARGET_SAMPLE_RATE;
  const outLength = Math.floor(numSamples / ratio);
  const out = Buffer.alloc(outLength * 2);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const idx0 = Math.floor(srcIdx);
    const idx1 = Math.min(idx0 + 1, numSamples - 1);
    const t = srcIdx - idx0;
    const s0 = pcm16Buffer.readInt16LE(idx0 * 2);
    const s1 = pcm16Buffer.readInt16LE(idx1 * 2);
    const s = Math.round(s0 * (1 - t) + s1 * t);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return out;
}

/**
 * Compute RMS energy of PCM Int16 buffer.
 * Returns a value between 0 and 1.
 */
function computeRms(pcmBuffer) {
  const numSamples = Math.floor(pcmBuffer.length / 2);
  if (numSamples === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < numSamples; i++) {
    const sample = pcmBuffer.readInt16LE(i * 2) / 32768;
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / numSamples);
}

// Minimum RMS energy to consider audio as containing speech.
// Below this threshold the recording is effectively silence / background noise
// and would cause Whisper to hallucinate.
const MIN_SPEECH_RMS = 0.005;

// Silence threshold for trimming (samples below this are considered silence)
const SILENCE_THRESHOLD = 0.02; // ~-34 dB relative to normalized peak
// Minimum samples to keep as padding around speech (prevents clipping words)
const SILENCE_PAD_SAMPLES = 4800; // 300ms at 16kHz

/**
 * Trim leading and trailing silence from PCM Int16 buffer.
 * Keeps a small pad so words aren't clipped.
 */
function trimSilence(pcmBuffer, sampleRate) {
  const numSamples = Math.floor(pcmBuffer.length / 2);
  if (numSamples === 0) return pcmBuffer;

  // Find first sample above threshold
  let start = 0;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.abs(pcmBuffer.readInt16LE(i * 2) / 32768);
    if (s > SILENCE_THRESHOLD) { start = i; break; }
  }

  // Find last sample above threshold
  let end = numSamples - 1;
  for (let i = numSamples - 1; i >= start; i--) {
    const s = Math.abs(pcmBuffer.readInt16LE(i * 2) / 32768);
    if (s > SILENCE_THRESHOLD) { end = i; break; }
  }

  // Add padding but clamp to buffer bounds
  const padSamples = SILENCE_PAD_SAMPLES;
  start = Math.max(0, start - padSamples);
  end = Math.min(numSamples - 1, end + padSamples);

  const trimmedLength = (end - start + 1) * 2;
  if (trimmedLength >= pcmBuffer.length * 0.9) return pcmBuffer; // barely any silence, skip copy
  console.log('[Verba] Trimmed silence: kept', (end - start + 1), 'of', numSamples, 'samples');
  return pcmBuffer.subarray(start * 2, (end + 1) * 2);
}

/**
 * Normalize PCM Int16 audio to use the full dynamic range.
 * This helps Whisper accuracy, especially on Windows where mic levels tend to be lower.
 */
function normalizeAudio(pcmBuffer) {
  const numSamples = Math.floor(pcmBuffer.length / 2);
  if (numSamples === 0) return pcmBuffer;

  // Find peak amplitude
  let peak = 0;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.abs(pcmBuffer.readInt16LE(i * 2));
    if (s > peak) peak = s;
  }

  // If already loud enough (>50% of max) or silent, skip
  if (peak < 1 || peak > 16384) return pcmBuffer;

  // Scale to ~90% of max to leave headroom
  const gain = Math.min(29491 / peak, 8.0); // cap at 8x to avoid amplifying noise too much
  console.log('[Verba] Normalizing audio: peak =', peak, ', gain =', gain.toFixed(2) + 'x');
  const out = Buffer.alloc(pcmBuffer.length);
  for (let i = 0; i < numSamples; i++) {
    const s = pcmBuffer.readInt16LE(i * 2);
    const normalized = Math.round(s * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, normalized)), i * 2);
  }
  return out;
}

/**
 * Write WAV from renderer-provided PCM (Int16, any sample rate).
 * Resamples to 16kHz for Whisper if needed.
 * Returns null if the audio is too short or too quiet (prevents hallucinations).
 */
function writeWavFromRendererBuffer(pcmBuffer, sampleRate, tempDir) {
  if (!pcmBuffer || pcmBuffer.length < 3200) return null;
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);

  // Check audio energy — reject near-silent recordings that cause hallucinations
  const rms = computeRms(pcm);
  console.log('[Verba] Audio RMS energy:', rms.toFixed(6));
  if (rms < MIN_SPEECH_RMS) {
    console.log('[Verba] Audio too quiet (RMS', rms.toFixed(6), '< threshold', MIN_SPEECH_RMS, '), skipping transcription');
    return null;
  }

  const resampled = resampleTo16kHz(pcm, sampleRate || 44100);

  // Normalize volume first, so trimSilence operates on a standardized dynamic range.
  // This prevents quiet Windows microphones from being aggressively chopped off.
  const normalized = normalizeAudio(resampled);

  // Trim silence from start/end to speed up transcription
  const trimmed = trimSilence(normalized, TARGET_SAMPLE_RATE);

  const numOutSamples = trimmed.length / 2;
  const wavPath = path.join(tempDir, `verba-${Date.now()}.wav`);
  const wavBuffer = writeWavHeader(trimmed, numOutSamples, TARGET_SAMPLE_RATE);
  fs.writeFileSync(wavPath, wavBuffer);
  return wavPath;
}

module.exports = { writeWavFromRendererBuffer };
