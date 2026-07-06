//! Notes / voice memos — the Desktop half of Echo's cross-device notes.
//!
//! Same data foundation as the Echo iOS app: notes live local-first in the
//! SQLite store (`store::*_note*`), partitioned per account, and sync byte-for-
//! byte compatibly with the iPhone via [`crate::notes_sync`] against
//! `/v1/notes/sync`. A note's `payload` is the opaque iOS `Note` JSON (id,
//! createdAt, title, rawText, cleanedText, duration, tags, folderId/folderName,
//! …); the Desktop app parses/builds that JSON on the frontend (`lib/notes.ts`)
//! so the two representations (ISO8601 dates in the payload, epoch-SECONDS on the
//! envelope) stay identical to the iPhone. This module just persists the opaque
//! payload + drives the record→transcribe path that produces a note's text.
//!
//! Folder membership rides denormalized inside the note payload; folder cosmetics
//! (icon/colour) are device-local (`store::*_note_folder`) and never sync.

use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::commands::AppState;
use crate::transcribe::{self, EngineError};

/// Unix epoch SECONDS — the unit the notes sync + the iPhone use for `updated_at`
/// (NB: orb profiles use ms; notes deliberately use seconds for iOS parity).
fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ── Note CRUD (payload is opaque — the frontend owns the iOS-compatible shape) ──

/// All of the current account's notes (newest-first), `{id,name,payload,updated_at}`.
#[tauri::command]
pub fn list_notes(state: State<'_, AppState>) -> Vec<Value> {
    let account = crate::presets::account_key(&state.config.lock());
    crate::store::list_notes(&account)
}

/// Create or update a note. The frontend passes the whole iOS-compatible `payload`
/// (with ISO8601 dates + a UUID id) plus its `updated_at` in epoch SECONDS, so the
/// two date encodings stay consistent with the iPhone. Stored dirty → next sync
/// pushes it. Works signed-out too (stays on-device; the sync kick is a no-op).
#[tauri::command]
pub fn save_note(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
    payload: Value,
    updated_at: i64,
) -> Result<String, String> {
    if id.trim().is_empty() {
        return Err("empty id".into());
    }
    let account = crate::presets::account_key(&state.config.lock());
    let ts = if updated_at > 0 { updated_at } else { now_secs() };
    crate::store::upsert_note(&account, &id, name.trim(), &payload.to_string(), ts, true);
    crate::notes_sync::kick(&app);
    Ok(id)
}

/// Delete a note (soft-delete → the tombstone syncs so the iPhone drops it too).
#[tauri::command]
pub fn delete_note(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let account = crate::presets::account_key(&state.config.lock());
    crate::store::soft_delete_note(&account, &id, now_secs());
    crate::notes_sync::kick(&app);
    Ok(())
}

/// Force a notes sync now (frontend calls this on mount + on window focus, mirroring
/// the iPhone's launch/foreground triggers). Best-effort, never blocks.
#[tauri::command]
pub fn notes_sync_now(app: AppHandle) -> Result<(), String> {
    crate::notes_sync::kick(&app);
    Ok(())
}

// ── Folder cosmetics (device-local: icon + colour; membership syncs via notes) ──

/// The current account's folders (icon/colour/sort), `{id,name,icon,color,sort_order,updated_at}`.
#[tauri::command]
pub fn list_note_folders(state: State<'_, AppState>) -> Vec<Value> {
    let account = crate::presets::account_key(&state.config.lock());
    crate::store::list_note_folders(&account)
}

/// Create or update a folder's cosmetics. Returns the id.
#[tauri::command]
pub fn save_note_folder(
    state: State<'_, AppState>,
    id: String,
    name: String,
    icon: String,
    color: String,
    sort_order: i64,
) -> Result<String, String> {
    if id.trim().is_empty() {
        return Err("empty id".into());
    }
    let account = crate::presets::account_key(&state.config.lock());
    crate::store::upsert_note_folder(
        &account,
        &id,
        name.trim(),
        icon.trim(),
        color.trim(),
        sort_order,
        now_secs(),
    );
    Ok(id)
}

/// Forget a folder's cosmetics. The notes in it are unfiled separately (frontend
/// re-saves each note without a folder), so no note data is lost.
#[tauri::command]
pub fn delete_note_folder(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let account = crate::presets::account_key(&state.config.lock());
    crate::store::delete_note_folder(&account, &id);
    Ok(())
}

// ── Recording a voice note (reuses the proven recorder + transcribe core, but
//    delivers the TEXT to the Notes UI instead of pasting into a target window) ──

/// The transcription result the Notes UI turns into a note. Raw + optional cleaned
/// text, like the iPhone (rawText always present; cleanedText preferred for display).
#[derive(serde::Serialize, Default)]
pub struct NoteTranscript {
    pub raw_text: String,
    pub cleaned_text: Option<String>,
    pub language: Option<String>,
    pub duration_s: f64,
    pub quality_mode: String,
}

