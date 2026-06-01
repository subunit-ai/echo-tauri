//! meet.subunit.ai integration. "Start Meeting" allocates an account-bound
//! meeting via POST /v1/meetings (same auth as transcribe) and opens it in the
//! browser. Full desktop-host audio streaming (WS) is a follow-up.

use std::time::Duration;

use serde::Serialize;

use crate::config::Config;

#[derive(Debug, Clone, Serialize)]
pub struct MeetingInfo {
    pub code: String,
    pub share_url: String,
    pub host_token: String,
}

pub fn create_meeting(cfg: &Config) -> anyhow::Result<MeetingInfo> {
    if cfg.subunit_access_token.is_empty() && cfg.subunit_api_key.is_empty() {
        anyhow::bail!("nicht angemeldet — Meetings brauchen Subunit-Login");
    }
    let url = cfg.subunit_endpoint.replace("/v1/transcribe", "/v1/meetings");
    let host_name = if cfg.account_email.is_empty() {
        "Echo Desktop".to_string()
    } else {
        cfg.account_email.clone()
    };
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let mut req = client.post(&url).json(&serde_json::json!({
        "host_name": host_name,
        "mode": "dsgvo",
    }));
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    }
    let resp = req.send()?;
    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 402 {
        anyhow::bail!("Login/Abo nötig (HTTP {status})");
    }
    if !status.is_success() {
        anyhow::bail!("Server {status}");
    }
    let j: serde_json::Value = resp.json()?;
    let code = j.get("code").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if code.is_empty() {
        anyhow::bail!("keine Meeting-ID erhalten");
    }
    let share_url = j
        .get("share_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("https://meet.subunit.ai/{code}"));
    let host_token = j.get("host_token").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    Ok(MeetingInfo {
        code,
        share_url,
        host_token,
    })
}

pub fn open_url(url: &str) {
    // Use the opener plugin (already a dependency) instead of a per-OS shell-out.
    // The old Windows `cmd /C start "" <url>` let cmd metacharacters in the URL
    // (e.g. a server-provided meeting share_url) inject commands; the plugin opens
    // via the OS handler with no shell. Consistent with auth::open_browser.
    if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
        log::warn!("open_url failed: {e}");
    }
}
