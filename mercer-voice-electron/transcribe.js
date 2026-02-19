const fetch = require('node-fetch');
const fs = require('fs');
const os = require('os');

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
  // Catch common Whisper hallucination phrases from training data
  const halluPhrases = [
    'thank you for watching', 'thanks for watching', 'please subscribe',
    'like and subscribe', 'see you next time', 'you follow us',
    'all that is good', 'but that means', 'goodbye', 'good night',
    'thank you very much', 'thanks for listening', 'see you later',
    'please like and subscribe', 'don\'t forget to subscribe',
    'if you enjoyed this', 'leave a comment', 'hit the bell',
    'check out our', 'follow us on', 'visit our website',
  ];
  for (const phrase of halluPhrases) {
    if (stripped.includes(phrase)) return true;
  }
  // Detect incoherent multi-sentence output (many short unrelated sentences)
  const sentences = stripped.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length >= 3) {
    const avgWordsPerSentence = words.length / sentences.length;
    if (avgWordsPerSentence <= 4) return true;
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

/**
 * Build an initial_prompt string from the user's dictionary entries.
 * This biases Whisper toward recognizing custom words, names, and jargon.
 */
function buildInitialPrompt(dictionary) {
  if (!Array.isArray(dictionary) || dictionary.length === 0) return '';
  const words = dictionary
    .map((e) => {
      // Use the replacement if it's a replacement type, otherwise the phrase
      if (e.entry_type === 'replacement' && e.replacement) return e.replacement;
      if (e.entry_type === 'blocked') return null; // skip blocked words
      return e.phrase;
    })
    .filter(Boolean);
  if (words.length === 0) return '';
  // Whisper initial_prompt works best as a comma-separated list or short sentence
  return words.join(', ');
}

async function transcribeLocal(wavPath, modelPath, dictionary) {
  if (!modelPath || !fs.existsSync(modelPath)) {
    throw new Error(
      'Local Whisper model not found. Go to Settings → Transcription and download a model first.'
    );
  }

  const wavStats = fs.statSync(wavPath);
  console.log('[Verba] transcribeLocal: wav size =', wavStats.size, 'bytes, path =', wavPath);

  let whisper = require('@kutalia/whisper-node-addon');
  if (whisper.default) whisper = whisper.default;

  // Use most CPU cores but leave 2 free for the OS/Electron
  const cpuCount = os.cpus().length;
  const nThreads = Math.max(1, Math.min(cpuCount - 2, 8));

  // Build initial prompt from dictionary for better accuracy on custom words
  const initialPrompt = buildInitialPrompt(dictionary);
  if (initialPrompt) console.log('[Verba] Using initial_prompt from dictionary:', initialPrompt.slice(0, 100) + (initialPrompt.length > 100 ? '...' : ''));

  const whisperParams = {
    fname_inp: wavPath,
    model: modelPath,
    language: 'en',
    use_gpu: true,
    no_prints: true,
    n_threads: nThreads,
  };
  if (initialPrompt) whisperParams.initial_prompt = initialPrompt;

  let result;
  try {
    result = await whisper.transcribe(whisperParams);
  } catch (gpuErr) {
    // GPU transcription failed — fall back to CPU
    console.warn('[Verba] GPU transcription failed, retrying on CPU:', gpuErr.message);
    whisperParams.use_gpu = false;
    result = await whisper.transcribe(whisperParams);
  }

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
    const dictionary = store.getDictionary ? store.getDictionary() : [];
    return transcribeLocal(wavPath, modelPath, dictionary);
  }
  const cfg = store.getApiConfig();
  return transcribeAzure(wavPath, cfg.endpoint || null, cfg.api_key || null);
}

async function testAzureEndpoint(endpoint, apiKey) {
  if (!endpoint || !apiKey) {
    return { ok: false, message: 'Endpoint and API key are required' };
  }
  try {
    const FormData = require('form-data');
    const form = new FormData();
    // Send a tiny silent WAV (44-byte header + 0 data) to trigger a real API response
    const wavHeader = Buffer.alloc(44);
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(36, 4);
    wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);    // PCM
    wavHeader.writeUInt16LE(1, 22);    // mono
    wavHeader.writeUInt32LE(16000, 24); // sample rate
    wavHeader.writeUInt32LE(32000, 28); // byte rate
    wavHeader.writeUInt16LE(2, 32);    // block align
    wavHeader.writeUInt16LE(16, 34);   // bits per sample
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(0, 40);

    form.append('file', wavHeader, { filename: 'test.wav', contentType: 'audio/wav' });

    const res = await require('node-fetch')(endpoint, {
      method: 'POST',
      headers: { 'api-key': apiKey, ...form.getHeaders() },
      body: form,
      duplex: 'half',
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `Authentication failed (${res.status}). Check your API key.` };
    }
    if (res.status === 404) {
      return { ok: false, message: 'Endpoint not found (404). Check your deployment URL.' };
    }
    // Any 2xx or even a 400 "no audio" means the endpoint is reachable and credentials work
    if (res.ok || res.status === 400) {
      return { ok: true, message: 'Connection successful — endpoint and key are valid.' };
    }
    const body = await res.text().catch(() => '');
    return { ok: false, message: `Unexpected response (${res.status}): ${body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, message: `Connection failed: ${err.message || err}` };
  }
}

module.exports = { transcribe, testAzureEndpoint };
