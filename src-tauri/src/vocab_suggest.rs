//! Auto-vocab AI GATEKEEPER via the subscription cleanup backend.
//!
//! The local detector (`autovocab.rs`) only NOMINATES candidates from history.
//! The real decision is made here: a single batched call to the server (Sonnet
//! over the Abo path — no metered API) judges, per candidate WITH its sentence
//! context, whether it's a genuine vocab-worthy term (a name / brand / product /
//! tech word the STT plausibly garbles) or just an ordinary word / inflection —
//! and, for real terms, the correct spelling + how sure it is. The model — not
//! word frequency — is what keeps ordinary words from ever being suggested.
//!
//! Best-effort throughout: a missing/old endpoint or any failure yields an empty
//! result, so the caller leaves candidates pending (asks the user) rather than
//! auto-adding on a guess.

use std::time::Duration;

use crate::autovocab::Candidate;
use crate::config::Config;

/// One per-candidate verdict from the gatekeeper.
pub struct Decision {
    /// Candidate key it ruled on (matches `Candidate::key`).
    pub key: String,
    /// Is this a real vocab-worthy term at all? `false` → ordinary word, drop it.
    pub is_term: bool,
    /// Correct spelling for a real term (empty if it couldn't decide one).
    pub spelling: String,
    /// 0..1 — confidence the spelling is THE correct one. Unknown personal names
    /// come back LOW on purpose (no machine can know them → ask the user).
    pub confidence: f64,
}

/// Ask the AI gatekeeper to judge a BATCH of candidates in one call. Returns one
/// `Decision` per key the server ruled on (possibly fewer, or none). An empty
/// vec on ANY failure → the caller keeps the candidates pending; we never
/// auto-add without a real verdict.
pub fn curate(cfg: &Config, candidates: &[Candidate]) -> Vec<Decision> {
    if candidates.is_empty() || cfg.mode != "subunit" {
        return Vec::new();
    }
    let url = cfg
        .subunit_endpoint
        .replace("/v1/transcribe", "/v1/vocab-curate");

    let items: Vec<serde_json::Value> = candidates
        .iter()
        .map(|c| {
            let variants: Vec<&str> = c.variants.iter().map(|(v, _)| v.as_str()).collect();
            serde_json::json!({
                "key": c.key,
                "variants": variants,
                "context": c.context,
            })
        })
        .collect();

    let mut req = crate::http::client()
        .post(&url)
        .timeout(Duration::from_secs(60))
        .json(&serde_json::json!({ "items": items, "language": cfg.language }));
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else if !cfg.subunit_api_key.is_empty() {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    }

    let Some(resp) = req.send().ok() else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(j) = resp.json::<serde_json::Value>() else {
        return Vec::new();
    };
    let Some(arr) = j.get("decisions").and_then(|v| v.as_array()) else {
        return Vec::new();
    };

    arr.iter()
        .filter_map(|d| {
            let key = d.get("key")?.as_str()?.trim().to_string();
            if key.is_empty() {
                return None;
            }
            let is_term = d.get("is_term").and_then(|v| v.as_bool()).unwrap_or(false);
            let spelling = d
                .get("spelling")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let confidence = d
                .get("confidence")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
                .clamp(0.0, 1.0);
            Some(Decision {
                key,
                is_term,
                spelling,
                confidence,
            })
        })
        .collect()
}
