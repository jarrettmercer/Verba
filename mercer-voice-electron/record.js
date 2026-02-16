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
 * Write WAV from renderer-provided PCM (Int16, any sample rate).
 * Resamples to 16kHz for Whisper if needed.
 */
function writeWavFromRendererBuffer(pcmBuffer, sampleRate, tempDir) {
  if (!pcmBuffer || pcmBuffer.length < 3200) return null;
  const numSamples = Math.floor(pcmBuffer.length / 2);
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
  const resampled = resampleTo16kHz(pcm, sampleRate || 44100);
  const numOutSamples = resampled.length / 2;
  const wavPath = path.join(tempDir, `verba-${Date.now()}.wav`);
  const wavBuffer = writeWavHeader(resampled, numOutSamples, TARGET_SAMPLE_RATE);
  fs.writeFileSync(wavPath, wavBuffer);
  return wavPath;
}

module.exports = { writeWavFromRendererBuffer };
