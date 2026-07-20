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

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::AppState;
use crate::config::Config;

/// Single-flight guard: coalesce overlapping syncs. `kick` fires on every note
/// change, window focus, and startup, so without this several round-trips race
/// and their `apply_server_notes` reconciles can arrive out of order and clobber
/// each other. A change that lands while a sync is in flight is safe — its dirty
/// row persists and the next kick (focus/change/startup all re-fire) pushes it.
static SYNC_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Fire a detached, best-effort sync. Safe to call after every note change, on
/// window focus, and at startup / after login. No-op for signed-out accounts.
pub fn kick(app: &AppHandle) {
    // Skip if a sync is already running — coalesce instead of racing.
    if SYNC_IN_FLIGHT.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let cfg = { app.state::<AppState>().config.lock().clone() };
        if let Err(e) = sync_blocking(&app, &cfg) {
            log::warn!("notes sync failed (ignored): {e}");
        }
        SYNC_IN_FLIGHT.store(false, Ordering::Release);
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

/// Extract an authoritative array field from a 2xx sync body. Returns `Some` ONLY
/// for a real JSON array (including an explicit empty one — a legitimate "you have
/// zero items" from the server); `None` for a missing field, `null`, or a
/// non-array. Reconciling on `None` would treat a contract violation as an
/// authoritative empty set and wipe every clean local note/folder — so callers
/// MUST skip the reconcile when this returns `None`. Pure, so the data-loss guard
/// is unit-tested without a network.
fn authoritative_array<'a>(body: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    match body.get(key) {
        Some(Value::Array(a)) => Some(a),
        _ => None,
    }
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

    // Ack what we pushed (only clears dirty if unchanged since).
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

    // Reconcile the authoritative set into the local store — but ONLY when the
    // server actually returned a well-formed `notes` array. A 2xx whose body
    // lacks a valid `notes` array (missing field, `null`, wrong type) is a
    // contract violation, NOT an authoritative empty set; treating it as one
    // makes apply_server_notes DELETE every clean local note (data loss). An
    // explicit empty array IS still honoured (fresh account, or all notes deleted
    // on another device).
    match authoritative_array(&server, "notes") {
        Some(notes) => crate::store::apply_server_notes(&account, notes),
        None => log::warn!(
            "notes sync: 2xx response missing a valid `notes` array — skipping \
             reconcile to protect local notes"
        ),
    }

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
    // Same data-loss guard as notes above: only reconcile (which deletes local
    // folders the server omitted) when the server sent a real `folders` array.
    match authoritative_array(&server_f, "folders") {
        Some(folders) => crate::store::apply_server_folders(&account, folders),
        None => log::warn!(
            "note-folders sync: 2xx response missing a valid `folders` array — \
             skipping reconcile to protect local folders"
        ),
    }

    // Nudge any open Notes UI to reload its list (notes AND folders).
    let _ = app.emit("echo://notes-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // A well-formed authoritative set is reconciled (incl. an explicit empty one).
    #[test]
    fn honours_a_real_array_including_empty() {
        let one = json!({ "notes": [{ "id": "a" }] });
        assert_eq!(authoritative_array(&one, "notes").map(Vec::len), Some(1));

        // Explicit empty array = the server authoritatively has zero notes (fresh
        // account / everything deleted elsewhere). This SHOULD reconcile.
        let empty = json!({ "notes": [] });
        assert_eq!(authoritative_array(&empty, "notes").map(Vec::len), Some(0));
    }

    // The data-loss cases: a 2xx body without a valid array must NOT reconcile,
    // so apply_server_notes never runs with an empty set and never wipes locals.
    #[test]
    fn refuses_missing_null_or_wrong_type() {
        assert!(authoritative_array(&json!({}), "notes").is_none());
        assert!(authoritative_array(&json!({ "ok": true }), "notes").is_none());
        assert!(authoritative_array(&json!({ "notes": null }), "notes").is_none());
        assert!(authoritative_array(&json!({ "notes": "oops" }), "notes").is_none());
        assert!(authoritative_array(&json!({ "notes": 42 }), "notes").is_none());
        assert!(authoritative_array(&json!({ "notes": { "a": 1 } }), "notes").is_none());
    }
}
