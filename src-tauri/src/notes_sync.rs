//! Best-effort per-account cloud sync of voice notes against `/v1/notes/sync`.
//!
//! Byte-for-byte compatible with the Echo iOS app: same endpoint, same wire
//! shape (`{notes:[{id,name,payload,updated_at,deleted}]}` with `updated_at` in
//! epoch SECONDS), so a note dictated on the iPhone while walking shows up on the
//! Desktop — and vice-versa. Mirrors [`crate::presets_sync`]: one round-trip
//! pushes the locally-changed notes (incl. tombstones) and pulls back the
//! authoritative set, reconciled into the local store. Never blocks the UI:
//! every call spawns a short-lived thread and swallows errors — local-first
//! means a failed sync just retries on the next change / focus.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::AppState;
use crate::config::Config;

/// Fire a detached, best-effort sync. Safe to call after every note change, on
/// window focus, and at startup / after login. No-op for signed-out accounts.
pub fn kick(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let cfg = { app.state::<AppState>().config.lock().clone() };
        if let Err(e) = sync_blocking(&app, &cfg) {
            log::warn!("notes sync failed (ignored): {e}");
        }
    });
}

fn endpoint_notes(cfg: &Config) -> String {
    cfg.subunit_endpoint
        .replace("/v1/transcribe", "/v1/notes/sync")
}

fn endpoint_folders(cfg: &Config) -> String {
    cfg.subunit_endpoint
        .replace("/v1/transcribe", "/v1/note-folders/sync")
}

fn sync_blocking(app: &AppHandle, cfg: &Config) -> anyhow::Result<()> {
    let account = crate::presets::account_key(cfg);
    // Signed-out: notes stay on the device (and never vanish), nothing to sync.
    if account == "local" {
        return Ok(());
    }
    // Refresh the access token BEFORE using it — at startup the token loaded from
    // disk is usually expired, and without this the first sync 401s and notes
    // never reach the cloud until the token happens to be fresh (same fix as
    // presets_sync). ensure_fresh is a fast no-op when valid + serialized so it
    // can't race the other refreshers. Re-read config to pick up the rotated token.
    crate::auth::ensure_fresh(app);
    let cfg = app.state::<AppState>().config.lock().clone();
    if cfg.subunit_access_token.is_empty() && cfg.subunit_api_key.is_empty() {
        return Ok(());
    }

    let dirty = crate::store::take_dirty_notes(&account);
    let body = json!({ "notes": dirty });

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()?;
    let mut req = client.post(endpoint_notes(&cfg)).json(&body);
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    }
    let resp = req.send()?;
    if !resp.status().is_success() {
        anyhow::bail!("notes sync {}", resp.status());
    }
    let server: Value = resp.json()?;
    let notes = server
        .get("notes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // Ack what we pushed (only clears dirty if unchanged since), then reconcile
    // the authoritative set into the local store.
    let pushed: Vec<(String, i64)> = dirty
        .iter()
        .filter_map(|p| {
            Some((
                p.get("id").and_then(Value::as_str)?.to_string(),
                p.get("updated_at").and_then(Value::as_i64).unwrap_or(0),
            ))
        })
        .collect();
    crate::store::mark_notes_synced(&account, &pushed);
    crate::store::apply_server_notes(&account, &notes);

    // ── Folders (same round-trip, against /v1/note-folders/sync) — folders are
    // first-class synced objects so they appear on every device even when empty.
    // Reuses the same client + auth; a folder failure never undoes the note sync.
    let dirty_f = crate::store::take_dirty_folders(&account);
    let body_f = json!({ "folders": dirty_f });
    let mut req_f = client.post(endpoint_folders(&cfg)).json(&body_f);
    if !cfg.subunit_access_token.is_empty() {
        req_f = req_f.bearer_auth(&cfg.subunit_access_token);
    } else {
        req_f = req_f.header("X-API-Key", cfg.subunit_api_key.clone());
    }
    let resp_f = req_f.send()?;
    if !resp_f.status().is_success() {
        anyhow::bail!("note-folders sync {}", resp_f.status());
    }
    let server_f: Value = resp_f.json()?;
    let folders = server_f
        .get("folders")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let pushed_f: Vec<(String, i64)> = dirty_f
        .iter()
        .filter_map(|p| {
            Some((
                p.get("id").and_then(Value::as_str)?.to_string(),
                p.get("updated_at").and_then(Value::as_i64).unwrap_or(0),
            ))
        })
        .collect();
    crate::store::mark_folders_synced(&account, &pushed_f);
    crate::store::apply_server_folders(&account, &folders);

    // Nudge any open Notes UI to reload its list (notes AND folders).
    let _ = app.emit("echo://notes-changed", ());
    Ok(())
}
