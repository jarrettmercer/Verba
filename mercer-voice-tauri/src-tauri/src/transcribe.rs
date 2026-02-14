use crate::store::Store;
use reqwest::multipart;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

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

/// Resolve a config value: pre-resolved value first, then compile-time fallback.
fn resolve_credential(
    pre_resolved: Option<String>,
    env_name: &str,
    compile_time: Option<&'static str>,
) -> Result<String, String> {
    if let Some(ref val) = pre_resolved {
        if !val.is_empty() {
            return Ok(val.clone());
        }
    }
    compile_time
        .map(|v| v.to_string())
        .ok_or_else(|| format!("{} not set — configure it in Settings → API Configuration", env_name))
}

/// Core transcription logic. Used by both the Tauri command and the hotkey flow.
/// `endpoint` and `api_key` should be pre-resolved from store + env vars.
pub async fn transcribe_impl(
    wav_path: String,
    endpoint: Option<String>,
    api_key: Option<String>,
) -> Result<String, String> {
    transcribe_inner(wav_path, endpoint, api_key).await
}

async fn transcribe_inner(
    wav_path: String,
    pre_endpoint: Option<String>,
    pre_api_key: Option<String>,
) -> Result<String, String> {
    let endpoint = resolve_credential(
        pre_endpoint,
        "AZURE_WHISPER_ENDPOINT",
        option_env!("AZURE_WHISPER_ENDPOINT"),
    )?;
    let api_key = resolve_credential(
        pre_api_key,
        "AZURE_WHISPER_API_KEY",
        option_env!("AZURE_WHISPER_API_KEY"),
    )?;

    let file_bytes = tokio::fs::read(&wav_path)
        .await
        .map_err(|e| format!("Failed to read WAV file: {}", e))?;

    // Check file size (skip if too small — likely no speech)
    if file_bytes.len() < 1000 {
        return Err("Audio file too small, likely no speech captured".to_string());
    }

    eprintln!("[Verba] Sending {} bytes to Whisper API", file_bytes.len());

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

        // Handle rate limiting with retry
        if status.as_u16() == 429 && attempt < max_retries {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(2u64.pow(attempt as u32 + 1));

            eprintln!(
                "Rate limited. Retrying in {}s (attempt {}/{})",
                retry_after,
                attempt + 1,
                max_retries
            );
            tokio::time::sleep(Duration::from_secs(retry_after)).await;
            continue;
        }

        if !status.is_success() {
            let error_body = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Whisper API error {}: {}", status, error_body));
        }

        let body = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        if body.trim().is_empty() {
            return Err("Whisper API returned an empty response".to_string());
        }

        let json: Value =
            serde_json::from_str(&body).map_err(|e| format!("Failed to parse JSON: {}", e))?;

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
pub async fn transcribe(
    wav_path: String,
    store: tauri::State<'_, Store>,
) -> Result<String, String> {
    let endpoint = store.resolve_endpoint();
    let api_key = store.resolve_api_key();
    transcribe_inner(wav_path, endpoint, api_key).await
}
