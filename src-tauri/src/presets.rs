//! Orb profiles — named, per-account snapshots of the FULL overlay look
//! (colours, style, speed, idle behaviour, size, voice-reactivity).
//!
//! Local-first: profiles live in the SQLite store (`store::*_profile*`),
//! partitioned by account so they never mix between users, and sync per
//! account via [`crate::presets_sync`]. This is the data foundation the future
//! "Orb configurator" UI (big live preview, effect/voice pickers) builds on —
//! the payload is an opaque JSON blob so new look-fields need no migration.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::AppState;
use crate::config::Config;

/// Account partition key: workspace when the user acts in one (shared across
/// that workspace's devices), else their email, else `"local"` (signed-out —
/// profiles stay on the device and don't sync). Mirrors the server's `owner`.
pub fn account_key(c: &Config) -> String {
    let ws = c.subunit_workspace_id.trim();
    if !ws.is_empty() {
        return format!("ws:{}", ws.to_lowercase());
    }
    let email = c.account_email.trim();
    if !email.is_empty() {
        return format!("em:{}", email.to_lowercase());
    }
    "local".to_string()
}

/// Snapshot the current orb look as a profile payload.
pub fn payload_from_config(c: &Config) -> Value {
    json!({
        "colors": {
            "idle": c.orb_color_idle,
            "working": c.orb_color_working,
            "done": c.orb_color_done,
            "error": c.orb_color_error,
        },
        "style": c.orb_overlay_style,
        "speed": c.orb_speed,
        "idle_mode": c.orb_idle_mode,
        "idle_pulse": c.orb_idle_pulse,
        "size": c.orb_overlay_size,
        "appear": c.orb_appear_anim,
        "reactivity": {
            "noise_floor": c.orb_noise_floor,
            "gain": c.orb_gain,
            "gamma": c.orb_gamma,
        },
    })
}

/// Write a payload onto the config in place. Tolerant — only known keys, and a
/// missing key leaves the current value untouched (forward-compatible).
fn apply_payload(c: &mut Config, p: &Value) {
    if let Some(colors) = p.get("colors") {
        if let Some(s) = colors.get("idle").and_then(Value::as_str) { c.orb_color_idle = s.to_string(); }
        if let Some(s) = colors.get("working").and_then(Value::as_str) { c.orb_color_working = s.to_string(); }
        if let Some(s) = colors.get("done").and_then(Value::as_str) { c.orb_color_done = s.to_string(); }
        if let Some(s) = colors.get("error").and_then(Value::as_str) { c.orb_color_error = s.to_string(); }
    }
    if let Some(s) = p.get("style").and_then(Value::as_str) { c.orb_overlay_style = s.to_string(); }
    if let Some(v) = p.get("speed").and_then(Value::as_f64) { c.orb_speed = v as f32; }
    if let Some(s) = p.get("idle_mode").and_then(Value::as_str) { c.orb_idle_mode = s.to_string(); }
    if let Some(b) = p.get("idle_pulse").and_then(Value::as_bool) { c.orb_idle_pulse = b; }
    if let Some(v) = p.get("size").and_then(Value::as_f64) { c.orb_overlay_size = v as f32; }
    if let Some(s) = p.get("appear").and_then(Value::as_str) { c.orb_appear_anim = s.to_string(); }
    if let Some(r) = p.get("reactivity") {
        if let Some(v) = r.get("noise_floor").and_then(Value::as_f64) { c.orb_noise_floor = v as f32; }
        if let Some(v) = r.get("gain").and_then(Value::as_f64) { c.orb_gain = v as f32; }
        if let Some(v) = r.get("gamma").and_then(Value::as_f64) { c.orb_gamma = v as f32; }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

static ID_SEQ: AtomicU64 = AtomicU64::new(0);

/// Per-account-unique id (no uuid dep): timestamp + a monotonic process counter.
fn new_id() -> String {
    let t = now_ms();
    let n = ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("p{t:x}-{n:x}")
}

fn find_payload(account: &str, id: &str) -> Option<Value> {
    crate::store::list_profiles(account)
        .into_iter()
        .find(|p| p.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|p| p.get("payload").cloned())
}

/// All of the current account's saved profiles (newest-first), `{id,name,payload,updated_at}`.
#[tauri::command]
pub fn list_orb_profiles(state: State<'_, AppState>) -> Vec<Value> {
    let account = account_key(&state.config.lock());
    crate::store::list_profiles(&account)
}

/// Create (empty/None id) or update a profile. `payload` null → snapshot the
/// current orb look. Returns the profile id.
#[tauri::command]
pub fn save_orb_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    payload: Option<Value>,
) -> Result<String, String> {
    let account = account_key(&state.config.lock());
    let pid = id.filter(|s| !s.is_empty()).unwrap_or_else(new_id);
    let payload = payload.unwrap_or_else(|| payload_from_config(&state.config.lock()));
    crate::store::upsert_profile(&account, &pid, name.trim(), &payload.to_string(), now_ms(), true);
    crate::presets_sync::kick(&app);
    Ok(pid)
}

/// Apply a saved profile's look to the live config + overlay.
#[tauri::command]
pub fn apply_orb_profile(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let account = account_key(&state.config.lock());
    let payload = find_payload(&account, &id).ok_or_else(|| "profile not found".to_string())?;
    let cfg = {
        let mut c = state.config.lock();
        apply_payload(&mut c, &payload);
        c.clone()
    };
    cfg.save().map_err(|e| e.to_string())?;
    *state.config.lock() = cfg.clone();
    crate::recorder::set_reactivity(cfg.orb_noise_floor, cfg.orb_gain, cfg.orb_gamma);
    crate::overlay::apply_config(&app);
    Ok(())
}

#[tauri::command]
pub fn rename_orb_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    let account = account_key(&state.config.lock());
    let payload = find_payload(&account, &id).ok_or_else(|| "profile not found".to_string())?;
    crate::store::upsert_profile(&account, &id, name.trim(), &payload.to_string(), now_ms(), true);
    crate::presets_sync::kick(&app);
    Ok(())
}

#[tauri::command]
pub fn delete_orb_profile(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let account = account_key(&state.config.lock());
    crate::store::soft_delete_profile(&account, &id, now_ms());
    crate::presets_sync::kick(&app);
    Ok(())
}

#[tauri::command]
pub fn duplicate_orb_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<String, String> {
    let account = account_key(&state.config.lock());
    let payload = find_payload(&account, &id).ok_or_else(|| "profile not found".to_string())?;
    let pid = new_id();
    crate::store::upsert_profile(&account, &pid, name.trim(), &payload.to_string(), now_ms(), true);
    crate::presets_sync::kick(&app);
    Ok(pid)
}
