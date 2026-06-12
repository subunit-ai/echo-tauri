//! First-run intro support: the live first-dictation preview.
//!
//! The finale of the intro lets the user hold their hotkey and speak — but the
//! normal pipeline ([`crate::commands::do_transcribe`]) injects the transcript
//! into the focused window, which during the intro is Echo itself. This module
//! provides the minimal slice instead: stop + transcribe + cleanup, return the
//! text over IPC. NO injection, NO history/stats, NO synapse, NO long-form.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Manager};

use crate::commands::AppState;
use crate::events::{emit_state, EngineState};
use crate::transcribe::{self, EngineError};

/// Generation counter for the live-partial stream: bumping it invalidates any
/// running stream loop (start bumps + spawns with the new value; stop and
/// `transcribe_preview` just bump). No JoinHandle bookkeeping needed.
static STREAM_GEN: AtomicU64 = AtomicU64::new(0);

/// Stop the running recording and return the (cleaned) transcript. Recording is
/// started via the regular `start_recording` command; the captured target window
/// is discarded — the intro displays the text itself.
#[tauri::command]
pub fn transcribe_preview(app: AppHandle) -> Result<String, EngineError> {
    STREAM_GEN.fetch_add(1, Ordering::SeqCst); // end any live-partial loop
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

/// Begin streaming live partials for the running intro recording: the growing
/// capture buffer is re-transcribed (raw, no cleanup) whenever enough fresh
/// audio accumulated, and each partial is emitted as `echo://intro-partial`.
/// Cheap "streaming" without a server-side streaming endpoint — good enough
/// for the seconds-long first dictation; the released-key path still delivers
/// the cleaned final transcript via [`transcribe_preview`].
#[tauri::command]
pub fn intro_stream_start(app: AppHandle) {
    let gen = STREAM_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || stream_loop(app, gen));
}

#[tauri::command]
pub fn intro_stream_stop() {
    STREAM_GEN.fetch_add(1, Ordering::SeqCst);
}

fn stream_loop(app: AppHandle, gen: u64) {
    use tauri::Emitter;
    let state = app.state::<AppState>();

    if state.config.lock().mode == "subunit" {
        crate::auth::ensure_fresh(&app);
    }
    let cfg = state.config.lock().clone();
    if cfg.mode == "local" {
        // Never download mid-intro; without the model on disk there is no live
        // preview — the finale still gets the (error) result on release.
        let on_disk = std::fs::metadata(crate::models::model_path(&cfg.local_model))
            .map(|m| m.len() > 1_000_000)
            .unwrap_or(false);
        if !on_disk {
            log::info!("intro stream: local model not on disk — no live partials");
            return;
        }
    }

    const MIN_TOTAL_S: f64 = 0.8; // first partial needs a hearable chunk
    const MIN_NEW_S: f64 = 0.6; // re-transcribe only with enough fresh audio
    let mut last_len = 0usize;
    let mut failures = 0u32;

    loop {
        if STREAM_GEN.load(Ordering::SeqCst) != gen || !state.recorder.is_recording() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
        let Some(cap) = state.recorder.snapshot() else {
            continue;
        };
        let sr = cap.sample_rate.max(1) as f64;
        let total_s = cap.samples.len() as f64 / sr;
        let new_s = cap.samples.len().saturating_sub(last_len) as f64 / sr;
        if total_s < MIN_TOTAL_S || new_s < MIN_NEW_S {
            continue;
        }
        last_len = cap.samples.len();
        // Raw partial, no cleanup — speed is the point. The blocking call also
        // paces the loop: the next snapshot happens only after this returns.
        match transcribe::run_opts(&cfg, &cap.samples, cap.sample_rate, false, None) {
            Ok(r) => {
                failures = 0;
                if STREAM_GEN.load(Ordering::SeqCst) != gen {
                    return; // released mid-flight — the final result owns the card
                }
                let _ = app.emit("echo://intro-partial", r.text);
            }
            Err(e) => {
                failures += 1;
                log::warn!("intro stream: partial failed ({}): {}", e.code, e.message);
                if failures >= 2 {
                    return; // don't hammer a broken path; final transcribe reports
                }
            }
        }
    }
}