/// Begin capturing a voice note. Mutually exclusive with hotkey dictation (shares
/// the single recorder + the `session_active` guard). No target window, no
/// streaming — a self-contained batch take whose text we hand back on stop.
#[tauri::command]
pub fn note_record_start(state: State<'_, AppState>) -> Result<(), String> {
    // Already recording (dictation or another note take)? Refuse rather than
    // hijack the running capture.
    if state.session_active.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let (dev, sound, vol, start_id) = {
        let c = state.config.lock();
        (
            c.mic_device_name.clone(),
            c.sound_start_enabled,
            c.sound_volume,
            c.sound_start_id.clone(),
        )
    };
    if let Err(msg) = state
        .recorder
        .start(if dev.is_empty() { None } else { Some(dev) })
    {
        state.session_active.store(false, Ordering::SeqCst); // never strand the guard
        return Err(msg);
    }
    // Same instant native record-start cue as dictation (in-sheet UI shows its own
    // orb via `note_record_level`, so we deliberately DON'T raise the global engine
    // state — the floating overlay orb stays out of an in-app note recording).
    if sound && start_id == "standard" {
        crate::sound::play_start(vol);
    }
    Ok(())
}

/// Current mic level (0..1) for the in-sheet recording meter. Polled while recording.
#[tauri::command]
pub fn note_record_level(state: State<'_, AppState>) -> f32 {
    state.recorder.level()
}

/// Abort the current note recording, discarding the audio.
#[tauri::command]
pub fn note_record_cancel(state: State<'_, AppState>) {
    state.session_active.store(false, Ordering::SeqCst);
    let _ = state.recorder.stop();
}

/// Stop + transcribe the note. Blocking (network) — the frontend awaits it. Runs
/// the same engine as dictation (`transcribe::run_opts`, cloud/local per config,
/// inline cleanup when enabled) but returns the text instead of pasting it.
#[tauri::command]
pub fn note_record_stop(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<NoteTranscript, EngineError> {
    // Stop + take the capture while STILL holding the session guard, so a racing
    // hotkey dictation can't grab the shared recorder mid-teardown (do_start gates
    // on session_active). Release the guard only once the mic is ours-and-stopped.
    let cap_result = state.recorder.stop();
    state.session_active.store(false, Ordering::SeqCst);
    let cap = match cap_result {
        Some(c) if !c.samples.is_empty() => c,
        Some(_) => return Err(EngineError::new("empty", "leere Aufnahme")),
        None => return Err(EngineError::new("no_recording", "keine aktive Aufnahme")),
    };
    let duration_s = cap.samples.len() as f64 / cap.sample_rate.max(1) as f64;

    // Cloud path: refresh the token before we call out (same as do_transcribe).
    if state.config.lock().mode == "subunit" {
        crate::auth::ensure_fresh(&app);
    }
    let cfg = state.config.lock().clone();

    // Cleanup style for a note: the user's configured style (Auto-Mode is a
    // dictation-window concept — a note has no target window — so we use the plain
    // configured style). "raw" or cleanup disabled → keep only the raw transcript.
    let style = if cfg.cleanup_enabled && cfg.cleanup_style != "raw" {
        cfg.cleanup_style.clone()
    } else {
        "raw".to_string()
    };
    let inline = if style != "raw" { Some(style.as_str()) } else { None };

    let r = transcribe::run_opts(&cfg, &cap.samples, cap.sample_rate, false, inline)?;

    if r.text.trim().is_empty() {
        return Err(EngineError::new(
            "empty",
            "Keine Sprache erkannt – Mikrofon prüfen?",
        ));
    }

    // Prefer the server's inline cleanup; fall back to a separate /v1/cleanup call
    // only when it wasn't already run and cleanup is actually wanted + available.
    let cleaned = match r.cleaned_text.clone() {
        Some(c) if !c.trim().is_empty() && c.trim() != r.text.trim() => Some(c),
        _ if style != "raw"
            && r.cleanup_status.as_deref() != Some("unavailable")
            && r.quality_mode != "local-fallback" =>
        {
            let c = crate::cleanup::maybe_cleanup(&cfg, &r.text, &style);
            (c.trim() != r.text.trim() && !c.trim().is_empty()).then_some(c)
        }
        _ => None,
    };

    let language = {
        let l = cfg.language.trim();
        (!l.is_empty() && l != "auto").then(|| l.to_string())
    };

    // Note recording doesn't touch dictation history or paste anywhere — the UI
    // saves the returned text as a note (which then syncs to the iPhone).
    Ok(NoteTranscript {
        raw_text: r.text,
        cleaned_text: cleaned,
        language,
        duration_s,
        quality_mode: r.quality_mode,
    })
}
