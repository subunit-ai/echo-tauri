//! Persistenter Account-Stimmabdruck (transcribe.subunit.ai /v1/voiceprints/*).
//!
//! NICHT zu verwechseln mit den ephemeren local-meet-Check-in-Voiceprints
//! (meet_local/engine.rs — pro Meeting, nie persistiert): HIER geht es um den
//! OPT-IN Account-Stimmabdruck (Art. 9 DSGVO, explizite Einwilligung), der
//! Meetings das Zahl-Vorlesen erspart und sich — mit separatem Adaptiv-Consent —
//! aus eigenen Meetings + Diktaten laufend präzisiert.
//!
//! Alle Calls laufen als Rust-Commands (das Frontend hat bewusst keine
//! http-Capability); Auth-Muster wie presets_sync.rs: erst `auth::ensure_fresh`
//! (Fast-No-op bei gültigem Token), dann Bearer, X-API-Key als Legacy-Fallback.
//! Aufnahme fürs geführte Enrollment nutzt den EINEN nativen Audio-Stack
//! (recorder.rs) — exakt das note_record_*-Quartett aus notes.rs.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::auth;
use crate::config::Config;
use crate::http;
use crate::transcribe::{downsample_to_16k, samples_to_wav};
use crate::AppState;

fn base(cfg: &Config, path: &str) -> String {
    cfg.subunit_endpoint.replace("/v1/transcribe", path)
}

fn authed(
    req: reqwest::blocking::RequestBuilder,
    cfg: &Config,
) -> reqwest::blocking::RequestBuilder {
    if !cfg.subunit_access_token.is_empty() {
        req.bearer_auth(cfg.subunit_access_token.clone())
    } else if !cfg.subunit_api_key.is_empty() {
        req.header("X-API-Key", cfg.subunit_api_key.clone())
    } else {
        req
    }
}

/// Meta-Status des Account-Stimmabdrucks (GET /me, 1:1 durchgereicht — das
/// Frontend rendert daraus Status, Vervollständigung und gelernte Anker).
/// `(async)`: Netz-Call.
#[tauri::command(async)]
pub fn voiceprint_me(app: AppHandle, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    auth::ensure_fresh(&app);
    let cfg = state.config.lock().clone();
    if cfg.subunit_access_token.is_empty() && cfg.subunit_api_key.is_empty() {
        return Err("not_logged_in".into());
    }
    let url = base(&cfg, "/v1/voiceprints/me");
    let send = || authed(http::client().get(&url).timeout(Duration::from_secs(15)), &cfg).send();
    let resp = match send() {
        Err(e) if http::is_transient(&e) => send().map_err(|e| e.to_string())?,
        r => r.map_err(|e| e.to_string())?,
    };
    if !resp.status().is_success() {
        return Err(format!("http_{}", resp.status().as_u16()));
    }
    resp.json::<serde_json::Value>().map_err(|e| e.to_string())
}

/// Adaptives Lernen an/aus (separater Consent — eigener Zweck nach Art. 9).
#[tauri::command(async)]
pub fn voiceprint_adaptive(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    auth::ensure_fresh(&app);
    let cfg = state.config.lock().clone();
    let url = base(&cfg, "/v1/voiceprints/adaptive-consent");
    let form = reqwest::blocking::multipart::Form::new()
        .text("enabled", if enabled { "true" } else { "false" });
    let resp = authed(http::client().post(&url).timeout(Duration::from_secs(15)), &cfg)
        .multipart(form)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http_{}", resp.status().as_u16()));
    }
    Ok(())
}

/// Gelernte Prototypen zurücksetzen (der Enroll-Kern bleibt).
#[tauri::command(async)]
pub fn voiceprint_reset_learned(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    auth::ensure_fresh(&app);
    let cfg = state.config.lock().clone();
    let url = base(&cfg, "/v1/voiceprints/prototypes/reset");
    let resp = authed(http::client().post(&url).timeout(Duration::from_secs(15)), &cfg)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http_{}", resp.status().as_u16()));
    }
    Ok(())
}

