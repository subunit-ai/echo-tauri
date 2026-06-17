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
            EngineState::Recording => "Echo (Beta) — Aufnahme…",
            EngineState::Transcribing => "Echo (Beta) — Transkribiere…",
            EngineState::Error => "Echo (Beta) — Fehler",
            _ => "Echo (Beta)",
        };
        let _ = tray.set_tooltip(Some(tip));
    }

    // #32: when idle-"hide" is on, the overlay window is physically hidden while
    // idle and shown the instant a session starts — keep that in sync here, the
    // one place every state transition flows through.
    sync_overlay_idle_hide(app, state);

    // Done and Error are TRANSIENT: settle back to Idle after a beat so the overlay's
    // idle behaviour (calm idle colour, dim/hide) re-engages. Without this the state
    // stuck on Error forever after a failed transcription → the orb sat at the fixed
    // error-amber and the user's configurable colours looked broken (they only apply
    // to idle/working/done, never to error). Skip if a recording resumed meanwhile.
    if matches!(state, EngineState::Done | EngineState::Error) {
        let app = app.clone();
        // Done = a brief confirmation flash then back to idle (TJ: 1600 ms felt too
        // long — the orb lingered / took too long to disappear). Error stays longer
        // so a failure is actually noticed.
        let delay_ms = if matches!(state, EngineState::Error) { 2500 } else { 700 };
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay_ms));
            if !app.state::<crate::commands::AppState>().recorder.is_recording() {
                emit_state(&app, EngineState::Idle, None);
            }
        });
    }
}

/// #32: when `orb_idle_mode == "hide"`, the overlay must be physically gone while
/// idle (a hidden window — not merely a blank canvas — so the hover flyout never
/// opens over its old spot), and reappear the moment a session leaves idle.
/// Generic over the runtime so it can sit on this central state hook.
fn sync_overlay_idle_hide<R: Runtime>(app: &AppHandle<R>, state: EngineState) {
    let hide_when_idle = {
        let st = app.state::<crate::commands::AppState>();
        let c = st.config.lock();
        c.use_orb_overlay && c.orb_idle_mode == "hide"
    };
    if !hide_when_idle {
        return;
    }
    if let Some(w) = app.get_webview_window("overlay") {
        if matches!(state, EngineState::Idle) {
            let _ = w.hide();
        } else {
            let _ = w.show();
        }
    }
}

pub fn emit_level<R: Runtime>(app: &AppHandle<R>, level: f32) {
    let _ = app.emit(EVT_LEVEL, LevelPayload { level });
}

pub fn emit_transcript<R: Runtime>(app: &AppHandle<R>, text: String, quality_mode: String) {
    let _ = app.emit(EVT_TRANSCRIPT, TranscriptPayload { text, quality_mode });
}
