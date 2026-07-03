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

/// Number of spectral bands published for the orb visualizers (log-spaced over
/// the voice range). Kept small: it crosses the IPC boundary ~30×/s.
pub const BAND_COUNT: usize = 16;
/// Lowest / highest band centre frequency (Hz). 85 Hz ≈ male fundamental,
/// 6.8 kHz ≈ sibilance — together they cover where a voice actually lives.
const BAND_F_LO: f32 = 85.0;
const BAND_F_HI: f32 = 6800.0;

// Per-band levels (0..1, f32 bits), published by the analyzer at each hop and
// read by the `mic_features` command. Statics mirror the REACT_* pattern below:
// there is exactly one Recorder per app.
static BAND_LEVELS: [AtomicU32; BAND_COUNT] = [const { AtomicU32::new(0) }; BAND_COUNT];

/// Current per-band spectrum (0..1 each), zeroed when not recording.
pub fn band_levels() -> [f32; BAND_COUNT] {
    let mut out = [0f32; BAND_COUNT];
    for (i, b) in BAND_LEVELS.iter().enumerate() {
        out[i] = f32::from_bits(b.load(Ordering::Relaxed));
    }
    out
}

fn clear_bands() {
    for b in &BAND_LEVELS {
        b.store(0, Ordering::Relaxed);
    }
}

/// Sliding-window Goertzel spectrum analyzer feeding [`BAND_LEVELS`].
///
/// Why Goertzel instead of an FFT dependency: we only need 16 log-spaced voice
/// bands, and 16 single-bin Goertzel passes over a ~40 ms window are a few µs of
/// work per 20 ms hop — cheap enough to run inline on the audio callback without
/// pulling in rustfft. The window is Hann-weighted so band energy is stable
/// (no leakage flicker), and the whole analysis is gated by the same noise
/// floor as the scalar VU so idle hiss never lights the orb.
struct Analyzer {
    ring: Vec<f32>,
    pos: usize,
    until_hop: usize,
    hop_len: usize,
    coeffs: [f32; BAND_COUNT],
    hann: Vec<f32>,
}

impl Analyzer {
    fn new(sample_rate: u32) -> Self {
        let sr = sample_rate.max(8000) as f32;
        // ~40 ms window (freq resolution ≈ 25 Hz), ~20 ms hop → 50 spectra/s,
        // comfortably above the UI's ~30 Hz poll.
        let win = ((sr * 0.04) as usize).clamp(512, 4096);
        let mut coeffs = [0f32; BAND_COUNT];
        for (i, c) in coeffs.iter_mut().enumerate() {
            let f = BAND_F_LO * (BAND_F_HI / BAND_F_LO).powf(i as f32 / (BAND_COUNT - 1) as f32);
            let f = f.min(sr * 0.45); // never above (near) Nyquist
            *c = 2.0 * (2.0 * std::f32::consts::PI * f / sr).cos();
        }
        let hann: Vec<f32> = (0..win)
            .map(|j| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * j as f32 / (win - 1) as f32).cos())
            .collect();
        Self {
            ring: vec![0.0; win],
            pos: 0,
            until_hop: win / 2,
            hop_len: win / 2,
            coeffs,
            hann,
        }
    }

    /// Push one mono sample; publishes a fresh spectrum every hop.
    fn feed(&mut self, s: f32) {
        self.ring[self.pos] = s;
        self.pos = (self.pos + 1) % self.ring.len();
        self.until_hop -= 1;
        if self.until_hop == 0 {
            self.until_hop = self.hop_len;
            let bands = self.analyze();
            for (i, b) in bands.iter().enumerate() {
                BAND_LEVELS[i].store(b.to_bits(), Ordering::Relaxed);
            }
        }
    }

    /// One spectrum over the current window: Goertzel power per band → dB →
    /// 0..1 with a gentle high-frequency tilt (voices roll off with frequency;
    /// without the tilt the upper bands would never visibly move).
    fn analyze(&self) -> [f32; BAND_COUNT] {
        let win = self.ring.len();
        let mut out = [0f32; BAND_COUNT];
        // Same gate as the scalar VU: true silence keeps the spectrum at rest.
        let noise_floor = f32::from_bits(REACT_NOISE_FLOOR.load(Ordering::Relaxed));
        let mut sum_sq = 0f32;
        for &s in &self.ring {
            sum_sq += s * s;
        }
        if (sum_sq / win as f32).sqrt() < noise_floor {
            return out;
        }
        for (bi, coeff) in self.coeffs.iter().enumerate() {
            let (mut s1, mut s2) = (0f32, 0f32);
            for j in 0..win {
                let x = self.ring[(self.pos + j) % win] * self.hann[j];
                let s0 = x + coeff * s1 - s2;
                s2 = s1;
                s1 = s0;
            }
            let power = (s1 * s1 + s2 * s2 - coeff * s1 * s2).max(0.0);
            // Hann coherent gain is 0.5 → a full-scale sine peaks the bin at
            // win/4; normalising by that makes `amp` ≈ the sine's amplitude.
            let amp = power.sqrt() / (win as f32 * 0.25);
            let db = 20.0 * (amp + 1e-6).log10();
            let tilt = 14.0 * (bi as f32 / (BAND_COUNT - 1) as f32);
            out[bi] = (((db + tilt) + 54.0) / 42.0).clamp(0.0, 1.0).powf(0.8);
        }
        out
    }
}

