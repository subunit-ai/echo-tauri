//! Tauri IPC commands + shared engine helpers.
//!
//! The `do_*` helpers hold the actual record/transcribe logic so both the IPC
//! commands and the global-hotkey handler ([`crate::hotkey`]) call one code path.

use crate::config::Config;
use crate::events::{emit_state, emit_transcript, EngineState};
use crate::recorder::Recorder;
use crate::transcribe::{self, TranscriptResult};
use parking_lot::Mutex;
use tauri::{AppHandle, Manager, State};

/// App-wide managed state.
pub struct AppState {
    pub config: Mutex<Config>,
    pub recorder: Recorder,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            config: Mutex::new(config),
            recorder: Recorder::new(),
        }
    }
}

// ---- Shared engine helpers (called by commands AND the hotkey handler) ----

pub fn do_start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let dev = state.config.lock().mic_device_name.clone();
    state
        .recorder
        .start(if dev.is_empty() { None } else { Some(dev) });
    emit_state(app, EngineState::Recording, None);
}

pub fn do_cancel(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = state.recorder.stop();
    emit_state(app, EngineState::Idle, None);
}

/// Stop + transcribe synchronously. Blocking (network), so the hotkey handler
/// calls this on a spawned thread; the IPC command calls it directly.
pub fn do_transcribe(app: &AppHandle) -> Result<TranscriptResult, String> {
    let state = app.state::<AppState>();
    let cap = match state.recorder.stop() {
        Some(c) => c,
        None => return Err("no active recording".into()),
    };
    if cap.samples.is_empty() {
        emit_state(app, EngineState::Idle, None);
        return Err("empty recording".into());
    }

    emit_state(app, EngineState::Transcribing, None);
    let cfg = state.config.lock().clone();

    let wav = transcribe::samples_to_wav(&cap.samples, cap.sample_rate).map_err(|e| e.to_string())?;
    let result = match transcribe::run(&cfg, wav) {
        Ok(r) => r,
        Err(e) => {
            emit_state(app, EngineState::Error, Some(e.to_string()));
            return Err(e.to_string());
        }
    };

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
    state.config.lock().clone()
}

#[tauri::command]
pub fn set_config(app: AppHandle, state: State<'_, AppState>, config: Config) -> Result<(), String> {
    config.save().map_err(|e| e.to_string())?;
    let hotkey_changed = state.config.lock().hotkey != config.hotkey;
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
pub fn stop_and_transcribe(app: AppHandle) -> Result<TranscriptResult, String> {
    do_transcribe(&app)
}
