//! Transcription dispatcher.
//!
//! Cloud (subunit, incl. the Groq-proxied "superfast") is the M1 path and speaks
//! the exact `transcribe.subunit.ai/v1/transcribe` contract. Local (whisper.cpp
//! via whisper-rs) is feature-gated behind `local-whisper`. openai/groq/custom
//! land in a later pass.

mod cloud;
pub mod vocab;

use crate::config::Config;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptResult {
    pub text: String,
    pub quality_mode: String,
}

pub fn run(cfg: &Config, wav: Vec<u8>) -> anyhow::Result<TranscriptResult> {
    match cfg.mode.as_str() {
        // Local whisper.cpp (whisper-rs) lands in the local-STT task, with a
        // verified build + DE benchmark before it's wired in.
        "local" => {
            let _ = wav;
            anyhow::bail!("local engine not yet built (whisper.cpp via whisper-rs) — switch to Cloud for now")
        }
        "subunit" => cloud::transcribe_subunit(cfg, wav, cfg.cloud_superfast),
        other => anyhow::bail!("transcription mode `{other}` not implemented yet"),
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
