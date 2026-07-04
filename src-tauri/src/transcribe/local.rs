//! On-device transcription via whisper.cpp (whisper-rs). Feature-gated behind
//! `local-whisper` (+ `local-whisper-gpu` for the Vulkan backend). Resamples
//! capture audio to 16 kHz mono and caches the loaded context. The model is
//! fetched on-demand via [`crate::models`] (or pre-downloaded from Settings).
//!
//! Native on all archs incl. Windows ARM64 — this is what eliminates the
//! ctranslate2/ONNX split the Python build needed.

use std::sync::Mutex;

use once_cell::sync::Lazy;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::{vocab, Segment, TranscriptResult};
use crate::config::Config;

// Loading a model costs GBs of RAM/VRAM — keep one context, keyed by model name.
static CTX: Lazy<Mutex<Option<(String, WhisperContext)>>> = Lazy::new(|| Mutex::new(None));

pub fn run(
    cfg: &Config,
    samples: &[f32],
    sample_rate: u32,
    want_segments: bool,
) -> anyhow::Result<TranscriptResult> {
    let audio = resample_to_16k(samples, sample_rate);
    let model = cfg.local_model.clone();
    let path = crate::models::ensure_blocking(&model)?;

    let mut guard = CTX.lock().map_err(|_| anyhow::anyhow!("whisper context mutex poisoned"))?;
    let reload = guard.as_ref().map(|(m, _)| m != &model).unwrap_or(true);
    if reload {
        let ctx = WhisperContext::new_with_params(&path, WhisperContextParameters::default())
            .map_err(|e| anyhow::anyhow!("whisper load: {e}"))?;
        *guard = Some((model.clone(), ctx));
    }
    let ctx = &guard.as_ref().ok_or_else(|| anyhow::anyhow!("whisper context not initialized"))?.1;
    let mut state = ctx
        .create_state()
        .map_err(|e| anyhow::anyhow!("whisper state: {e}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    // Anti-hallucination / anti-repetition. The classic whisper.cpp failure mode:
    // at the tail of a clip (trailing silence/noise) it gets stuck repeating the last
    // phrase, then degenerates into multilingual gibberish (Erik hit exactly this).
    // We transcribe ONE complete recording per call, so:
    //  - no_context: do NOT seed the next internal 30 s window with the previously
    //    decoded text — that carry-over feedback loop is the #1 cause of the repeat
    //    spiral. (Independent utterances gain nothing from cross-window context.)
    //  - temperature fallback (inc 0.2): when a window decodes degenerate (trips the
    //    entropy/logprob guards below) whisper RE-decodes it hotter instead of locking
    //    into the loop. With inc=0 there is no fallback and a bad window just repeats.
    //  - no_speech_thold: trailing silence is dropped as no-speech, not hallucinated
    //    into text. suppress_blank/nst kill blank + non-speech ("[Musik]") tokens.
    params.set_no_context(true);
    params.set_temperature(0.0);
    params.set_temperature_inc(0.2);
    params.set_entropy_thold(2.4);
    params.set_logprob_thold(-1.0);
    params.set_no_speech_thold(0.6);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    let lang = if cfg.language == "auto" || cfg.language.is_empty() {
        None
    } else {
        Some(cfg.language.as_str())
    };
    params.set_language(lang);
    let prompt = vocab::vocab_prompt(cfg);
    if !prompt.is_empty() {
        params.set_initial_prompt(&prompt);
    }

    state
        .full(params, &audio)
        .map_err(|e| anyhow::anyhow!("whisper full: {e}"))?;

    let n = state.full_n_segments();
    let mut text = String::new();
    let mut segments = Vec::new();
    for i in 0..n {
        if let Some(seg) = state.get_segment(i) {
            if let Ok(s) = seg.to_str_lossy() {
                text.push_str(&s);
                if want_segments {
                    // whisper-rs timestamps are in centiseconds.
                    segments.push(Segment {
                        start_s: seg.start_timestamp() as f64 / 100.0,
                        end_s: seg.end_timestamp() as f64 / 100.0,
                        text: vocab::apply_vocab_replace(s.trim(), cfg),
                    });
                }
            }
        }
    }

    Ok(TranscriptResult {
        text: vocab::despam_commas(&vocab::apply_vocab_replace(text.trim(), cfg)),
        quality_mode: "local".to_string(),
        segments,
        cleaned_text: None, // local engine has no combined cleanup round trip
        cleanup_status: None, // ditto — no server-side cleanup
        timings: Default::default(), // filled by the dispatcher, which times this call
    })
}

/// Linear-resample mono f32 to 16 kHz (whisper.cpp requires 16 kHz).
fn resample_to_16k(input: &[f32], sr: u32) -> Vec<f32> {
    if sr == 16_000 || input.is_empty() {
        return input.to_vec();
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
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Downloads the tiny model + runs whisper on a synthetic tone. Run with
    /// `--nocapture` and watch for "ggml_vulkan: … using Vulkan0 backend" to
    /// confirm the GPU is used.
    #[test]
    fn gpu_smoke() {
        let mut cfg = Config::default();
        cfg.local_model = "tiny".to_string();
        cfg.language = "en".to_string();
        let sr = 16_000u32;
        let samples: Vec<f32> = (0..sr * 2)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / sr as f32).sin() * 0.1)
            .collect();
        let r = run(&cfg, &samples, sr, true);
        println!("LOCAL_SMOKE ok={} -> {:?}", r.is_ok(), r);
        assert!(r.is_ok(), "local transcribe failed: {:?}", r.err());
    }
}
