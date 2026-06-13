//! First-run intro support: the live first-dictation preview.
//!
//! The finale of the intro lets the user hold their hotkey and speak — but the
//! normal pipeline ([`crate::commands::do_transcribe`]) injects the transcript
//! into the focused window, which during the intro is Echo itself. This module
//! provides the preview slice instead: live partials via the streaming engine
//! ([`crate::transcribe::stream`], WS `/v1/dictate`) while the key is held,
//! then the cleaned final over IPC. NO injection, NO history/stats, NO synapse.
//!
//! The streaming engine is generic — the intro is merely its first consumer;
//! the main dictation pipeline taps the same `echo://stream-partial` events
//! next (stable-prefix live typing).

use tauri::{AppHandle, Manager};

use crate::commands::AppState;
use crate::events::{emit_state, EngineState};
use crate::recorder::Capture;
use crate::transcribe::{self, stream, EngineError};

/// Stop the running recording and return the (cleaned) transcript.
///
/// Streamed path: the audio already lives server-side — `stream::finish()`
/// flushes the tail and returns the server's final without re-uploading.
/// Classic path (stream unavailable / failed / local mode): one-shot upload of
/// the capture, exactly like before. Streaming accelerates; it never gates.
#[tauri::command]
pub fn transcribe_preview(app: AppHandle) -> Result<String, EngineError> {
    let state = app.state::<AppState>();
    // Session over — clear the re-entry guard, drop any captured target.
    state
        .session_active
        .store(false, std::sync::atomic::Ordering::SeqCst);
    *state.target.lock() = None;

    emit_state(&app, EngineState::Transcribing, None);

    let cfg = state.config.lock().clone();
    let style = cfg.cleanup_style.clone();
    let inline_cleanup = cfg.cleanup_enabled && style != "raw";

    // ── Streamed path ────────────────────────────────────────────────────
    let mut fallback_capture: Option<Capture> = None;
    match stream::finish() {
        Some(Ok(fin)) => {
            log::info!(
                "intro preview: streamed final ({} chars, cleaned={}, tier={})",
                fin.text.chars().count(),
                fin.cleaned_text.is_some(),
                fin.quality_mode
            );
            let mut text = match fin.cleaned_text {
                Some(c) if !c.trim().is_empty() => c,
                _ if inline_cleanup => crate::cleanup::maybe_cleanup(&cfg, &fin.text, &style),
                _ => fin.text,
            };
            if cfg.dach_format_enabled {
                text = crate::dach::dach_format(&text);
            }
            if text.trim().is_empty() {
                emit_state(&app, EngineState::Idle, None);
                return Err(EngineError::new("empty", "Keine Sprache erkannt"));
            }
            emit_state(&app, EngineState::Done, None);
            return Ok(text);
        }
        Some(Err(fail)) => {
            // The stream owned the recording when it died — it hands the
            // capture back so the classic upload below loses nothing.
            log::warn!(
                "intro preview: stream failed ({}: {}) — classic fallback",
                fail.error.code,
                fail.error.message
            );
            fallback_capture = fail.capture;
        }
        None => {} // no stream ran (local mode / never started)
    }

    // ── Classic path ─────────────────────────────────────────────────────
    let cap = match fallback_capture.or_else(|| state.recorder.stop()) {
        Some(c) => c,
        None => {
            emit_state(&app, EngineState::Idle, None);
            return Err(EngineError::new("no_recording", "keine aktive Aufnahme"));
        }
    };
    if cap.samples.is_empty() {
        emit_state(&app, EngineState::Idle, None);
        return Err(EngineError::new("empty", "leere Aufnahme"));
    }

    if cfg.mode == "subunit" {
        crate::auth::ensure_fresh(&app);
    }

    log::info!(
        "intro preview: classic mode={} samples={} inline_cleanup={inline_cleanup}",
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

/// Begin live partials for the running intro recording (cloud: WS streaming
/// to `/v1/dictate`; local mode: no-op — release still delivers the final).
#[tauri::command]
pub fn intro_stream_start(app: AppHandle) {
    // Intro shows partials on-screen only (the "target" is Echo itself) — it must
    // never live-type into a window. Always non-live; the release final lands via IPC.
    stream::start(&app, false);
}

/// Drop the stream without a final (scene unmounted, hold aborted).
#[tauri::command]
pub fn intro_stream_stop() {
    stream::cancel();
}