pub struct Capture {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

enum Cmd {
    /// Open + start the input stream. Replies Ok(()) once the stream is playing,
    /// or Err(german message) if the mic couldn't be opened (no device / busy /
    /// permission) — so the UI can surface a real error instead of pretending to
    /// record into nothing.
    Start {
        device: Option<String>,
        reply: Sender<Result<(), String>>,
    },
    Stop(Sender<Capture>),
    /// Clone the buffer captured SO FAR without stopping the stream — feeds
    /// incremental/streaming transcription (partial text while still talking).
    Snapshot(Sender<Capture>),
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

    /// Start capture and wait for the worker to confirm the stream is live.
    /// Returns a user-facing (German) error if the mic couldn't be opened so the
    /// caller can emit an error state instead of a phantom "recording" state.
    pub fn start(&self, device: Option<String>) -> Result<(), String> {
        let (rtx, rrx) = channel();
        if self
            .tx
            .lock()
            .send(Cmd::Start { device, reply: rtx })
            .is_err()
        {
            return Err("Audio-Subsystem nicht verfügbar.".into());
        }
        // Opening a WASAPI/ALSA device is normally well under a second; 5 s is a
        // generous ceiling that still bounds a wedged backend.
        match rrx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(r) => r,
            Err(_) => {
                // The worker may still be opening a slow device. Queue a Stop so
                // that if the Start eventually succeeds it's torn down immediately,
                // instead of leaving a phantom active stream behind the error we
                // return here (state would otherwise disagree with the UI).
                let (dtx, _drx) = channel();
                let _ = self.tx.lock().send(Cmd::Stop(dtx));
                Err("Mikrofon-Start hat nicht reagiert.".into())
            }
        }
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

