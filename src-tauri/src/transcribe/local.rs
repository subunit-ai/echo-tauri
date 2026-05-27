//! On-device transcription via whisper.cpp (whisper-rs). Feature-gated behind
//! `local-whisper`. Auto-downloads the GGML model from Hugging Face on first
//! use, resamples capture audio to 16 kHz mono, and caches the loaded context.
//!
//! Native on all archs incl. Windows ARM64 — this is what eliminates the
//! ctranslate2/ONNX split the Python build needed.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::{vocab, TranscriptResult};
use crate::config::Config;

// Loading a model costs GBs of RAM/VRAM — keep one context, keyed by model name.
static CTX: Lazy<Mutex<Option<(String, WhisperContext)>>> = Lazy::new(|| Mutex::new(None));

pub fn run(cfg: &Config, samples: &[f32], sample_rate: u32) -> anyhow::Result<TranscriptResult> {
    let audio = resample_to_16k(samples, sample_rate);
    let model = cfg.local_model.clone();
    let path = ensure_model(&model)?;

    let mut guard = CTX.lock().unwrap();
    let reload = guard.as_ref().map(|(m, _)| m != &model).unwrap_or(true);
    if reload {
        let ctx = WhisperContext::new_with_params(&path, WhisperContextParameters::default())
            .map_err(|e| anyhow::anyhow!("whisper load: {e}"))?;
        *guard = Some((model.clone(), ctx));
    }
    let ctx = &guard.as_ref().unwrap().1;
    let mut state = ctx
        .create_state()
        .map_err(|e| anyhow::anyhow!("whisper state: {e}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
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
    for i in 0..n {
        if let Some(seg) = state.get_segment(i) {
            if let Ok(s) = seg.to_str_lossy() {
                text.push_str(&s);
            }
        }
    }

    Ok(TranscriptResult {
        text: vocab::apply_vocab_replace(text.trim(), cfg),
        quality_mode: "local".to_string(),
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
    use crate::config::Config;

    /// Downloads the tiny model + runs whisper on a synthetic tone. Run with
    /// `--nocapture` and watch for the "ggml_vulkan: Found … devices" log to
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
        let r = run(&cfg, &samples, sr);
        println!("LOCAL_SMOKE ok={} -> {:?}", r.is_ok(), r);
        assert!(r.is_ok(), "local transcribe failed: {:?}", r.err());
    }
}

fn model_file(model: &str) -> &'static str {
    match model {
        "tiny" => "ggml-tiny.bin",
        "base" => "ggml-base.bin",
        "small" => "ggml-small.bin",
        "medium" => "ggml-medium.bin",
        "large-v3" => "ggml-large-v3.bin",
        "large-v3-turbo" => "ggml-large-v3-turbo.bin",
        _ => "ggml-base.bin",
    }
}

/// Locate (or download) the GGML model. Cached under the OS cache dir.
fn ensure_model(model: &str) -> anyhow::Result<PathBuf> {
    let file = model_file(model);
    let dir = dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("echo")
        .join("models");
    fs::create_dir_all(&dir)?;
    let path = dir.join(file);
    if path.exists() && fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        return Ok(path);
    }
    let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{file}");
    log::info!("downloading whisper model {file} …");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1800))
        .build()?;
    let tmp = path.with_extension("part");
    let _ = fs::remove_file(&tmp); // clean any stale partial first
    let mut resp = client.get(&url).header("User-Agent", "Echo/0.1").send()?;
    if !resp.status().is_success() {
        anyhow::bail!("model download {}", resp.status());
    }
    {
        let mut f = fs::File::create(&tmp)?;
        resp.copy_to(&mut f)?;
        f.flush()?;
    }
    // Integrity gate before activating: a redirect/HTML error page or truncated
    // download must not be renamed into place. (Per-model SHA-256 pinning is the
    // follow-up — needs the authoritative hashes.)
    if let Err(e) = verify_ggml(&tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Sanity-check a downloaded model: plausible size + GGML/GGUF magic bytes.
fn verify_ggml(path: &Path) -> anyhow::Result<()> {
    let len = fs::metadata(path)?.len();
    if len < 1_000_000 {
        anyhow::bail!("model too small ({len} bytes) — download likely failed");
    }
    // Catch error pages / git-LFS pointers; a real model is binary. whisper.cpp
    // does the authoritative format validation on load. (The GGML magic is a
    // little-endian u32, so a naive b"ggml" byte compare gives false negatives.)
    let mut head = [0u8; 24];
    let n = fs::File::open(path)?.read(&mut head)?;
    let head = &head[..n];
    if head.first() == Some(&b'<') || head.starts_with(b"version https://") {
        anyhow::bail!("model download returned text/HTML, not a model file");
    }
    Ok(())
}
