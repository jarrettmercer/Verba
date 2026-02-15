use crate::store::Store;
use hound::WavReader;
use reqwest::multipart;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;
use whisper_rs::{convert_integer_to_float_audio, FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Persistent HTTP client — reuses connections / TLS sessions across calls.
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(2)
            .build()
            .expect("failed to create HTTP client")
    })
}

/// Whisper often returns these for silence or near-silence; treat as nothing to paste.
fn is_likely_hallucination(text: &str) -> bool {
    let t = text.trim().to_lowercase();
    if t.is_empty() {
        return true;
    }
    let hallu = [
        "you",
        "thank you",
        "thanks",
        "bye",
        "the",
        "a",
        "an",
        "um",
        "uh",
        "so",
        "and",
        "the end",
        ".",
        "...",
    ];
    if hallu.contains(&t.as_str()) {
        return true;
    }
    // Very short single-word or two-word phrases that are often filler
    let words: Vec<&str> = t.split_whitespace().collect();
    if words.len() <= 2 && t.len() <= 15 {
        let all_filler = words.iter().all(|w| {
            matches!(
                *w,
                "you" | "the" | "a" | "an" | "um" | "uh" | "so" | "and" | "thanks" | "thank" | "bye"
            )
        });
        if all_filler {
            return true;
        }
    }
    false
}

/// Resolve Azure credential from dashboard only (no .env or compile-time fallback).
fn resolve_credential(
    pre_resolved: Option<String>,
    _env_name: &str,
    _compile_time: Option<&'static str>,
) -> Result<String, String> {
    if let Some(ref val) = pre_resolved {
        if !val.is_empty() {
            return Ok(val.clone());
        }
    }
    Err(format!(
        "Azure credential not set — enter your endpoint and API key in Settings → Transcription (Azure section)."
    ))
}

/// Run transcription with an already-loaded context (no model load). Used by the dedicated thread.
fn transcribe_with_context(ctx: &WhisperContext, wav_path: &str) -> Result<String, String> {
    let reader = WavReader::open(wav_path).map_err(|e| format!("Failed to open WAV: {}", e))?;
    let samples_i16: Vec<i16> = reader
        .into_samples::<i16>()
        .filter_map(Result::ok)
        .collect();

    if samples_i16.len() < 1600 {
        return Err("Audio file too short, likely no speech captured".to_string());
    }

    let mut audio_f32 = vec![0.0f32; samples_i16.len()];
    convert_integer_to_float_audio(&samples_i16, &mut audio_f32)
        .map_err(|e| format!("Whisper conversion error: {:?}", e))?;

    let mut state = ctx.create_state().map_err(|e| format!("Failed to create Whisper state: {:?}", e))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_language(Some("en"));
    let n_threads = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(1)
        .max(1) as i32;
    params.set_n_threads(n_threads);

    state
        .full(params, &audio_f32)
        .map_err(|e| format!("Whisper transcription failed: {:?}", e))?;

    let mut text = String::new();
    for segment in state.as_iter() {
        if let Ok(s) = segment.to_str() {
            text.push_str(s);
        }
    }

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Local Whisper returned no text".to_string());
    }
    if is_likely_hallucination(trimmed) {
        return Ok(String::new());
    }
    Ok(trimmed.to_string())
}

/// Request for the dedicated local transcription thread: (wav_path, model_path, reply_sender).
type LocalRequest = (String, PathBuf, mpsc::Sender<Result<String, String>>);

fn get_local_transcription_tx() -> &'static mpsc::Sender<LocalRequest> {
    static TX: OnceLock<mpsc::Sender<LocalRequest>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || run_local_transcription_loop(rx));
        tx
    })
}

/// Dedicated thread: load model once (or when path changes), reuse context for every request.
fn run_local_transcription_loop(rx: mpsc::Receiver<LocalRequest>) {
    let mut cached_path: Option<PathBuf> = None;
    let mut cached_ctx: Option<WhisperContext> = None;

    while let Ok((wav_path, model_path, reply_tx)) = rx.recv() {
        let need_load = cached_path.as_ref() != Some(&model_path);
        if need_load {
            if !model_path.exists() {
                let _ = reply_tx.send(Err(format!(
                    "Local model not found at {}. In Settings → Transcription, click \"Download model\" for the selected size, or choose a smaller size (e.g. Tiny) that you've already downloaded.",
                    model_path.display()
                )));
                continue;
            }
            eprintln!("[Verba] Loading local Whisper model (one-time per session): {}", model_path.display());
            let mut ctx_params = WhisperContextParameters::default();
            ctx_params.use_gpu = true;
            match WhisperContext::new_with_params(model_path.to_str().unwrap(), ctx_params) {
                Ok(ctx) => {
                    cached_ctx = Some(ctx);
                    cached_path = Some(model_path);
                }
                Err(e) => {
                    let _ = reply_tx.send(Err(format!("Failed to load model: {:?}", e)));
                    continue;
                }
            }
        }

        eprintln!("[Verba] Transcription: LOCAL MODEL ONLY — no data is sent to Azure or any cloud service.");
        let ctx = cached_ctx.as_ref().unwrap();
        let result = transcribe_with_context(ctx, &wav_path);
        let _ = reply_tx.send(result);
    }
}

