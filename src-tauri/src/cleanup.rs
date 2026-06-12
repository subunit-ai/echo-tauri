//! AI cleanup client — server-side text polish via `/v1/cleanup` (port of
//! cleanup_client.py). Best-effort: never blocks paste, returns the original
//! text on any error.

use std::time::Duration;

use crate::config::Config;

pub fn maybe_cleanup(cfg: &Config, text: &str, style: &str) -> String {
    if !cfg.cleanup_enabled || text.trim().is_empty() {
        return text.to_string();
    }
    match cleanup(cfg, text, style) {
        Ok(t) if !t.trim().is_empty() => t,
        Ok(_) => text.to_string(),
        Err(e) => {
            log::warn!("cleanup failed (using raw text): {e}");
            text.to_string()
        }
    }
}

/// Run a specific cleanup style on arbitrary text, ignoring `cleanup_enabled`
/// (used by the Meetings re-process / extract actions). Returns the styled text.
pub fn run_style(cfg: &Config, text: &str, style: &str) -> anyhow::Result<String> {
    cleanup(cfg, text, style)
}

fn cleanup(cfg: &Config, text: &str, style: &str) -> anyhow::Result<String> {
    // Derive the cleanup endpoint from the (configurable) transcribe endpoint.
    // Match the FULL "/v1/transcribe" segment — a bare "/transcribe" also occurs
    // in the host (transcribe.subunit.ai) and str::replace would corrupt it.
    let url = cfg.subunit_endpoint.replace("/v1/transcribe", "/v1/cleanup");
    // Shared pooled client — reuses the connection the transcribe call just used.
    let mut req = crate::http::client()
        .post(&url)
        .timeout(Duration::from_secs(30))
        .json(&serde_json::json!({
            "text": text,
            "language": cfg.language,
            "style": style,
        }));
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else if !cfg.subunit_api_key.is_empty() {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    }
    let resp = req.send()?;
    if !resp.status().is_success() {
        anyhow::bail!("cleanup {}", resp.status());
    }
    let j: serde_json::Value = resp.json()?;
    Ok(j.get("text")
        .and_then(|v| v.as_str())
        .unwrap_or(text)
        .to_string())
}
