//! Subunit cloud transcriber — POST multipart to `/v1/transcribe`.
//!
//! Exact contract (must stay in sync with the FastAPI server):
//!   multipart: file=audio.wav, language, quality_mode, prompt?, provider?
//!   auth:      Authorization: Bearer <jwt>  (primary) | X-API-Key (legacy)
//!   response:  { text, quality_mode, ... }   402 => trial expired

use std::time::Duration;

use reqwest::blocking::multipart;

use super::{vocab, EngineError, TranscriptResult};
use crate::config::Config;

pub fn transcribe_subunit(
    cfg: &Config,
    wav: Vec<u8>,
    superfast: bool,
) -> Result<TranscriptResult, EngineError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| EngineError::new("internal", e.to_string()))?;

    let part = multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| EngineError::new("internal", e.to_string()))?;
    let mut form = multipart::Form::new()
        .part("file", part)
        .text("language", cfg.language.clone())
        .text("quality_mode", cfg.cloud_quality_mode.clone());

    let prompt = vocab::vocab_prompt(cfg);
    if !prompt.is_empty() {
        form = form.text("prompt", prompt);
    }
    if superfast {
        form = form.text("provider", "superfast");
    }

    let mut req = client.post(&cfg.subunit_endpoint).multipart(form);
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else if !cfg.subunit_api_key.is_empty() {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    }

    let resp = req
        .send()
        .map_err(|e| EngineError::new("network", e.to_string()))?;
    let status = resp.status();
    match status.as_u16() {
        402 => return Err(EngineError::new("trial_expired", "Testzeitraum abgelaufen")),
        401 => return Err(EngineError::new("auth", "Nicht angemeldet oder Token abgelaufen")),
        s if !(200..300).contains(&s) => {
            let body = resp.text().unwrap_or_default();
            return Err(EngineError::new("server", format!("Server {s}: {body}")));
        }
        _ => {}
    }

    let json: serde_json::Value = resp
        .json()
        .map_err(|e| EngineError::new("server", e.to_string()))?;
    let text = json
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let quality_mode = json
        .get("quality_mode")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    Ok(TranscriptResult {
        text: vocab::apply_vocab_replace(&text, cfg),
        quality_mode,
    })
}
