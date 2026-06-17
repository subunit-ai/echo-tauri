//! Auto-vocab spelling guess via the subscription cleanup backend.
//!
//! Given a cluster of misheard variants of ONE spoken word, the server (Sonnet
//! over the Abo path — no metered API) guesses the correct spelling AND how
//! confident it is. High confidence → the hybrid flow silently adds it; low (or
//! any failure here) → we fall back to ASKING the user. Best-effort throughout:
//! a missing/old server endpoint just yields `None` (→ ask), never a wrong auto-add.

use std::time::Duration;

use crate::config::Config;

pub struct Suggestion {
    pub spelling: String,
    /// 0..1 — the server's confidence it knows the correct spelling. Unknown
    /// personal names come back LOW on purpose (no machine can know them → ask).
    pub confidence: f64,
}

/// Ask the backend to guess the correct spelling for `variants`. `None` on any
/// failure → caller asks the user instead of auto-adding.
pub fn suggest(cfg: &Config, variants: &[String]) -> Option<Suggestion> {
    if variants.is_empty() || cfg.mode != "subunit" {
        return None;
    }
    let url = cfg
        .subunit_endpoint
        .replace("/v1/transcribe", "/v1/vocab-suggest");
    let mut req = crate::http::client()
        .post(&url)
        .timeout(Duration::from_secs(30))
        .json(&serde_json::json!({ "variants": variants, "language": cfg.language }));
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else if !cfg.subunit_api_key.is_empty() {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    }
    let resp = req.send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let j: serde_json::Value = resp.json().ok()?;
    let spelling = j.get("spelling")?.as_str()?.trim().to_string();
    if spelling.is_empty() {
        return None;
    }
    let confidence = j.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0);
    Some(Suggestion {
        spelling,
        confidence: confidence.clamp(0.0, 1.0),
    })
}
