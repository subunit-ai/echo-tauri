//! Transcription dispatcher.
//!
//! Cloud (subunit, incl. the Groq-proxied "superfast") speaks the exact
//! `transcribe.subunit.ai/v1/transcribe` contract. Local (whisper.cpp via
//! whisper-rs) is feature-gated behind `local-whisper`. These two are the only
//! supported engines — config coerces any other mode to subunit on load.

mod cloud;
#[cfg(feature = "local-whisper")]
mod local;
// Opus speech compression for uploads — all platforms (libopus via opusic-sys,
// CMake-built from vendored source; see Cargo.toml).
mod opus_enc;
pub mod vocab;

use crate::config::Config;
use serde::Serialize;

/// A timed transcript segment (for diarization speaker-merge on long-form).
#[derive(Debug, Clone, Serialize, Default)]
pub struct Segment {
    pub start_s: f64,
    pub end_s: f64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct TranscriptResult {
    pub text: String,
    pub quality_mode: String,
    /// Timed segments — only populated when requested (long-form diarization);
    /// empty for normal dictation so the IPC payload stays lean.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub segments: Vec<Segment>,
    /// Server-cleaned transcript from the combined transcribe+cleanup round trip
    /// (cloud only). `Some` only when a `cleanup_style` was requested AND the
    /// server returned it; `None` → the caller runs its own cleanup call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleaned_text: Option<String>,
}

/// Structured error across the IPC boundary so the frontend branches on `code`
/// (e.g. "trial_expired" → paywall, "auth" → re-login) instead of string matching.
#[derive(Debug, Clone, Serialize)]
pub struct EngineError {
    pub code: String,
    pub message: String,
}

impl EngineError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}
impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for EngineError {}

/// Dispatch by mode. Cloud encodes WAV from the samples; local resamples to
/// 16 kHz and runs whisper.cpp.
/// `want_segments` requests timed transcript segments (used by the long-form
/// diarization merge); off for normal dictation keeps the payload lean.
/// `cleanup_style` requests the combined transcribe+cleanup round trip (cloud
/// only): the server runs the AI cleanup and returns `cleaned_text` in the same
/// response, saving a second round trip. `None`/raw → no inline cleanup.
pub fn run_opts(
    cfg: &Config,
    samples: &[f32],
    sample_rate: u32,
    want_segments: bool,
    cleanup_style: Option<&str>,
) -> Result<TranscriptResult, EngineError> {
    match cfg.mode.as_str() {
        "local" => {
            #[cfg(feature = "local-whisper")]
            {
                local::run(cfg, samples, sample_rate, want_segments)
                    .map_err(|e| EngineError::new("local", e.to_string()))
            }
            #[cfg(not(feature = "local-whisper"))]
            {
                let _ = (samples, sample_rate, want_segments);
                Err(EngineError::new(
                    "model_missing",
                    "local engine not built — switch to Cloud",
                ))
            }
        }
        "subunit" => {
            // Downsample to 16 kHz BEFORE upload. Whisper runs at 16 kHz and the
            // server downsamples anything else with the same linear resample
            // anyway — so this is lossless for accuracy but shrinks the upload ~3×
            // (mics capture at 48 kHz). The upload, not the GPU, was the bottleneck:
            // a 48 kHz WAV is ~750 kbit/s, so a 70 s dictation = 6.5 MB and on a
            // modest uplink that dominated end-to-end latency (server transcribes
            // 70 s in ~3 s; the rest was the upload).
            let (samples16, _) = downsample_to_16k(samples, sample_rate);
            // Then compress to Opus (~8× smaller again, ASR-transparent) when the
            // encoder is available; fall back to the 16 kHz WAV otherwise. The
            // server's ffmpeg path decodes the .ogg transparently.
            let (bytes, file_name) = encode_upload(&samples16)
                .map_err(|e| EngineError::new("internal", e.to_string()))?;
            cloud::transcribe_subunit(cfg, bytes, file_name, cfg.cloud_superfast, want_segments, cleanup_style)
        }
        other => Err(EngineError::new(
            "unsupported",
            format!("mode `{other}` not implemented yet"),
        )),
    }
}

/// Linear-resample mono f32 down to 16 kHz for the cloud upload. Returns the
/// samples unchanged when already at (or below) 16 kHz. Linear interpolation
/// matches both the local whisper path and the server's own resample, so it
/// adds no accuracy difference — it only shrinks the bytes on the wire.
fn downsample_to_16k(input: &[f32], sr: u32) -> (Vec<f32>, u32) {
    if sr <= 16_000 || input.is_empty() {
        return (input.to_vec(), sr);
    }
    let ratio = 16_000f64 / sr as f64;
    let out_len = ((input.len() as f64) * ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let frac = (src - idx as f64) as f32;
        let a = input.get(idx).copied().unwrap_or(0.0);
        let b = input.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    (out, 16_000)
}

/// Build the upload payload from 16 kHz mono samples: Opus-in-Ogg (~8× smaller,
/// ASR-transparent) with a 16 kHz WAV fallback if the encoder ever errors.
/// Returns the bytes plus the filename whose extension tells the server which
/// decoder to use.
fn encode_upload(samples16: &[f32]) -> anyhow::Result<(Vec<u8>, &'static str)> {
    match opus_enc::encode_ogg_opus(samples16) {
        Ok(ogg) => Ok((ogg, "audio.ogg")),
        Err(e) => {
            log::warn!("opus encode failed ({e}) — falling back to 16 kHz WAV");
            Ok((samples_to_wav(samples16, 16_000)?, "audio.wav"))
        }
    }
}

/// Encode mono f32 samples as 16-bit PCM WAV bytes (in-memory).
pub fn samples_to_wav(samples: &[f32], sample_rate: u32) -> anyhow::Result<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut w = hound::WavWriter::new(&mut cursor, spec)?;
        for &s in samples {
            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            w.write_sample(v)?;
        }
        w.finalize()?;
    }
    Ok(cursor.into_inner())
}
