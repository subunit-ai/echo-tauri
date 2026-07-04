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
                let jwt_name = name_from_jwt(&access);

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
                    // Seed the display name from the account ONLY if the user hasn't
                    // set one — their own entry always wins and is never clobbered.
                    if c.display_name.trim().is_empty() {
                        if let Some(n) = jwt_name {
                            c.display_name = n;
                        }
                    }
                    let _ = c.save();
                }

                // Fresh tokens in hand → the session is healthy; drop any re-login
                // banner. (ensure_fresh won't do this for us: a brand-new token isn't
                // "near expiry", so refresh_plan's ensure_fresh is a no-op here.)
                set_session_expired(app, false);

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

/// Flip the app-wide "session expired" flag and, on an actual change, emit
/// `echo://session-expired` / `echo://session-restored` so the banner + Account tab
/// react live (no need to wait for the next dictate to discover a dead session).
/// Idempotent: a no-change call emits nothing.
pub fn set_session_expired(app: &AppHandle, expired: bool) {
    use std::sync::atomic::Ordering;
    use tauri::Emitter;
    let was = app
        .state::<AppState>()
        .session_expired
        .swap(expired, Ordering::Relaxed);
    if was != expired {
        let evt = if expired {
            "echo://session-expired"
        } else {
            "echo://session-restored"
        };
        let _ = app.emit(evt, ());
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
            drop(c);
            // The session is healthy again — clear any pending re-login banner.
            set_session_expired(app, false);
        }
        Err(RefreshFail::TokenDead) => {
            log::warn!("refresh token rejected by server (4xx) — clearing it; re-login required");
            // The token is permanently invalid (revoked/rotated/reuse). Drop BOTH
            // tokens: keeping the dead refresh token makes ensure_fresh retry it on
            // every call, and each retry past the server grace window triggers a
            // reuse-kill of all the user's sessions (the 90+/day logout loop Erik
            // hit running Echo + Sonar on one tablet). X-API-Key fallback in cloud.rs
            // still applies until the user logs in again.
            let st = app.state::<AppState>();
            let mut c = st.config.lock();
            c.subunit_access_token.clear();
            c.subunit_refresh_token.clear();
            c.subunit_token_issued_at = 0.0;
            c.subunit_token_expires_in = 0;
            let _ = c.save();
            drop(c);
            // Make the dead session VISIBLE: raise the re-login banner instead of
            // letting the next dictate fail with a transient-looking 401 toast.
            set_session_expired(app, true);
        }
        Err(RefreshFail::Transient(e)) => {
            log::warn!("token refresh failed (transient): {e}");
            // Network/5xx/429 — the token may still be valid. Drop only the access
            // token (X-API-Key fallback in cloud.rs applies); KEEP the refresh token
            // so a later cycle can retry.
            let st = app.state::<AppState>();
            let mut c = st.config.lock();
            c.subunit_access_token.clear();
            c.subunit_token_issued_at = 0.0;
            c.subunit_token_expires_in = 0;
            let _ = c.save();
        }
    }
}

/// Why a refresh failed — decides whether the refresh token is kept or dropped.
enum RefreshFail {
    /// Server rejected the token (HTTP 4xx except 429): revoked/rotated/reuse — it
    /// will never work again. Drop it so we stop hammering /refresh, which past the
    /// server's grace window triggers a reuse-kill of every session. Re-login needed.
    TokenDead,
    /// Transient (network, timeout, 5xx, 429). Keep the token and retry later.
    Transient(String),
}

fn do_refresh(refresh_token: &str) -> Result<(String, String, i32), RefreshFail> {
    let resp = crate::http::client()
        .post(format!("{AUTH_BASE}/refresh"))
        .timeout(Duration::from_secs(20))
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .map_err(|e| RefreshFail::Transient(e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        // 4xx (except 429 rate-limit) = the token itself is rejected → dead.
        if status.is_client_error() && status.as_u16() != 429 {
            return Err(RefreshFail::TokenDead);
        }
        return Err(RefreshFail::Transient(format!("refresh {status}")));
    }
    let j: serde_json::Value = resp
        .json()
        .map_err(|e| RefreshFail::Transient(e.to_string()))?;
    let access = j
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if access.is_empty() {
        return Err(RefreshFail::Transient(
            "refresh returned no access token".into(),
        ));
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

/// Best-effort human name from the JWT for seeding the display name. Tries the
/// common OIDC name claims in order; returns None if none carry a usable value
/// (many of our tokens only have `email`/`sub`, in which case the user just
/// types their name in Settings). Trimmed; empty strings are treated as absent.
fn name_from_jwt(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let j: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    for key in ["name", "given_name", "preferred_username", "nickname"] {
        if let Some(s) = j.get(key).and_then(|v| v.as_str()) {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}