/// Run local Whisper (dispatches to dedicated thread so model is loaded once and reused).
fn transcribe_local_sync(wav_path: String, model_path: PathBuf) -> Result<String, String> {
    let (reply_tx, reply_rx) = mpsc::channel();
    get_local_transcription_tx()
        .send((wav_path, model_path, reply_tx))
        .map_err(|_| "Local transcription thread closed".to_string())?;
    reply_rx.recv().map_err(|_| "No response from transcription thread".to_string())?
}

/// Core transcription: branches on source (azure vs local). Used by Tauri command and hotkey.
/// Only one path runs per request: local = no Azure; azure = no on-device model.
pub async fn transcribe_impl(
    wav_path: String,
    source: String,
    endpoint: Option<String>,
    api_key: Option<String>,
    local_model_path: Option<std::path::PathBuf>,
) -> Result<String, String> {
    if source == "local" {
        eprintln!("[Verba] Using on-device model only. No data will be sent to Azure.");
        let path = local_model_path.ok_or_else(|| "Local model path not set".to_string())?;
        tokio::task::spawn_blocking(move || transcribe_local_sync(wav_path, path))
            .await
            .map_err(|e| format!("Local transcription task failed: {}", e))?
    } else {
        eprintln!("[Verba] Using Azure Whisper. No on-device model is used; audio is sent to your Azure endpoint.");
        transcribe_azure(wav_path, endpoint, api_key).await
    }
}

/// Azure cloud transcription only. No on-device/local model is loaded or used.
async fn transcribe_azure(
    wav_path: String,
    pre_endpoint: Option<String>,
    pre_api_key: Option<String>,
) -> Result<String, String> {
    eprintln!("[Verba] Transcription: AZURE ONLY — on-device model is not used.");
    let endpoint = resolve_credential(pre_endpoint, "AZURE_WHISPER_ENDPOINT", None)?;
    let api_key = resolve_credential(pre_api_key, "AZURE_WHISPER_API_KEY", None)?;

    let file_bytes = tokio::fs::read(&wav_path)
        .await
        .map_err(|e| format!("Failed to read WAV file: {}", e))?;

    if file_bytes.len() < 1000 {
        return Err("Audio file too small, likely no speech captured".to_string());
    }

    eprintln!("[Verba] Sending {} bytes to Azure Whisper API (no local model used).", file_bytes.len());

    let max_retries = 3;

    for attempt in 0..=max_retries {
        let file_part = multipart::Part::bytes(file_bytes.clone())
            .file_name("recording.wav")
            .mime_str("audio/wav")
            .map_err(|e| format!("Failed to create multipart: {}", e))?;

        let form = multipart::Form::new().part("file", file_part);

        let response = client()
            .post(&endpoint)
            .header("api-key", &api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let status = response.status();

        if status.as_u16() == 429 && attempt < max_retries {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(2u64.pow(attempt as u32 + 1));
            eprintln!("Rate limited. Retrying in {}s (attempt {}/{})", retry_after, attempt + 1, max_retries);
            tokio::time::sleep(Duration::from_secs(retry_after)).await;
            continue;
        }

        if !status.is_success() {
            let error_body = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Whisper API error {}: {}", status, error_body));
        }

        let body = response.text().await.map_err(|e| format!("Failed to read response: {}", e))?;
        if body.trim().is_empty() {
            return Err("Whisper API returned an empty response".to_string());
        }

        let json: Value = serde_json::from_str(&body).map_err(|e| format!("Failed to parse JSON: {}", e))?;
        if let Some(text) = json.get("text").and_then(|t| t.as_str()) {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Err("Whisper returned empty text".to_string());
            }
            let out = trimmed.to_string();
            if is_likely_hallucination(&out) {
                return Ok(String::new());
            }
            return Ok(out);
        }
        return Err("No 'text' field in Whisper response".to_string());
    }

    Err("Max retries exceeded".to_string())
}

#[tauri::command]
pub async fn transcribe(wav_path: String, store: tauri::State<'_, Store>) -> Result<String, String> {
    let source = store.transcription_source();
    let endpoint = store.resolve_endpoint();
    let api_key = store.resolve_api_key();
    let local_model_path = store.resolve_local_model_path();
    transcribe_impl(wav_path, source, endpoint, api_key, local_model_path).await
}
