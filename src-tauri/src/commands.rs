//! Tauri IPC commands — the bridge between the React frontend and the Rust engine.

use crate::config::Config;
use parking_lot::Mutex;
use tauri::State;

/// App-wide managed state. The engine modules (recorder, hotkey, transcribe)
/// will extend this as they land.
pub struct AppState {
    pub config: Mutex<Config>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            config: Mutex::new(config),
        }
    }
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Config {
    state.config.lock().clone()
}

#[tauri::command]
pub fn set_config(state: State<'_, AppState>, config: Config) -> Result<(), String> {
    config.save().map_err(|e| e.to_string())?;
    *state.config.lock() = config;
    Ok(())
}

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn list_audio_devices() -> Vec<String> {
    // Real cpal enumeration lands with recorder.rs; placeholder keeps the UI wired.
    vec!["System Default".to_string()]
}