    /// Copy of everything captured so far; recording keeps running. None when
    /// no recording is active (or the audio worker is gone).
    pub fn snapshot(&self) -> Option<Capture> {
        if !self.is_recording() {
            return None;
        }
        let (rtx, rrx) = channel();
        if self.tx.lock().send(Cmd::Snapshot(rtx)).is_ok() {
            rrx.recv().ok().filter(|c| !c.samples.is_empty())
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
            Cmd::Start { device, reply } => {
                if active.is_some() {
                    let _ = reply.send(Ok(())); // already recording (idempotent)
                    continue;
                }
                match build_stream(device, level.clone()) {
                    Ok((stream, buf, sr)) => match stream.play() {
                        Ok(()) => {
                            recording.store(true, Ordering::Relaxed);
                            active = Some((stream, buf, sr));
                            let _ = reply.send(Ok(()));
                        }
                        Err(e) => {
                            log::error!("recorder: stream.play failed: {e}");
                            let _ = reply.send(Err(format!(
                                "Mikrofon konnte nicht gestartet werden (evtl. von einer anderen App belegt): {e}"
                            )));
                        }
                    },
                    Err(e) => {
                        log::error!("recorder: start failed: {e}");
                        let _ = reply.send(Err(friendly_mic_error(&e)));
                    }
                }
            }
            Cmd::Snapshot(reply) => {
                let cap = match &active {
                    Some((_, buf, sr)) => Capture {
                        samples: buf.lock().clone(),
                        sample_rate: *sr,
                    },
                    None => Capture {
                        samples: Vec::new(),
                        sample_rate: 16_000,
                    },
                };
                let _ = reply.send(cap);
            }
            Cmd::Stop(reply) => {
                recording.store(false, Ordering::Relaxed);
                level.store(0, Ordering::Relaxed);
                clear_bands();
                match active.take() {
                    Some((stream, buf, sr)) => {
                        drop(stream); // halt capture + release the mic (coreaudio
                        // uninitialize/dispose runs in the Stream's Drop → the macOS
                        // mic indicator turns off). Logged so a field log proves the
                        // mic was released after a session (diagnose a lingering dot).
                        let samples = std::mem::take(&mut *buf.lock());
                        log::info!(
                            "recorder: stopped — input stream dropped, mic released ({} samples @ {} Hz)",
                            samples.len(),
                            sr
                        );
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

/// Map a cpal/device error to a short, user-facing German message. The raw error
/// is logged separately; this is what the UI shows.
fn friendly_mic_error(e: &anyhow::Error) -> String {
    let s = e.to_string().to_lowercase();
    if s.contains("no input device") || s.contains("no default input device") {
        "Kein Mikrofon gefunden. Bitte ein Mikrofon anschließen und erneut versuchen.".into()
    } else if s.contains("denied") || s.contains("permission") || s.contains("access") {
        "Mikrofon-Zugriff verweigert. Bitte die Mikrofon-Berechtigung erlauben.".into()
    } else if s.contains("not available") || s.contains("in use") || s.contains("busy") {
        "Mikrofon nicht verfügbar (evtl. von einer anderen App belegt).".into()
    } else {
        format!("Mikrofon konnte nicht geöffnet werden: {e}")
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
    // Fresh spectrum analyzer per stream (window sized to the device rate);
    // stale bands from a previous session are cleared right away.
    clear_bands();
    let analyzer = Arc::new(Mutex::new(Analyzer::new(sample_rate)));
    // Hard cap so a forgotten (toggle) recording can't exhaust memory. Long-form
    // meeting capture (M3) will stream to disk instead.
    let max_samples = sample_rate as usize * MAX_RECORD_SECONDS;
    let err_fn = |e| log::error!("recorder: stream error: {e}");

    let stream = match fmt {
        cpal::SampleFormat::F32 => {
            let (b, l, a) = (buf.clone(), level.clone(), analyzer.clone());
            device.build_input_stream(
                &config,
                move |data: &[f32], _| ingest(data, channels, max_samples, &b, &l, &a),
                err_fn,
                None,
            )?
        }
        cpal::SampleFormat::I16 => {
            let (b, l, a) = (buf.clone(), level.clone(), analyzer.clone());
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    let f: Vec<f32> = data.iter().map(|s| *s as f32 / 32768.0).collect();
                    ingest(&f, channels, max_samples, &b, &l, &a);
                },
                err_fn,
                None,
            )?
        }
        cpal::SampleFormat::U16 => {
            let (b, l, a) = (buf.clone(), level.clone(), analyzer.clone());
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    let f: Vec<f32> = data.iter().map(|s| (*s as f32 - 32768.0) / 32768.0).collect();
                    ingest(&f, channels, max_samples, &b, &l, &a);
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
// Voice-reactivity of the VU mapping, live-tunable from config without coupling
// the recorder to Config (the hot audio path stays self-contained). Stored as
// f32 bits; `set_reactivity` is called at startup and on every config change.
// Defaults mirror the previous hardcoded constants (noise_floor 0.01 / gain 7.5
// / gamma 0.55) so behaviour is identical until the user tweaks a profile.
static REACT_NOISE_FLOOR: AtomicU32 = AtomicU32::new(0x3c23d70a); // 0.01
static REACT_GAIN: AtomicU32 = AtomicU32::new(0x40f00000); // 7.5
static REACT_GAMMA: AtomicU32 = AtomicU32::new(0x3f0ccccd); // 0.55

/// Update the orb's voice-reactivity params (from config). Sane clamps so a bad
/// profile can't break the meters: floor 0..0.2, gain 0.5..40, gamma 0.1..2.
pub fn set_reactivity(noise_floor: f32, gain: f32, gamma: f32) {
    REACT_NOISE_FLOOR.store(noise_floor.clamp(0.0, 0.2).to_bits(), Ordering::Relaxed);
    REACT_GAIN.store(gain.clamp(0.5, 40.0).to_bits(), Ordering::Relaxed);
    REACT_GAMMA.store(gamma.clamp(0.1, 2.0).to_bits(), Ordering::Relaxed);
}

fn ingest(
    data: &[f32],
    channels: usize,
    max: usize,
    buf: &Arc<Mutex<Vec<f32>>>,
    level: &Arc<AtomicU32>,
    analyzer: &Arc<Mutex<Analyzer>>,
) {
    let mut sum_sq = 0f32;
    let n;
    {
        // Lock order: analyzer → buf (only place both are held; band reads go
        // through atomics, so nothing else ever takes the analyzer lock).
        let mut an = analyzer.lock();
        let mut guard = buf.lock();
        let capped = guard.len() >= max;
        if channels <= 1 {
            if !capped {
                guard.extend_from_slice(data);
            }
            for &s in data {
                sum_sq += s * s;
                an.feed(s);
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
                an.feed(m);
            }
            n = frames;
        }
    }
    if n > 0 {
        let rms = (sum_sq / n as f32).sqrt();
        // Perceptual VU mapping so normal speaking/prompting volume visibly deflects
        // the orb meters (a flat `rms * 4` left quiet speech near the floor). Three
        // stages: (1) a tiny noise gate so true silence stays at rest, (2) a strong
        // linear gain, (3) a gamma < 1 that expands the quiet→mid range — the band
        // an actual voice lives in — while still saturating to 1.0 when you're loud.
        let noise_floor = f32::from_bits(REACT_NOISE_FLOOR.load(Ordering::Relaxed));
        let gain = f32::from_bits(REACT_GAIN.load(Ordering::Relaxed));
        let gamma = f32::from_bits(REACT_GAMMA.load(Ordering::Relaxed));
        let gated = (rms - noise_floor).max(0.0);
        let boosted = (gated * gain).min(1.0).powf(gamma);
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

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    /// Centre frequency of band `i` — mirrors `Analyzer::new`.
    fn band_freq(i: usize) -> f32 {
        BAND_F_LO * (BAND_F_HI / BAND_F_LO).powf(i as f32 / (BAND_COUNT - 1) as f32)
    }

    fn analyze_sine(freq: f32, amp: f32) -> [f32; BAND_COUNT] {
        let mut an = Analyzer::new(SR as u32);
        let win = an.ring.len();
        for i in 0..win {
            an.ring[an.pos] = amp * (2.0 * std::f32::consts::PI * freq * i as f32 / SR).sin();
            an.pos = (an.pos + 1) % win;
        }
        an.analyze()
    }

    #[test]
    fn sine_lights_its_own_band() {
        // A sine exactly on band 5's centre must dominate the spectrum there.
        let out = analyze_sine(band_freq(5), 0.25);
        let max_i = (0..BAND_COUNT).max_by(|&a, &b| out[a].total_cmp(&out[b])).unwrap();
        assert_eq!(max_i, 5, "expected band 5 to peak, spectrum: {out:?}");
        assert!(out[5] > 0.6, "on-centre band too weak: {}", out[5]);
        assert!(out[0] < out[5] * 0.6 && out[15] < out[5] * 0.6, "spectrum not selective: {out:?}");
    }

    #[test]
    fn silence_stays_dark() {
        let out = analyze_sine(band_freq(8), 0.0);
        assert!(out.iter().all(|&b| b == 0.0), "silence lit bands: {out:?}");
    }

    #[test]
    fn below_noise_floor_is_gated() {
        // Amplitude well under the default 0.01 RMS gate → fully dark.
        let out = analyze_sine(band_freq(8), 0.005);
        assert!(out.iter().all(|&b| b == 0.0), "sub-gate signal lit bands: {out:?}");
    }
}
