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
            // Downsample >16 kHz captures before upload. Whisper computes its
            // mel features from 16 kHz audio anyway, so this is quality-neutral
            // — and it cuts the upload ~3× for the typical 48 kHz mic, which is
            // the dominant transcribe latency on ordinary uplinks.
            let (samples, sample_rate) = if sample_rate > 16_000 {
                (
                    std::borrow::Cow::Owned(resample_to_16k(samples, sample_rate)),
                    16_000,
                )
            } else {
                (std::borrow::Cow::Borrowed(samples), sample_rate)
            };
            let wav = samples_to_wav(&samples, sample_rate)
                .map_err(|e| EngineError::new("internal", e.to_string()))?;
            cloud::transcribe_subunit(cfg, wav, cfg.cloud_superfast, want_segments)
        }
        other => Err(EngineError::new(
            "unsupported",
            format!("mode `{other}` not implemented yet"),
        )),
    }
}

/// Resample mono f32 to 16 kHz (whisper's native rate).
///
/// Downsampling uses a Hann-windowed-sinc low-pass (cutoff just under the
/// 8 kHz output Nyquist) so nothing above 8 kHz aliases into the speech band —
/// audibly/spectrally equivalent to what the server's decoder would do, unlike
/// naive linear decimation. Upsampling (sub-16 kHz devices, rare) stays linear:
/// it creates no aliasing and matches the previous behaviour.
pub fn resample_to_16k(input: &[f32], sr: u32) -> Vec<f32> {
    const TARGET: f64 = 16_000.0;
    if sr == 16_000 || input.is_empty() {
        return input.to_vec();
    }
    if sr < 16_000 {
        // Linear upsample.
        let ratio = TARGET / sr as f64;
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
        return out;
    }

    // Windowed-sinc decimation. `step` input samples per output sample;
    // 8 sinc lobes per side at the (scaled) cutoff keep the filter sharp
    // enough while staying ~50–100 taps — negligible CPU next to the upload.
    let step = sr as f64 / TARGET;
    let cutoff = 0.46 / step; // cycles per input sample, just under out-Nyquist
    let half = (8.0 * step).ceil() as isize;
    let out_len = (input.len() as f64 / step).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for n in 0..out_len {
        let center = n as f64 * step;
        let i0 = center.floor() as isize;
        let (mut acc, mut norm) = (0f64, 0f64);
        for i in (i0 - half)..=(i0 + half + 1) {
            let d = i as f64 - center;
            // sinc(2·fc·d), Hann-windowed over the tap span.
            let x = 2.0 * cutoff * d;
            let sinc = if x.abs() < 1e-9 {
                1.0
            } else {
                (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
            };
            let w = 0.5 + 0.5 * (std::f64::consts::PI * d / (half as f64 + 1.0)).cos();
            let c = sinc * w;
            norm += c;
            if i >= 0 {
                if let Some(&s) = input.get(i as usize) {
                    acc += s as f64 * c;
                }
            }
        }
        out.push(if norm.abs() > 1e-12 { (acc / norm) as f32 } else { 0.0 });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 440 Hz tone at 48 kHz must come out of the decimator as the same tone
    /// at 16 kHz (1/3 the samples, amplitude preserved), while a 10 kHz tone —
    /// above the 8 kHz output Nyquist — must be attenuated to near silence
    /// instead of aliasing into the speech band.
    #[test]
    fn resample_48k_preserves_band_kills_alias() {
        let sr = 48_000u32;
        let n = sr as usize; // 1 s
        let tone =
            |f: f32| -> Vec<f32> { (0..n).map(|i| (i as f32 * f * std::f32::consts::TAU / sr as f32).sin() * 0.5).collect() };
        let rms = |v: &[f32]| (v.iter().map(|s| s * s).sum::<f32>() / v.len() as f32).sqrt();

        let in_band = resample_to_16k(&tone(440.0), sr);
        assert!((in_band.len() as i64 - 16_000).abs() <= 2, "len {}", in_band.len());
        let r = rms(&in_band);
        assert!((r - 0.3535).abs() < 0.02, "in-band rms {r} (want ~0.354)");

        let above_nyquist = resample_to_16k(&tone(10_000.0), sr);
        let r = rms(&above_nyquist);
        assert!(r < 0.02, "10 kHz tone must be filtered out, rms {r}");
    }

    #[test]
    fn resample_16k_is_identity() {
        let v = vec![0.1f32, -0.2, 0.3];
        assert_eq!(resample_to_16k(&v, 16_000), v);
        assert!(resample_to_16k(&[], 48_000).is_empty());
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