/// Widerruf (Tombstone) — der Zahl-Check-in greift danach wieder.
#[tauri::command(async)]
pub fn voiceprint_delete(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    auth::ensure_fresh(&app);
    let cfg = state.config.lock().clone();
    let url = base(&cfg, "/v1/voiceprints/me");
    let resp = authed(http::client().delete(&url).timeout(Duration::from_secs(15)), &cfg)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http_{}", resp.status().as_u16()));
    }
    Ok(())
}

/// Enrollment-Aufnahme starten (geteilter Recorder, gleiche Guards wie Notes:
/// nie eine laufende Diktat-Session kapern).
#[tauri::command]
pub fn voiceprint_record_start(state: State<'_, AppState>) -> Result<(), String> {
    if state.session_active.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let dev = state.config.lock().mic_device_name.clone();
    if let Err(msg) = state
        .recorder
        .start(if dev.is_empty() { None } else { Some(dev) })
    {
        state.session_active.store(false, Ordering::SeqCst);
        return Err(msg);
    }
    Ok(())
}

/// Live-Pegel (0..1) für das Aufnahme-Meter. Gepollt während der Aufnahme.
#[tauri::command]
pub fn voiceprint_record_level(state: State<'_, AppState>) -> f32 {
    state.recorder.level()
}

/// Aufnahme verwerfen.
#[tauri::command]
pub fn voiceprint_record_cancel(state: State<'_, AppState>) {
    state.session_active.store(false, Ordering::SeqCst);
    let _ = state.recorder.stop();
}

#[derive(Debug, Clone, Serialize)]
pub struct EnrollResult {
    pub quality: f64,
    pub voiced_s: f64,
}

/// Aufnahme stoppen + als geführtes Enrollment hochladen. Consent kommt als
/// expliziter Parameter aus der UI-Checkbox (nie implizit). `(async)`: der
/// Upload eines ~60s-Clips ist ein langer Netz-Call (learning_suggestions-Regel).
#[tauri::command(async)]
pub fn voiceprint_record_enroll(
    app: AppHandle,
    state: State<'_, AppState>,
    consent: bool,
) -> Result<EnrollResult, String> {
    let cap_result = state.recorder.stop();
    state.session_active.store(false, Ordering::SeqCst);
    if !consent {
        return Err("consent_required".into());
    }
    let cap = match cap_result {
        Some(c) if !c.samples.is_empty() => c,
        Some(_) => return Err("empty".into()),
        None => return Err("no_recording".into()),
    };
    auth::ensure_fresh(&app);
    let cfg = state.config.lock().clone();
    if cfg.subunit_access_token.is_empty() && cfg.subunit_api_key.is_empty() {
        return Err("not_logged_in".into());
    }
    let (s16, _) = downsample_to_16k(&cap.samples, cap.sample_rate);
    let wav = samples_to_wav(&s16, 16_000).map_err(|e| e.to_string())?;
    let url = base(&cfg, "/v1/voiceprints/enroll");
    let part = reqwest::blocking::multipart::Part::bytes(wav)
        .file_name("voiceprint.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::blocking::multipart::Form::new()
        .part("file", part)
        .text("consent", "true")
        .text("source_mic", "nearfield")
        .text("locale", cfg.language.clone());
    let resp = authed(
        http::client().post(&url).timeout(Duration::from_secs(120)),
        &cfg,
    )
    .multipart(form)
    .send()
    .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().unwrap_or_default();
    if !status.is_success() {
        // Server liefert deutsche, actionable detail-Texte (zu kurz/zweite Stimme…)
        let detail = body
            .get("detail")
            .and_then(|d| d.as_str())
            .unwrap_or("Upload fehlgeschlagen")
            .to_string();
        return Err(detail);
    }
    Ok(EnrollResult {
        quality: body.get("quality").and_then(|v| v.as_f64()).unwrap_or(0.0),
        voiced_s: body.get("voiced_s").and_then(|v| v.as_f64()).unwrap_or(0.0),
    })
}
