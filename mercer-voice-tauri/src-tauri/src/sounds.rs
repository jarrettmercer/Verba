//! Short feedback blips for hotkey press (start) and release (stop).
//! Uses a single persistent audio stream to avoid open/close pops.

use rodio::source::Source;
use rodio::{OutputStream, Sink};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;
use std::thread;

const SAMPLE_RATE: u32 = 48000;
const VOLUME: f32 = 0.24;

enum Sound {
    Start,
    Stop,
}

static SENDER: OnceLock<mpsc::Sender<Sound>> = OnceLock::new();

fn sender() -> Option<&'static mpsc::Sender<Sound>> {
    SENDER.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || run_audio_thread(rx));
        tx
    });
    SENDER.get()
}

fn run_audio_thread(rx: mpsc::Receiver<Sound>) {
    let Ok((_stream, stream_handle)) = OutputStream::try_default() else { return };
    let Ok(sink) = Sink::try_new(&stream_handle) else { return };
    sink.set_volume(VOLUME);

    while let Ok(sound) = rx.recv() {
        let source = match sound {
            Sound::Start => EnvelopeTone::new(380.0, 14, 70.0),
            Sound::Stop => EnvelopeTone::new(280.0, 16, 65.0),
        };
        sink.append(source);
    }
}

/// Tone with smooth envelope; starts and ends at zero to avoid clicks.
struct EnvelopeTone {
    samples: Vec<f32>,
    position: usize,
}

impl EnvelopeTone {
    fn new(hz: f32, duration_ms: u32, decay: f32) -> Self {
        let num_samples = (SAMPLE_RATE as u32 * duration_ms / 1000) as usize;
        let mut samples = Vec::with_capacity(num_samples + 128);
        let two_pi = 2.0 * std::f32::consts::PI;

        // Lead-in: ~2ms silence so appending to the sink doesn't click
        let lead_in = (SAMPLE_RATE as usize * 2) / 1000;
        for _ in 0..lead_in {
            samples.push(0.0);
        }

        let tail_len = (num_samples / 4).max(8);
        let tail_start = num_samples.saturating_sub(tail_len);

        for i in 0..num_samples {
            let t = i as f32 / SAMPLE_RATE as f32;
            let attack = (1.0 - (-t * 1200.0).exp()).min(1.0);
            let decay_env = (-t * decay).exp();
            let mut envelope = attack * decay_env;
            if i >= tail_start {
                let fade = (num_samples - 1 - i) as f32 / (tail_len - 1).max(1) as f32;
                envelope *= fade;
            }
            let value = (two_pi * hz * t).sin() * envelope;
            samples.push(value);
        }

        // Trail: ~3ms silence so the stream doesn't cut off abruptly
        let trail = (SAMPLE_RATE as usize * 3) / 1000;
        for _ in 0..trail {
            samples.push(0.0);
        }

        Self { samples, position: 0 }
    }
}

impl Iterator for EnvelopeTone {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.position >= self.samples.len() {
            return None;
        }
        let v = self.samples[self.position];
        self.position += 1;
        Some(v)
    }
}

impl Source for EnvelopeTone {
    fn current_frame_len(&self) -> Option<usize> {
        Some(self.samples.len().saturating_sub(self.position))
    }

    fn channels(&self) -> u16 {
        1
    }

    fn sample_rate(&self) -> u32 {
        SAMPLE_RATE
    }

    fn total_duration(&self) -> Option<Duration> {
        Some(Duration::from_secs_f32(
            self.samples.len() as f32 / SAMPLE_RATE as f32,
        ))
    }
}

/// Play the "start" blip when you begin recording. Non-blocking.
pub fn play_beep() {
    if let Some(tx) = sender() {
        let _ = tx.send(Sound::Start);
    }
}

/// Play the "stop" blip when you finish recording. Non-blocking.
pub fn play_boop() {
    if let Some(tx) = sender() {
        let _ = tx.send(Sound::Stop);
    }
}
