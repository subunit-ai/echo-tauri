//! First-run intro support: the live first-dictation preview.
//!
//! The finale of the intro lets the user hold their hotkey and speak — but the
//! normal pipeline ([`crate::commands::do_transcribe`]) injects the transcript
//! into the focused window, which during the intro is Echo itself. This module
//! provides the minimal slice instead: stop + transcribe + cleanup, return the
//! text over IPC. NO injection, NO history/stats, NO synapse, NO long-form.

use tauri::{AppHandle, Manager};

use crate::commands::AppState;
use crate::events::{emit_state, EngineState};
use crate::transcribe::{self, EngineError};

/// Stop the running recording and return the (cleaned) transcript. Recording is
/// started via the regular `start_recording` command; the captured target window
/// is discarded — the intro displays the text itself.
#[tauri::command]
pub fn transcribe_preview(app: AppHandle) -> Result<String, EngineError> {
    let state = app.state::<AppState>();
    // Session over — clear the re-entry guard, drop any captured target.
    state
        .session_active
        .store(false, std::sync::atomic::Ordering::SeqCst);
    *state.target.lock() = None;

    let cap = match state.recorder.stop() {
        Some(c) => c,
        None => return Err(EngineError::new("no_recording", "keine aktive Aufnahme")),
    };
    if cap.samples.is_empty() {
        emit_state(&app, EngineState::Idle, None);
        return Err(EngineError::new("empty", "leere Aufnahme"));
    }

    emit_state(&app, EngineState::Transcribing, None);

    if state.config.lock().mode == "subunit" {
        crate::auth::ensure_fresh(&app);
    }
    let cfg = state.config.lock().clone();

    // A first dictation is seconds long — no long-form, no auto-mode; just the
    // configured style with the combined transcribe+cleanup round trip.
    let style = cfg.cleanup_style.clone();
    let inline_cleanup = cfg.cleanup_enabled && style != "raw";

    log::info!(
        "intro preview: mode={} samples={} inline_cleanup={inline_cleanup}",
        cfg.mode,
        cap.samples.len()
    );
    let result = match transcribe::run_opts(
        &cfg,
        &cap.samples,
        cap.sample_rate,
        false,
        inline_cleanup.then_some(style.as_str()),
    ) {
        Ok(r) => r,
        Err(e) => {
            emit_state(&app, EngineState::Error, Some(e.message.clone()));
            return Err(e);
        }
    };

    let mut text = match result.cleaned_text {
        Some(cleaned) if !cleaned.trim().is_empty() => cleaned,
        _ if inline_cleanup => crate::cleanup::maybe_cleanup(&cfg, &result.text, &style),
        _ => result.text,
    };
    if cfg.dach_format_enabled {
        text = crate::dach::dach_format(&text);
    }

    if text.trim().is_empty() {
        emit_state(&app, EngineState::Idle, None);
        return Err(EngineError::new("empty", "Keine Sprache erkannt"));
    }

    emit_state(&app, EngineState::Done, None);
    Ok(text)
}
