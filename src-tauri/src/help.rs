//! "Echo fragen" — the in-app help assistant.
//!
//! A thin, grounded LLM proxy: the React Help section ships Echo's curated FAQ
//! (the single source of truth lives in `src/lib/faq.ts`) as the `knowledge`
//! string, the server answers the user's free-form `question` STRICTLY from that
//! knowledge over the subscription cleanup path (`claude -p` — no metered API),
//! and refuses/defers to support when something isn't covered. Grounding the
//! model on our own FAQ is what keeps it from hallucinating Echo behaviour.
//!
//! Best-effort like the rest of the cloud path: any failure surfaces as a clear
//! Err to the UI, which shows a "couldn't reach the assistant" message — it never
//! panics and never blocks the rest of the Help section (the FAQ stays usable).

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::commands::AppState;
use crate::config::Config;

fn ask(cfg: &Config, question: &str, knowledge: &str, language: &str) -> anyhow::Result<String> {
    if cfg.mode != "subunit" {
        anyhow::bail!("offline");
    }
    // Same endpoint-derivation idiom as cleanup.rs / vocab_suggest.rs: replace the
    // full "/v1/transcribe" segment so the host's "transcribe." stays intact.
    let url = cfg
        .subunit_endpoint
        .replace("/v1/transcribe", "/v1/help-ask");
    let mut req = crate::http::client()
        .post(&url)
        // The assistant runs a full LLM turn over the Abo path — give it room
        // (cleanup measures ~5–9 s on Sonnet; a Q&A turn is comparable).
        .timeout(Duration::from_secs(45))
        .json(&serde_json::json!({
            "question": question,
            "knowledge": knowledge,
            "language": language,
        }));
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else if !cfg.subunit_api_key.is_empty() {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    }
    let resp = req.send()?;
    if !resp.status().is_success() {
        anyhow::bail!("help-ask {}", resp.status());
    }
    let j: serde_json::Value = resp.json()?;
    let answer = j
        .get("answer")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if answer.is_empty() {
        anyhow::bail!("empty answer");
    }
    Ok(answer)
}

#[tauri::command]
pub async fn help_ask(
    app: AppHandle,
    question: String,
    knowledge: String,
    language: String,
) -> Result<String, String> {
    if question.trim().is_empty() {
        return Err("empty question".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Refresh the cloud token first, exactly like prompt_cleanup / process_meeting:
        // the Help section can sit open for a long time before the user asks.
        crate::auth::ensure_fresh(&app);
        let cfg = app.state::<AppState>().config.lock().clone();
        ask(&cfg, &question, &knowledge, &language).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("help-ask task: {e}"))?
}
