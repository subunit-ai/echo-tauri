//! Transcription dispatcher.
//!
//! Cloud (subunit, incl. the Groq-proxied "superfast") speaks the exact
//! `transcribe.subunit.ai/v1/transcribe` contract. Local (whisper.cpp via
//! whisper-rs) is feature-gated behind `local-whisper`. These two are the only
//! supported engines — config coerces any other mode to subunit on load.

mod cloud;
#[cfg(feature = "local-whisper")]
mod local;
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
pub fn run_opts(
    cfg: &Config,
    samples: &[f32],
    sample_rate: u32,
    want_segments: bool,
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
            let wav = samples_to_wav(samples, sample_rate)
                .map_err(|e| EngineError::new("internal", e.to_string()))?;
            cloud::transcribe_subunit(cfg, wav, cfg.cloud_superfast, want_segments)
        }
        other => Err(EngineError::new(
            "unsupported",
            format!("mode `{other}` not implemented yet"),
        )),
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
