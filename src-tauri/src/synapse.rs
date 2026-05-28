//! Synapse knowledge-base save — best-effort POST of the final transcript to
//! `/v1/synapse/save` (port of main.py `_save_to_synapse`). Never blocks the
//! paste flow; errors are logged and swallowed.

use std::time::Duration;

use crate::config::Config;

/// Fire-and-forget save when `synapse_save_enabled`. Call on a detached thread
/// so the (up to 5s) round-trip never delays the user's "Done".
pub fn maybe_save(cfg: &Config, text: &str, window_title: &str) {
    if !cfg.synapse_save_enabled || text.trim().is_empty() {
        return;
    }
    if let Err(e) = save(cfg, text, window_title) {
        log::warn!("synapse save failed (ignored): {e}");
    }
}

fn save(cfg: &Config, text: &str, window_title: &str) -> anyhow::Result<()> {
    // Full "/v1/transcribe" segment (the bare host also contains "transcribe").
    let url = cfg
        .subunit_endpoint
        .replace("/v1/transcribe", "/v1/synapse/save");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let title: String = window_title.chars().take(200).collect();

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    let mut req = client.post(&url).json(&serde_json::json!({
        "text": text,
        "window_title": title,
        "cleanup_style": cfg.cleanup_style,
        "language": cfg.language,
        "transcribed_at": now,
    }));
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else if !cfg.subunit_api_key.is_empty() {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    }
    let resp = req.send()?;
    if !resp.status().is_success() {
        anyhow::bail!("synapse save {}", resp.status());
    }
    Ok(())
}
