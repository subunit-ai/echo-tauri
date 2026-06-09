//! Frontend event bus. Rust is the source of truth for engine state; the React
//! UI subscribes to these events (the Tauri equivalent of the PyQt signal/slot
//! flow in the old `main.py` — `finished`/`failed`/`auto_mode_picked`).
#![allow(dead_code)]

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const EVT_STATE: &str = "echo://state";
pub const EVT_LEVEL: &str = "echo://mic-level";
pub const EVT_TRANSCRIPT: &str = "echo://transcript";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineState {
    Idle,
    Recording,
    Transcribing,
    Done,
    Error,
}

#[derive(Clone, Serialize)]
pub struct StatePayload {
    pub state: EngineState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct LevelPayload {
    pub level: f32,
}

#[derive(Clone, Serialize)]
pub struct TranscriptPayload {
    pub text: String,
    pub quality_mode: String,
}

pub fn emit_state<R: Runtime>(app: &AppHandle<R>, state: EngineState, detail: Option<String>) {
    let _ = app.emit(EVT_STATE, StatePayload { state, detail });
    // Dynamic tray tooltip reflecting the current state.
    if let Some(tray) = app.tray_by_id("tray") {
        let tip = match state {
            EngineState::Recording => "Echo — Aufnahme…",
            EngineState::Transcribing => "Echo — Transkribiere…",
            EngineState::Error => "Echo — Fehler",
            _ => "Echo",
        };
        let _ = tray.set_tooltip(Some(tip));
    }

    // Done and Error are TRANSIENT: settle back to Idle after a beat so the overlay's
    // idle behaviour (calm idle colour, dim/hide) re-engages. Without this the state
    // stuck on Error forever after a failed transcription → the orb sat at the fixed
    // error-amber and the user's configurable colours looked broken (they only apply
    // to idle/working/done, never to error). Skip if a recording resumed meanwhile.
    if matches!(state, EngineState::Done | EngineState::Error) {
        let app = app.clone();
        let delay_ms = if matches!(state, EngineState::Error) { 2500 } else { 1600 };
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay_ms));
            if !app.state::<crate::commands::AppState>().recorder.is_recording() {
                emit_state(&app, EngineState::Idle, None);
            }
        });
    }
}

pub fn emit_level<R: Runtime>(app: &AppHandle<R>, level: f32) {
    let _ = app.emit(EVT_LEVEL, LevelPayload { level });
}

pub fn emit_transcript<R: Runtime>(app: &AppHandle<R>, text: String, quality_mode: String) {
    let _ = app.emit(EVT_TRANSCRIPT, TranscriptPayload { text, quality_mode });
}
