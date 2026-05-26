//! Audio capture via cpal.
//!
//! The cpal `Stream` is `!Send` on several backends, so it can't live in Tauri's
//! shared state. Instead a dedicated worker thread owns the stream and is driven
//! over a command channel; the public [`Recorder`] handle holds only `Send + Sync`
//! pieces (a `Mutex<Sender>`, an atomic RMS level, an atomic recording flag).
//!
//! Capture is mono f32. We record at the device's native sample rate and tag the
//! buffer with it — the cloud server decodes WAV at any rate, and the local
//! whisper.cpp path resamples to 16 kHz when it lands.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;

/// Hard cap on a single recording (bounds memory). 30 min is far beyond any
/// dictation; long-form meeting capture (M3) will stream to disk instead.
const MAX_RECORD_SECONDS: usize = 1800;

pub struct Capture {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

enum Cmd {
    Start { device: Option<String> },
    Stop(Sender<Capture>),
}

pub struct Recorder {
    tx: Mutex<Sender<Cmd>>,
    level: Arc<AtomicU32>, // f32 bits
    #[allow(dead_code)] // read by hotkey/overlay (next task)
    recording: Arc<AtomicBool>,
}

impl Recorder {
    pub fn new() -> Self {
        let (tx, rx) = channel::<Cmd>();
        let level = Arc::new(AtomicU32::new(0));
        let recording = Arc::new(AtomicBool::new(false));
        let lvl = level.clone();
        let rec = recording.clone();
        std::thread::Builder::new()
            .name("echo-audio".into())
            .spawn(move || worker(rx, lvl, rec))
            .expect("spawn audio worker");
        Self {
            tx: Mutex::new(tx),
            level,
            recording,
        }
    }

    pub fn start(&self, device: Option<String>) {
        let _ = self.tx.lock().send(Cmd::Start { device });
    }

    /// Stop and return the captured buffer (blocks until the worker replies).
    pub fn stop(&self) -> Option<Capture> {
        let (rtx, rrx) = channel();
        if self.tx.lock().send(Cmd::Stop(rtx)).is_ok() {
            rrx.recv().ok()
        } else {
            None
        }
    }

    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }

    #[allow(dead_code)] // used by hotkey/overlay (next task)
    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::Relaxed)
    }
}

impl Default for Recorder {
    fn default() -> Self {
        Self::new()
    }
}

fn worker(rx: Receiver<Cmd>, level: Arc<AtomicU32>, recording: Arc<AtomicBool>) {
    // (stream, shared buffer, sample_rate). Stream stays parked on this thread.
    let mut active: Option<(cpal::Stream, Arc<Mutex<Vec<f32>>>, u32)> = None;

    while let Ok(cmd) = rx.recv() {
        match cmd {
            Cmd::Start { device } => {
                if active.is_some() {
                    continue;
                }
                match build_stream(device, level.clone()) {
                    Ok((stream, buf, sr)) => match stream.play() {
                        Ok(()) => {
                            recording.store(true, Ordering::Relaxed);
                            active = Some((stream, buf, sr));
                        }
                        Err(e) => log::error!("recorder: stream.play failed: {e}"),
                    },
                    Err(e) => log::error!("recorder: start failed: {e}"),
                }
            }
            Cmd::Stop(reply) => {
                recording.store(false, Ordering::Relaxed);
                level.store(0, Ordering::Relaxed);
                match active.take() {
                    Some((stream, buf, sr)) => {
                        drop(stream); // halt capture
                        let samples = std::mem::take(&mut *buf.lock());
                        let _ = reply.send(Capture {
                            samples,
                            sample_rate: sr,
                        });
                    }
                    None => {
                        let _ = reply.send(Capture {
                            samples: Vec::new(),
                            sample_rate: 16_000,
                        });
                    }
                }
            }
        }
    }
}

fn build_stream(
    device_name: Option<String>,
    level: Arc<AtomicU32>,
) -> anyhow::Result<(cpal::Stream, Arc<Mutex<Vec<f32>>>, u32)> {
    let host = cpal::default_host();
    let device = match device_name {
        Some(name) if !name.is_empty() && name != "System Default" => host
            .input_devices()?
            .find(|d| d.name().map(|n| n == name).unwrap_or(false))
            .or_else(|| host.default_input_device())
            .ok_or_else(|| anyhow::anyhow!("no input device"))?,
        _ => host
            .default_input_device()
            .ok_or_else(|| anyhow::anyhow!("no default input device"))?,
    };

    let supported = device.default_input_config()?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let fmt = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let buf = Arc::new(Mutex::new(Vec::<f32>::new()));
    // Hard cap so a forgotten (toggle) recording can't exhaust memory. Long-form
    // meeting capture (M3) will stream to disk instead.
    let max_samples = sample_rate as usize * MAX_RECORD_SECONDS;
    let err_fn = |e| log::error!("recorder: stream error: {e}");

    let stream = match fmt {
        cpal::SampleFormat::F32 => {
            let (b, l) = (buf.clone(), level.clone());
            device.build_input_stream(
                &config,
                move |data: &[f32], _| ingest(data, channels, max_samples, &b, &l),
                err_fn,
                None,
            )?
        }
        cpal::SampleFormat::I16 => {
            let (b, l) = (buf.clone(), level.clone());
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    let f: Vec<f32> = data.iter().map(|s| *s as f32 / 32768.0).collect();
                    ingest(&f, channels, max_samples, &b, &l);
                },
                err_fn,
                None,
            )?
        }
        cpal::SampleFormat::U16 => {
            let (b, l) = (buf.clone(), level.clone());
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    let f: Vec<f32> = data.iter().map(|s| (*s as f32 - 32768.0) / 32768.0).collect();
                    ingest(&f, channels, max_samples, &b, &l);
                },
                err_fn,
                None,
            )?
        }
        other => anyhow::bail!("unsupported sample format: {other:?}"),
    };

    Ok((stream, buf, sample_rate))
}

/// Downmix to mono, append to the buffer (bounded by `max`), and publish a
/// boosted RMS level (0..1). Level keeps updating even once the buffer is capped.
fn ingest(
    data: &[f32],
    channels: usize,
    max: usize,
    buf: &Arc<Mutex<Vec<f32>>>,
    level: &Arc<AtomicU32>,
) {
    let mut sum_sq = 0f32;
    let n;
    {
        let mut guard = buf.lock();
        let capped = guard.len() >= max;
        if channels <= 1 {
            if !capped {
                guard.extend_from_slice(data);
            }
            for &s in data {
                sum_sq += s * s;
            }
            n = data.len();
        } else {
            let frames = data.len() / channels;
            if !capped {
                guard.reserve(frames);
            }
            for f in 0..frames {
                let mut acc = 0f32;
                for c in 0..channels {
                    acc += data[f * channels + c];
                }
                let m = acc / channels as f32;
                if !capped {
                    guard.push(m);
                }
                sum_sq += m * m;
            }
            n = frames;
        }
    }
    if n > 0 {
        let rms = (sum_sq / n as f32).sqrt();
        let boosted = (rms * 4.0).min(1.0); // 4x boost for UI punch (parity with recorder.py)
        level.store(boosted.to_bits(), Ordering::Relaxed);
    }
}

pub fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    match host.input_devices() {
        Ok(devs) => devs.filter_map(|d| d.name().ok()).collect(),
        Err(_) => Vec::new(),
    }
}
