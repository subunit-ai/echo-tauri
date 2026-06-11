//! Subunit account auth — OAuth browser flow via a 127.0.0.1 loopback callback,
//! plus JIT token refresh. Mirrors `subunit_auth.py`.
//!
//! Flow: bind an ephemeral localhost port → open browser to
//! `auth.subunit.ai/sonar-login?state=<csrf>&port=<port>` → the auth server
//! redirects to `http://127.0.0.1:<port>/callback?state&access_token&...` →
//! verify `state`, store tokens, tell the user to close the tab.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use rand::{distributions::Alphanumeric, Rng};
use tauri::{AppHandle, Manager};

use crate::commands::AppState;

const AUTH_BASE: &str = "https://auth.subunit.ai";
// 30 min — matches the Python flow; tolerates slow email-code delivery.
const LOGIN_TIMEOUT_SECS: u64 = 1800;

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn random_state() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

fn open_browser(url: &str) {
    if let Err(e) = tauri_plugin_opener::open_url(url.to_string(), None::<&str>) {
        log::warn!("failed to open browser: {}", e);
    }
}

/// Blocking: opens the browser and waits for the loopback callback. Returns the
/// account email (from the JWT) or "Angemeldet".
pub fn login(app: &AppHandle) -> anyhow::Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let state = random_state();
    let url = format!("{AUTH_BASE}/sonar-login?state={state}&port={port}");
    open_browser(&url);

    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + Duration::from_secs(LOGIN_TIMEOUT_SECS);

    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                // Blocking + bounded read so a silent local client can't wedge login.
                stream.set_nonblocking(false).ok();
                let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                let reqline = read_request_line(&stream).unwrap_or_default();
                let path = reqline.split_whitespace().nth(1).unwrap_or("").to_string();
                let route = path.splitn(2, '?').next().unwrap_or("");

                // Exact route only; keep serving until a VALID callback or deadline
                // (stray/forged requests are answered and ignored, not fatal).
                if route != "/callback" {
                    let _ = write_html(&mut stream, "Echo", "Warte auf Login…");
                    continue;
                }
                let qs = path.splitn(2, '?').nth(1).unwrap_or("");
                let params = query_params(qs);
                if params.get("state").map(String::as_str) != Some(state.as_str()) {
                    let _ = write_html(&mut stream, "Echo", "Warte auf Login…");
                    continue; // CSRF / stale tab — ignore, keep waiting
                }
                let access = params.get("access_token").cloned().unwrap_or_default();
                if access.is_empty() {
                    let _ = write_html(&mut stream, "Echo", "Warte auf Login…");
                    continue;
                }
                let refresh = params.get("refresh_token").cloned().unwrap_or_default();
                let expires: i32 = params
                    .get("expires_in")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                let workspace = params.get("workspace_id").cloned().unwrap_or_default();
                let email = email_from_jwt(&access).unwrap_or_default();

                {
                    let st = app.state::<AppState>();
                    let mut c = st.config.lock();
                    c.subunit_access_token = access;
                    c.subunit_refresh_token = refresh;
                    c.subunit_token_expires_in = expires;
                    c.subunit_token_issued_at = now_secs();
                    c.subunit_workspace_id = workspace;
                    if !email.is_empty() {
                        c.account_email = email.clone();
                    }
                    let _ = c.save();
                }

                // Pull the real workspace tier → config.plan so the UI doesn't keep
                // showing "free" after a successful sign-in.
                refresh_plan(app);

                let _ = write_html(
                    &mut stream,
                    "Echo — angemeldet ✓",
                    "Du kannst dieses Fenster schließen.",
                );
                return Ok(if email.is_empty() {
                    "Angemeldet".to_string()
                } else {
                    email
                });
            }
            Err(ref e) if e.kind() == ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    anyhow::bail!("login timed out");
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// Serializes token refreshes process-wide. Two callers (e.g. a transcribe and a
/// meeting re-process firing together) would otherwise both POST /refresh with the
/// same rotating refresh token; the second request then carries an already-rotated
/// (invalid) token and logs the user out. Single-flight + a double-check inside the
/// lock means only the first does the work and the rest see the fresh token.
static REFRESH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Does the cloud access token need refreshing right now? (false = either still
/// valid, or there's no refresh token to use).
fn needs_refresh(app: &AppHandle) -> bool {
    let st = app.state::<AppState>();
    let c = st.config.lock();
    if c.subunit_refresh_token.is_empty() {
        return false;
    }
    let now = now_secs();
    // Still valid with a 60s safety margin?
    !(c.subunit_token_issued_at > 0.0
        && c.subunit_token_expires_in > 0
        && (now - c.subunit_token_issued_at) < (c.subunit_token_expires_in as f64 - 60.0))
}

/// Refresh the access token if it's expired (or about to be). Best-effort.
pub fn ensure_fresh(app: &AppHandle) {
    // Fast path without the lock — the common case is a still-valid token.
    if !needs_refresh(app) {
        return;
    }
    // Serialize: only one refresh in flight. (Poison can't corrupt a `()` guard.)
    let _guard = REFRESH_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    // Re-check: another thread may have refreshed while we waited for the lock.
    if !needs_refresh(app) {
        return;
    }
    let refresh = {
        let st = app.state::<AppState>();
        let c = st.config.lock();
        c.subunit_refresh_token.clone()
    };
    if refresh.is_empty() {
        return;
    }
    let now = now_secs();
    match do_refresh(&refresh) {
        Ok((access, new_refresh, exp)) => {
            let st = app.state::<AppState>();
            let mut c = st.config.lock();
            c.subunit_access_token = access;
            if !new_refresh.is_empty() {
                c.subunit_refresh_token = new_refresh;
            }
            c.subunit_token_expires_in = exp;
            c.subunit_token_issued_at = now;
            let _ = c.save();
        }
        Err(e) => {
            log::warn!("token refresh failed: {e}");
            // The access token is expired (that's why we refreshed) and refresh
            // failed → drop it so the X-API-Key fallback in cloud.rs can apply.
            // Keep the refresh token for a later retry.
            let st = app.state::<AppState>();
            let mut c = st.config.lock();
            c.subunit_access_token.clear();
            c.subunit_token_issued_at = 0.0;
            c.subunit_token_expires_in = 0;
            let _ = c.save();
        }
    }
}

fn do_refresh(refresh_token: &str) -> anyhow::Result<(String, String, i32)> {
    let resp = crate::http::client()
        .post(format!("{AUTH_BASE}/refresh"))
        .timeout(Duration::from_secs(20))
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()?;
    if !resp.status().is_success() {
        anyhow::bail!("refresh {}", resp.status());
    }
    let j: serde_json::Value = resp.json()?;
    let access = j
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if access.is_empty() {
        anyhow::bail!("refresh returned no access token");
    }
    Ok((
        access,
        j.get("refresh_token").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        j.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
    ))
}

/// Fetch the ACTIVE workspace tier from auth.subunit.ai and store it as
/// `config.plan` so the UI shows the real plan (free/basic/pro/enterprise/pilot/ops)
/// instead of the local default — Echo previously never queried it, so the account
/// always read "free" no matter the tier. Best-effort (refreshes the token first).
/// NOTE: this mirrors exactly what the transcribe server gates on — the *active*
/// workspace (JWT `ws` claim, else the personal workspace). A team member whose
/// token has no `ws` claim sees their personal workspace's tier here.
pub fn refresh_plan(app: &AppHandle) {
    ensure_fresh(app);
    let token = {
        let st = app.state::<AppState>();
        let c = st.config.lock();
        c.subunit_access_token.clone()
    };
    if token.is_empty() {
        return;
    }
    let tier = match fetch_active_tier(&token) {
        Ok(t) if !t.is_empty() => t,
        Ok(_) => return,
        Err(e) => {
            log::debug!("plan fetch: {e}");
            return;
        }
    };
    let changed = {
        let st = app.state::<AppState>();
        let mut c = st.config.lock();
        if c.plan != tier {
            c.plan = tier;
            let _ = c.save();
            true
        } else {
            false
        }
    };
    if changed {
        use tauri::Emitter;
        // Nudge the main window to reload so the Account tab shows the new plan.
        let _ = app.emit("echo://config-changed", ());
    }
}

fn fetch_active_tier(token: &str) -> anyhow::Result<String> {
    let resp = crate::http::client()
        .get(format!("{AUTH_BASE}/me/workspace/active"))
        .timeout(Duration::from_secs(15))
        .bearer_auth(token)
        .send()?;
    if !resp.status().is_success() {
        anyhow::bail!("active workspace {}", resp.status());
    }
    let j: serde_json::Value = resp.json()?;
    Ok(j.get("workspace")
        .and_then(|w| w.get("tier"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string())
}

fn read_request_line(stream: &TcpStream) -> anyhow::Result<String> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    Ok(line)
}

fn escape_html(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '&' => escaped.push_str("&amp;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(c),
        }
    }
    escaped
}

fn write_html(stream: &mut TcpStream, title: &str, msg: &str) -> std::io::Result<()> {
    let title = escape_html(title);
    let msg = escape_html(msg);
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"></head>\
<body style=\"font-family:-apple-system,system-ui,sans-serif;background:#0f172a;color:#e2e8f0;text-align:center;padding-top:90px\">\
<h2 style=\"color:#22d3ee\">{title}</h2><p>{msg}</p></body></html>"
    );
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes())
}

fn query_params(qs: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in qs.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = it.next().unwrap_or("");
        map.insert(percent_decode(k), percent_decode(v));
    }
    map
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn email_from_jwt(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let j: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    j.get("email")
        .and_then(|v| v.as_str())
        .or_else(|| j.get("sub").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
}
