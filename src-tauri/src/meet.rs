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
    // The share_url is later handed to the OS URL opener. Only trust a value the
    // server returns if it is actually an https meet.subunit.ai link; otherwise
    // fall back to the canonical URL we build from the code. This stops a
    // compromised/MITM'd response from steering open_url at an arbitrary scheme
    // or host (defense-in-depth on top of the no-shell opener).
    let canonical = format!("https://meet.subunit.ai/{code}");
    let share_url = j
        .get("share_url")
        .and_then(|v| v.as_str())
        .filter(|s| is_trusted_meet_url(s))
        .map(|s| s.to_string())
        .unwrap_or(canonical);
    let host_token = j.get("host_token").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    Ok(MeetingInfo {
        code,
        share_url,
        host_token,
    })
}

/// True only for `https://meet.subunit.ai` links (exact host, https scheme).
/// Used to vet a server-provided share_url before it reaches the URL opener.
pub fn is_trusted_meet_url(url: &str) -> bool {
    url == "https://meet.subunit.ai"
        || url.starts_with("https://meet.subunit.ai/")
}

/// True for ordinary web links (http/https only). Anything else — file paths,
/// `javascript:`, custom protocol-handler schemes — is rejected so a
/// frontend-supplied URL can't invoke an arbitrary OS handler.
pub fn is_web_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    matches!(
        lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")),
        Some(rest) if !rest.is_empty()
    )
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

#[cfg(test)]
mod tests {
    use super::{is_trusted_meet_url, is_web_url};

    #[test]
    fn trusted_meet_url_accepts_canonical_links() {
        assert!(is_trusted_meet_url("https://meet.subunit.ai"));
        assert!(is_trusted_meet_url("https://meet.subunit.ai/AB12CD"));
    }

    #[test]
    fn trusted_meet_url_rejects_other_hosts_and_schemes() {
        assert!(!is_trusted_meet_url("https://evil.example/AB12CD"));
        assert!(!is_trusted_meet_url("http://meet.subunit.ai/AB12CD")); // not https
        assert!(!is_trusted_meet_url("https://meet.subunit.ai.evil.com/")); // suffix trick
        assert!(!is_trusted_meet_url("file:///etc/passwd"));
        assert!(!is_trusted_meet_url(""));
    }

    #[test]
    fn web_url_accepts_http_and_https() {
        assert!(is_web_url("https://github.com/subunit-ai"));
        assert!(is_web_url("http://example.com"));
        assert!(is_web_url("HTTPS://Example.com")); // scheme is case-insensitive
    }

    #[test]
    fn web_url_rejects_non_web_schemes() {
        assert!(!is_web_url("file:///Users/x/secret"));
        assert!(!is_web_url("javascript:alert(1)"));
        assert!(!is_web_url("smb://server/share"));
        assert!(!is_web_url("https://")); // scheme only, no host
        assert!(!is_web_url("/Users/x/folder")); // bare path (folder-open path)
        assert!(!is_web_url(""));
    }
}
