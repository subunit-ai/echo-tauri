//! Local whisper model management: list / download (with progress) / delete.
//! Independent of the whisper-rs feature — it's just file downloads from the
//! ggerganov/whisper.cpp Hugging Face repo. The transcriber uses `ensure_blocking`.

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// (key, ggml filename, label). Ordered small → large.
pub const MODELS: &[(&str, &str, &str)] = &[
    ("tiny", "ggml-tiny.bin", "Tiny · ~78 MB · sehr schnell"),
    ("base", "ggml-base.bin", "Base · ~150 MB · schnell"),
    ("small", "ggml-small.bin", "Small · ~500 MB"),
    ("medium", "ggml-medium.bin", "Medium · ~1,5 GB"),
    ("large-v3-turbo", "ggml-large-v3-turbo.bin", "Large v3 Turbo · ~1,6 GB · beste Balance"),
    ("large-v3", "ggml-large-v3.bin", "Large v3 · ~3 GB · höchste Qualität"),
];

#[derive(Serialize)]
pub struct ModelInfo {
    pub key: String,
    pub label: String,
    pub downloaded: bool,
    pub size_mb: u64,
}

pub fn models_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("echo")
        .join("models")
}

fn filename(model: &str) -> &'static str {
    MODELS
        .iter()
        .find(|m| m.0 == model)
        .map(|m| m.1)
        .unwrap_or("ggml-base.bin")
}

pub fn model_path(model: &str) -> PathBuf {
    models_dir().join(filename(model))
}

pub fn list_models() -> Vec<ModelInfo> {
    MODELS
        .iter()
        .map(|(k, f, l)| {
            let p = models_dir().join(f);
            let (downloaded, size_mb) = fs::metadata(&p)
                .map(|m| (m.len() > 1_000_000, m.len() / 1_048_576))
                .unwrap_or((false, 0));
            ModelInfo {
                key: k.to_string(),
                label: l.to_string(),
                downloaded,
                size_mb,
            }
        })
        .collect()
}

pub fn delete(model: &str) -> anyhow::Result<()> {
    let p = model_path(model);
    if p.exists() {
        fs::remove_file(p)?;
    }
    Ok(())
}

/// Download if missing, no progress (used on-demand by the transcriber).
#[cfg_attr(not(feature = "local-whisper"), allow(dead_code))]
pub fn ensure_blocking(model: &str) -> anyhow::Result<PathBuf> {
    fetch(model, None)
}

/// Download with progress events (`echo://model-progress`) for the UI.
pub async fn download(app: &AppHandle, model: &str) -> anyhow::Result<()> {
    fetch_async(model, Some(app)).await.map(|_| ())
}

async fn fetch_async(model: &str, app: Option<&AppHandle>) -> anyhow::Result<PathBuf> {
    let file = filename(model);
    let dir = models_dir();
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(file);
    if path.exists() && tokio::fs::metadata(&path).await.map(|m| m.len() > 1_000_000).unwrap_or(false) {
        return Ok(path);
    }
    let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{file}");
    let tmp = path.with_extension("part");
    let _ = tokio::fs::remove_file(&tmp).await;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3600))
        .build()?;
    let mut resp = client.get(&url).header("User-Agent", "Echo/0.1").send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("download {}", resp.status());
    }
    let total = resp.content_length().unwrap_or(0);
    let mut f = tokio::fs::File::create(&tmp).await?;
    let mut received: u64 = 0;
    let mut last = Instant::now();

    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = resp.chunk().await? {
        f.write_all(&chunk).await?;
        received += chunk.len() as u64;
        if let Some(a) = app {
            if last.elapsed().as_millis() > 200 {
                let _ = a.emit(
                    "echo://model-progress",
                    serde_json::json!({"model": model, "received": received, "total": total}),
                );
                last = Instant::now();
            }
        }
    }
    f.flush().await?;
    let tmp_verify = tmp.clone();
    tokio::task::spawn_blocking(move || verify(&tmp_verify)).await??;
    tokio::fs::rename(&tmp, &path).await?;
    if let Some(a) = app {
        let _ = a.emit(
            "echo://model-progress",
            serde_json::json!({"model": model, "received": received, "total": total, "done": true}),
        );
    }
    Ok(path)
}

fn fetch(model: &str, app: Option<&AppHandle>) -> anyhow::Result<PathBuf> {
    let file = filename(model);
    let dir = models_dir();
    fs::create_dir_all(&dir)?;
    let path = dir.join(file);
    if path.exists() && fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        return Ok(path);
    }
    let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{file}");
    let tmp = path.with_extension("part");
    let _ = fs::remove_file(&tmp);

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3600))
        .build()?;
    let mut resp = client.get(&url).header("User-Agent", "Echo/0.1").send()?;
    if !resp.status().is_success() {
        anyhow::bail!("download {}", resp.status());
    }
    let total = resp.content_length().unwrap_or(0);
    let mut f = fs::File::create(&tmp)?;
    let mut received: u64 = 0;
    let mut buf = [0u8; 65536];
    let mut last = Instant::now();
    loop {
        let n = resp.read(&mut buf)?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n])?;
        received += n as u64;
        if let Some(a) = app {
            if last.elapsed().as_millis() > 200 {
                let _ = a.emit(
                    "echo://model-progress",
                    serde_json::json!({"model": model, "received": received, "total": total}),
                );
                last = Instant::now();
            }
        }
    }
    f.flush()?;
    verify(&tmp)?;
    fs::rename(&tmp, &path)?;
    if let Some(a) = app {
        let _ = a.emit(
            "echo://model-progress",
            serde_json::json!({"model": model, "received": received, "total": total, "done": true}),
        );
    }
    Ok(path)
}

fn verify(path: &PathBuf) -> anyhow::Result<()> {
    let len = fs::metadata(path)?.len();
    if len < 1_000_000 {
        anyhow::bail!("download too small ({len} bytes) — likely failed");
    }
    let mut head = [0u8; 24];
    let n = fs::File::open(path)?.read(&mut head)?;
    let head = &head[..n];
    if head.first() == Some(&b'<') || head.starts_with(b"version https://") {
        anyhow::bail!("download returned text/HTML, not a model file");
    }
    Ok(())
}
