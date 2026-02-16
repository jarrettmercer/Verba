const fetch = require('node-fetch');
const fs = require('fs');

function applySelfCorrections(text) {
  const t = text.trim();
  if (!t) return text;
  const lower = t.toLowerCase();
  const markers = [
    ' no scratch that ',
    ' scratch that ',
    ' i mean ',
    ' i meant ',
    ' no, scratch that ',
    ', scratch that ',
  ];
  let foundAt = null;
  for (const m of markers) {
    const pos = lower.lastIndexOf(m);
    if (pos !== -1 && (foundAt == null || pos > foundAt[0])) foundAt = [pos, m.length];
  }
  if (foundAt == null) return text;
  const [markerStart, markerLen] = foundAt;
  const before = t.slice(0, markerStart).trimEnd();
  const correction = t.slice(markerStart + markerLen).trim();
  if (!before || !correction) return text;
  const beforeWords = before.split(/\s+/);
  const correctionWords = correction.split(/\s+/);
  const n = Math.min(correctionWords.length, beforeWords.length);
  if (n === 0) return `${before} ${correction}`;
  const keep = Math.max(0, beforeWords.length - n);
  const out = beforeWords.slice(0, keep).concat(correctionWords);
  return out.join(' ');
}

function isLikelyHallucination(text) {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  // Strip bracket tokens like [BLANK_AUDIO], (blank audio), etc.
  const stripped = t.replace(/[\[\(][^\]\)]*[\]\)]/g, '').trim();
  if (!stripped) return true;
  const hallu = ['you', 'thank you', 'thanks', 'bye', 'the', 'a', 'an', 'um', 'uh', 'so', 'and', 'the end', '.', '...', 'i', 'it', 'is', 'oh'];
  if (hallu.includes(stripped)) return true;
  const words = stripped.split(/\s+/);
  if (words.length <= 2 && stripped.length <= 15) {
    const fillers = ['you', 'the', 'a', 'an', 'um', 'uh', 'so', 'and', 'thanks', 'thank', 'bye', 'i', 'it', 'is', 'oh'];
    if (words.every((w) => fillers.includes(w))) return true;
  }
  return false;
}

async function transcribeAzure(wavPath, endpoint, apiKey) {
  if (!endpoint || !apiKey) {
    throw new Error('Azure credential not set — enter your endpoint and API key in Settings → Transcription (Azure section).');
  }
  const fileBytes = fs.readFileSync(wavPath);
  if (fileBytes.length < 1000) throw new Error('Audio file too small, likely no speech captured');

  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fileBytes, { filename: 'recording.wav', contentType: 'audio/wav' });

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'api-key': apiKey, ...form.getHeaders() },
      body: form,
      duplex: 'half',
    });

    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '', 10) || Math.pow(2, attempt + 1);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Whisper API error ${res.status}: ${body}`);
    }

    const body = await res.text();
    if (!body.trim()) throw new Error('Whisper API returned an empty response');
    let json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      throw new Error('Failed to parse JSON: ' + e.message);
    }
    const text = json && json.text;
    if (typeof text !== 'string') throw new Error("No 'text' field in Whisper response");
    const trimmed = text.trim();
    if (!trimmed) throw new Error('Whisper returned empty text');
    const out = applySelfCorrections(trimmed);
    if (isLikelyHallucination(out)) return '';
    return out;
  }
  throw new Error('Max retries exceeded');
}

async function transcribeLocal(wavPath, modelPath) {
  if (!modelPath || !fs.existsSync(modelPath)) {
    throw new Error(
      'Local Whisper model not found. Go to Settings → Transcription and download a model first.'
    );
  }

  const wavStats = fs.statSync(wavPath);
  console.log('[Verba] transcribeLocal: wav size =', wavStats.size, 'bytes, path =', wavPath);

  let whisper = require('@kutalia/whisper-node-addon');
  if (whisper.default) whisper = whisper.default;

  const result = await whisper.transcribe({
    fname_inp: wavPath,
    model: modelPath,
    language: 'en',
    use_gpu: true,
    no_prints: true,
  });

  let segments = result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    segments = result.transcription || result.segments || [];
  }

  let text = '';
  if (typeof segments === 'string') {
    text = segments;
  } else if (Array.isArray(segments)) {
    text = segments
      .map((seg) => {
        if (typeof seg === 'string') return seg;
        if (Array.isArray(seg)) {
          // Format: [start_time, end_time, text]
          const last = seg[seg.length - 1];
          return typeof last === 'string' ? last : (seg[0] || '');
        }
        if (seg && typeof seg === 'object') return seg.speech || seg.text || '';
        return '';
      })
      .join(' ');
  }

  // Strip bracket/paren tokens like [BLANK_AUDIO], (music), [silence], etc.
  const cleaned = text.replace(/[\[\(][^\]\)]*[\]\)]/g, '').trim();
  if (!cleaned) return '';
  const out = applySelfCorrections(cleaned);
  if (isLikelyHallucination(out)) return '';
  return out;
}

async function transcribe(store, wavPath) {
  const source = store.data.settings.transcription?.source || 'local';
  if (source === 'local') {
    const modelPath = store.resolveLocalModelPath
      ? store.resolveLocalModelPath()
      : store.getDefaultLocalModelPath();
    return transcribeLocal(wavPath, modelPath);
  }
  const cfg = store.getApiConfig();
  return transcribeAzure(wavPath, cfg.endpoint || null, cfg.api_key || null);
}

module.exports = { transcribe };
