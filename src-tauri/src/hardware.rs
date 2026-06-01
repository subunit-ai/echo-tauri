//! Best-effort hardware probe → recommended local Whisper model (port of the
//! relevant bits of hardware.py). Never fails; returns sensible defaults.
//!
//! GPU signal: rather than a flaky cross-platform GPU probe we key off the
//! build feature — `local-whisper-gpu` ships the Vulkan backend, so on such a
//! build we assume usable acceleration and recommend the best-balance model.
//! CPU-only builds recommend by RAM.

use serde::Serialize;
use sysinfo::System;

#[derive(Debug, Clone, Serialize)]
pub struct HardwareInfo {
    /// One-line human summary, e.g. "8 Kerne · 16 GB RAM · GPU-Build".
    pub summary: String,
    /// Recommended local model key (matches models::MODELS).
    pub recommended_model: String,
    pub ram_gb: f64,
    pub cpu_cores: usize,
    pub gpu_build: bool,
}

pub fn detect() -> HardwareInfo {
    let mut sys = System::new();
    sys.refresh_memory();
    let ram_gb = sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    let cpu_cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let gpu_build = cfg!(feature = "local-whisper-gpu");

    // GPU build → best balance; else size the model to available RAM.
    let recommended_model = if gpu_build {
        "large-v3-turbo"
    } else if ram_gb >= 16.0 {
        "small"
    } else if ram_gb >= 8.0 {
        "base"
    } else {
        "tiny"
    }
    .to_string();

    let mut parts = vec![format!("{cpu_cores} Kerne")];
    if ram_gb > 0.0 {
        parts.push(format!("{ram_gb:.0} GB RAM"));
    }
    parts.push(if gpu_build {
        "GPU-Build".into()
    } else {
        "nur CPU".into()
    });

    HardwareInfo {
        summary: parts.join(" · "),
        recommended_model,
        ram_gb: (ram_gb * 10.0).round() / 10.0,
        cpu_cores,
        gpu_build,
    }
}
