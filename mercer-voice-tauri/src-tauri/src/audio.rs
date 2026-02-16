use crate::store::Store;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use serde::Serialize;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

enum AudioCommand {
    Stop,
}

pub struct AudioState {
    samples: Arc<Mutex<Vec<i16>>>,
    stop_tx: Mutex<Option<mpsc::Sender<AudioCommand>>>,
    /// Sample rate of the last recording (set when stream starts).
    sample_rate: Mutex<u32>,
}

impl Default for AudioState {
    fn default() -> Self {
        Self {
            samples: Arc::new(Mutex::new(Vec::new())),
            stop_tx: Mutex::new(None),
            sample_rate: Mutex::new(16000),
        }
    }
}

fn emit_recording_failed(app: &AppHandle, msg: &str) {
    let _ = app.emit_to("main", "recording-failed", msg);
}

/// Called from both the Tauri command (frontend) and the hotkey handler (backend-only flow).
pub fn start_recording_impl(app: &AppHandle) -> Result<(), String> {
    let store = app.state::<Store>();
    if !store.get_license_status() {
        return Err("Please activate with a product key first".to_string());
    }
    let state = app.state::<AudioState>();
    do_start_recording(app.clone(), state)
}

fn do_start_recording(app: AppHandle, state: State<'_, AudioState>) -> Result<(), String> {
    eprintln!("[Verba] start_recording");

    let host = cpal::default_host();
    let device = host.default_input_device().ok_or_else(|| {
        if cfg!(target_os = "windows") {
            "No microphone found. Open Windows Settings → Privacy & Security → Microphone and make sure microphone access is turned ON, then restart Verba.".to_string()
        } else {
            "No microphone found. On macOS, grant access in System Settings → Privacy & Security → Microphone for Verba.".to_string()
        }
    })?;

    eprintln!(
        "[Verba] Using input device: {}",
        device.name().unwrap_or_default()
    );

    // Use the device's default config so we match its native format (e.g. Float32 on macOS).
    let default_supported = device
        .default_input_config()
        .map_err(|e| format!("Failed to get default input config: {}", e))?;

    let config: cpal::StreamConfig = default_supported.into();
    let target_sample_rate = config.sample_rate.0;
    let target_channels = config.channels;

    eprintln!(
        "[Verba] Recording at {}Hz, {}ch (device default)",
        target_sample_rate, target_channels
    );

    state.samples.lock().unwrap().clear();
    *state.sample_rate.lock().unwrap() = target_sample_rate;

    let samples = state.samples.clone();
    let app_handle = app.clone();
    let (stop_tx, stop_rx) = mpsc::channel::<AudioCommand>();

    *state.stop_tx.lock().unwrap() = Some(stop_tx);

    let channels = target_channels;

    // Spawn audio capture on a dedicated thread (cpal::Stream is !Send).
    // Use f32 callback: macOS Core Audio typically uses Float32 natively.
    std::thread::spawn(move || {
        let recording = Arc::new(Mutex::new(true));
        let recording_clone = recording.clone();
        let chunk_size = (target_sample_rate as usize / 30) * channels as usize;
        let chunk_buffer: Arc<Mutex<Vec<i16>>> =
            Arc::new(Mutex::new(Vec::with_capacity(chunk_size)));
        let chunk_buf = chunk_buffer.clone();
        let app_handle_for_callback = app_handle.clone();

        // On Windows, try to open Privacy settings if microphone access seems blocked
        #[cfg(target_os = "windows")]
        {
            // Check if we can actually access the device by querying supported configs
            if device.supported_input_configs().is_err() {
                let msg = "Microphone access is blocked. Open Windows Settings → Privacy & Security → Microphone, turn it ON, then restart Verba.";
                eprintln!("[Verba] {}", msg);
                emit_recording_failed(&app_handle, msg);
                // Try to open Windows Privacy settings
                let _ = std::process::Command::new("cmd")
                    .args(["/C", "start", "ms-settings:privacy-microphone"])
                    .spawn();
                return;
            }
        }

        let stream = match device.build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if !*recording_clone.lock().unwrap() {
                    return;
                }

                // Convert f32 (-1.0..=1.0) to i16 and optionally downmix to mono
                let mono: Vec<i16> = if channels > 1 {
                    data.chunks(channels as usize)
                        .map(|frame| {
                            let sum: f32 = frame.iter().sum();
                            let s = sum / channels as f32;
                            (s * 32767.0).round().clamp(-32768.0, 32767.0) as i16
                        })
                        .collect()
                } else {
                    data
                        .iter()
                        .map(|&s| (s * 32767.0).round().clamp(-32768.0, 32767.0) as i16)
                        .collect()
                };

                samples.lock().unwrap().extend_from_slice(&mono);

                let mut chunk = chunk_buf.lock().unwrap();
                chunk.extend_from_slice(&mono);

                let mono_chunk_size = chunk_size / channels as usize;
                if chunk.len() >= mono_chunk_size {
                    let sum: f64 = chunk.iter().map(|&s| (s as f64).powi(2)).sum();
                    let rms = (sum / chunk.len() as f64).sqrt();
                    // Scale so normal speech gives visible movement (~8x gain, cap at 1)
                    let level = (rms / 32767.0 * 8.0).min(1.0) as f32;
                    #[derive(Clone, Serialize)]
                    struct LevelPayload { level: f32 }
                    let _ = app_handle_for_callback.emit_to("main", "audio-level", LevelPayload { level });
                    chunk.clear();
                }
            },
            move |err| {
                eprintln!("[Verba] Audio stream error: {}", err);
            },
            None,
        ) {
            Ok(s) => s,
            Err(e) => {
                let msg = if cfg!(target_os = "windows") {
                    format!(
                        "Microphone failed to start: {}. Open Windows Settings → Privacy & Security → Microphone and make sure it's ON.",
                        e
                    )
                } else {
                    format!(
                        "Microphone failed to start: {}. Grant access in System Settings → Privacy & Security → Microphone.",
                        e
                    )
                };
                eprintln!("[Verba] {}", msg);
                emit_recording_failed(&app_handle, &msg);
                return;
            }
        };

        if let Err(e) = stream.play() {
            let msg = if cfg!(target_os = "windows") {
                format!(
                    "Microphone failed to start: {}. Open Windows Settings → Privacy & Security → Microphone and make sure it's ON.",
                    e
                )
            } else {
                format!(
                    "Microphone failed to start: {}. Grant access in System Settings → Privacy & Security → Microphone.",
                    e
                )
            };
            eprintln!("[Verba] {}", msg);
            emit_recording_failed(&app_handle, &msg);
            return;
        }

        eprintln!("[Verba] Audio stream started");
        let _ = app_handle.emit_to("main", "recording-started", ());

        let _ = stop_rx.recv();
        *recording.lock().unwrap() = false;
        eprintln!("[Verba] Audio stream stopped");
    });

    Ok(())
}

