//! Tauri IPC commands + shared engine helpers.
//!
//! The `do_*` helpers hold the actual record/transcribe logic so both the IPC
//! commands and the global-hotkey handler ([`crate::hotkey`]) call one code path.

use crate::config::Config;
use crate::events::{emit_state, emit_transcript, EngineState};
use crate::inject::Target;
use crate::recorder::Recorder;
use crate::transcribe::{self, EngineError, TranscriptResult};
use parking_lot::Mutex;
use tauri::{AppHandle, Manager, State};

/// App-wide managed state.
pub struct AppState {
    pub config: Mutex<Config>,
    pub recorder: Recorder,
    /// Window captured at record-start, focused again before paste-back.
    pub target: Mutex<Option<Target>>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            config: Mutex::new(config),
            recorder: Recorder::new(),
            target: Mutex::new(None),
        }
    }
}

/// Blank secret fields before handing the config to the frontend — tokens/keys
/// never need to leave Rust, and a future XSS shouldn't be able to read them.
fn sanitized(mut c: Config) -> Config {
    c.subunit_access_token.clear();
    c.subunit_refresh_token.clear();
    c.subunit_api_key.clear();
    c.openai_api_key.clear();
    c.groq_api_key.clear();
    c.custom_api_key.clear();
    c.openrouter_api_key.clear();
    c
}

// ---- Shared engine helpers (called by commands AND the hotkey handler) ----

pub fn do_start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (dev, lock) = {
        let c = state.config.lock();
        (c.mic_device_name.clone(), c.target_lock)
    };
    if lock {
        *state.target.lock() = Some(crate::inject::capture_active_window());
    }
    state
        .recorder
        .start(if dev.is_empty() { None } else { Some(dev) });
    emit_state(app, EngineState::Recording, None);
}

pub fn do_cancel(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = state.recorder.stop();
    *state.target.lock() = None;
    emit_state(app, EngineState::Idle, None);
}

/// Stop + transcribe synchronously. Blocking (network), so the hotkey handler
/// calls this on a spawned thread; the IPC command calls it directly.
pub fn do_transcribe(app: &AppHandle) -> Result<TranscriptResult, EngineError> {
    let state = app.state::<AppState>();
    let cap = match state.recorder.stop() {
        Some(c) => c,
        None => return Err(EngineError::new("no_recording", "keine aktive Aufnahme")),
    };
    if cap.samples.is_empty() {
        emit_state(app, EngineState::Idle, None);
        return Err(EngineError::new("empty", "leere Aufnahme"));
    }

    emit_state(app, EngineState::Transcribing, None);

    // Cloud path: refresh the access token if it's expired before we call out.
    if state.config.lock().mode == "subunit" {
        crate::auth::ensure_fresh(app);
    }
    let cfg = state.config.lock().clone();

    let result = match transcribe::run(&cfg, &cap.samples, cap.sample_rate) {
        Ok(r) => r,
        Err(e) => {
            emit_state(app, EngineState::Error, Some(e.message.clone()));
            return Err(e);
        }
    };

    // Target window (captured at record-start) + Auto-Mode style from its title.
    let target = state.target.lock().take();
    let title = target.as_ref().map(|t| t.title.clone()).unwrap_or_default();
    let style = if cfg.cleanup_auto_mode {
        crate::auto_mode::pick_style(&title, &cfg.auto_mode_overrides, &cfg.cleanup_style)
    } else {
        cfg.cleanup_style.clone()
    };

    // Post-process: optional server AI-cleanup + DACH formatting (both best-effort).
    let mut text = result.text;
    if cfg.cleanup_enabled {
        text = crate::cleanup::maybe_cleanup(&cfg, &text, &style);
    }
    if cfg.dach_format_enabled {
        text = crate::dach::dach_format(&text);
    }
    let result = TranscriptResult {
        text,
        quality_mode: result.quality_mode,
    };

    // Paste-back into the captured target window (clipboard + paste per config).
    if let Err(e) = crate::inject::deliver(&result.text, &cfg, target.as_ref()) {
        log::warn!("inject failed: {e}");
    }

    // Stats + history.
    {
        let mut c = state.config.lock();
        c.total_transcriptions += 1;
        c.total_audio_seconds += cap.samples.len() as f64 / cap.sample_rate.max(1) as f64;
        if c.history_enabled && !result.text.trim().is_empty() {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let entry = serde_json::json!({
                "text": result.text,
                "quality_mode": result.quality_mode,
                "ts": now,
            });
            c.history.insert(0, entry);
            let max = c.history_size.max(0) as usize;
            if c.history.len() > max {
                c.history.truncate(max);
            }
        }
        let _ = c.save();
    }

    emit_transcript(app, result.text.clone(), result.quality_mode.clone());
    emit_state(app, EngineState::Done, None);
    Ok(result)
}

// ---- IPC commands ----

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Config {
    sanitized(state.config.lock().clone())
}

#[tauri::command]
pub fn set_config(app: AppHandle, state: State<'_, AppState>, mut config: Config) -> Result<(), String> {
    // Preserve secret fields server-side: the frontend neither sees nor sets
    // them (get_config blanks them), so never let a round-trip clobber tokens.
    let hotkey_changed = {
        let cur = state.config.lock();
        config.subunit_access_token = cur.subunit_access_token.clone();
        config.subunit_refresh_token = cur.subunit_refresh_token.clone();
        config.subunit_token_issued_at = cur.subunit_token_issued_at;
        config.subunit_token_expires_in = cur.subunit_token_expires_in;
        config.subunit_workspace_id = cur.subunit_workspace_id.clone();
        config.subunit_api_key = cur.subunit_api_key.clone();
        config.openai_api_key = cur.openai_api_key.clone();
        config.groq_api_key = cur.groq_api_key.clone();
        config.custom_api_key = cur.custom_api_key.clone();
        config.openrouter_api_key = cur.openrouter_api_key.clone();
        cur.hotkey != config.hotkey
    };
    config.save().map_err(|e| e.to_string())?;
    *state.config.lock() = config;
    if hotkey_changed {
        crate::hotkey::reregister_from_config(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn list_audio_devices() -> Vec<String> {
    crate::recorder::list_input_devices()
}

#[tauri::command]
pub fn mic_level(state: State<'_, AppState>) -> f32 {
    state.recorder.level()
}

#[tauri::command]
pub fn start_recording(app: AppHandle) {
    do_start(&app);
}

#[tauri::command]
pub fn cancel_recording(app: AppHandle) {
    do_cancel(&app);
}

#[tauri::command]
pub fn stop_and_transcribe(app: AppHandle) -> Result<TranscriptResult, EngineError> {
    do_transcribe(&app)
}

#[tauri::command]
pub fn login(app: AppHandle) -> Result<String, String> {
    crate::auth::login(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn logout(state: State<'_, AppState>) -> Result<(), String> {
    let mut c = state.config.lock();
    c.subunit_access_token.clear();
    c.subunit_refresh_token.clear();
    c.subunit_token_issued_at = 0.0;
    c.subunit_token_expires_in = 0;
    c.subunit_workspace_id.clear();
    c.account_email.clear();
    c.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(u)) => Ok(Some(u.version)),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
