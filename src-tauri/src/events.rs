//! Frontend event bus. Rust is the source of truth for engine state; the React
//! UI subscribes to these events (the Tauri equivalent of the PyQt signal/slot
//! flow in the old `main.py` — `finished`/`failed`/`auto_mode_picked`).
#![allow(dead_code)]

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

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
}

pub fn emit_level<R: Runtime>(app: &AppHandle<R>, level: f32) {
    let _ = app.emit(EVT_LEVEL, LevelPayload { level });
}

pub fn emit_transcript<R: Runtime>(app: &AppHandle<R>, text: String, quality_mode: String) {
    let _ = app.emit(EVT_TRANSCRIPT, TranscriptPayload { text, quality_mode });
}