#[tauri::command]
pub fn start_recording(app: AppHandle, state: State<'_, AudioState>) -> Result<(), String> {
    let store = app.state::<Store>();
    if !store.get_license_status() {
        return Err("Please activate with a product key first".to_string());
    }
    do_start_recording(app, state)
}

/// Called from both the Tauri command and the hotkey handler.
pub fn stop_recording_impl(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<AudioState>();
    let path = do_stop_recording(state)?;
    let _ = app.emit_to("main", "recording-stopped", ());
    Ok(path)
}

fn do_stop_recording(state: State<'_, AudioState>) -> Result<String, String> {
    eprintln!("[Verba] stop_recording");

    // Send stop signal to the audio thread
    if let Some(tx) = state.stop_tx.lock().unwrap().take() {
        let _ = tx.send(AudioCommand::Stop);
    }

    // Brief delay to let the audio thread finish
    std::thread::sleep(std::time::Duration::from_millis(100));

    let samples = state.samples.lock().unwrap();

    eprintln!("[Verba] Captured {} samples", samples.len());

    if samples.is_empty() {
        return Err("No audio captured. Grant microphone access in System Settings → Privacy & Security → Microphone (look for Verba), then try again.".to_string());
    }

    let device_rate = *state.sample_rate.lock().unwrap();

    // Downsample to 16 kHz (Whisper's native rate) to shrink the upload.
    const TARGET_RATE: u32 = 16000;
    let (wav_samples, wav_rate) = if device_rate > TARGET_RATE {
        (downsample(&samples, device_rate, TARGET_RATE), TARGET_RATE)
    } else {
        (samples.to_vec(), device_rate)
    };

    eprintln!(
        "[Verba] Resampled {}→{}Hz ({} → {} samples)",
        device_rate, wav_rate, samples.len(), wav_samples.len()
    );

    // Write WAV to temp file (mono, 16 kHz)
    let temp_path = std::env::temp_dir().join("verba_recording.wav");
    let spec = WavSpec {
        channels: 1,
        sample_rate: wav_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer =
        WavWriter::create(&temp_path, spec).map_err(|e| format!("Failed to create WAV: {}", e))?;

    for &sample in wav_samples.iter() {
        writer
            .write_sample(sample)
            .map_err(|e| format!("Failed to write sample: {}", e))?;
    }

    writer
        .finalize()
        .map_err(|e| format!("Failed to finalize WAV: {}", e))?;

    let file_size = std::fs::metadata(&temp_path)
        .map(|m| m.len())
        .unwrap_or(0);
    eprintln!(
        "[Verba] WAV written: {} ({} bytes)",
        temp_path.display(),
        file_size
    );

    Ok(temp_path.to_string_lossy().to_string())
}

/// Linear-interpolation downsample from `from_rate` to `to_rate`.
fn downsample(samples: &[i16], from_rate: u32, to_rate: u32) -> Vec<i16> {
    if from_rate == to_rate || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = from_rate as f64 / to_rate as f64;
    let out_len = (samples.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 * ratio;
        let idx = src as usize;
        let frac = src - idx as f64;
        let s = if idx + 1 < samples.len() {
            let a = samples[idx] as f64;
            let b = samples[idx + 1] as f64;
            (a + frac * (b - a)) as i16
        } else {
            samples[idx.min(samples.len() - 1)]
        };
        out.push(s);
    }
    out
}

#[tauri::command]
pub fn stop_recording(state: State<'_, AudioState>) -> Result<String, String> {
    do_stop_recording(state)
}
