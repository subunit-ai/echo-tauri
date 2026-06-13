//! Best-effort per-account cloud sync of orb profiles against `/v1/presets`.
//!
//! Mirrors the auth of [`crate::synapse`] (bearer access-token, else X-API-Key).
//! One round-trip pushes the locally-changed profiles (incl. tombstones) and
//! pulls back the authoritative set, which is reconciled into the local store
//! (see [`crate::store::apply_server_profiles`]). Never blocks the UI: every
//! call spawns a short-lived thread and swallows errors — local-first means a
//! failed sync just retries on the next change.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::AppState;
use crate::config::Config;

/// Fire a detached, best-effort sync. Safe to call after every profile change
/// and at startup / after login. No-op for signed-out (local-only) accounts.
pub fn kick(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let cfg = { app.state::<AppState>().config.lock().clone() };
        if let Err(e) = sync_blocking(&app, &cfg) {
            log::warn!("presets sync failed (ignored): {e}");
        }
    });
}

fn endpoint(cfg: &Config) -> String {
    // The bare host also contains "transcribe"; replace the full path segment.
    cfg.subunit_endpoint.replace("/v1/transcribe", "/v1/presets/sync")
}

fn sync_blocking(app: &AppHandle, cfg: &Config) -> anyhow::Result<()> {
    let account = crate::presets::account_key(cfg);
    // Signed-out: profiles stay local (and never vanish), nothing to sync.
    if account == "local" {
        return Ok(());
    }
    // Refresh the access token BEFORE using it. At startup (and after a long
    // idle) the token loaded from disk is usually expired — without this the
    // very first sync 401s (TJ's log: "presets sync 401" right after launch)
    // and orb profiles never reach the cloud until the token happens to be
    // fresh. ensure_fresh is a fast no-op when the token is still valid, and
    // serialized so it can't race the other refreshers. Re-read the config
    // afterwards to pick up the rotated access token.
    crate::auth::ensure_fresh(app);
    let cfg = app.state::<AppState>().config.lock().clone();
    if cfg.subunit_access_token.is_empty() && cfg.subunit_api_key.is_empty() {
        return Ok(());
    }

    let dirty = crate::store::take_dirty_profiles(&account);
    let body = json!({ "profiles": dirty, "since": 0 });

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()?;
    let mut req = client.post(endpoint(&cfg)).json(&body);
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    }
    let resp = req.send()?;
    if !resp.status().is_success() {
        anyhow::bail!("presets sync {}", resp.status());
    }
    let server: Value = resp.json()?;
    let profiles = server
        .get("profiles")
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
    crate::store::mark_profiles_synced(&account, &pushed);
    crate::store::apply_server_profiles(&account, &profiles);

    // Nudge any open Settings/configurator UI to reload its list.
    let _ = app.emit("echo://profiles-changed", ());
    Ok(())
}
