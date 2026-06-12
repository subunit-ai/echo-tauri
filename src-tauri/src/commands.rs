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
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, State};

/// App-wide managed state.
pub struct AppState {
    pub config: Mutex<Config>,
    pub recorder: Recorder,
    /// Window captured at record-start, focused again before paste-back.
    pub target: Mutex<Option<Target>>,
    /// Guards the single overlay cursor hit-test loop (see [`crate::overlay`]).
    pub hit_test_active: std::sync::atomic::AtomicBool,
    /// Active meeting recording (mic + system loopback), None when not recording.
    pub meeting_capture: Mutex<Option<crate::meeting_capture::MeetingCapture>>,
    /// True while a record session is in progress. Set in [`do_start`], cleared
    /// SYNCHRONOUSLY in do_transcribe/do_cancel the instant the user finishes. The
    /// re-entry guard gates on THIS (not `recorder.is_recording()`) so a held hotkey
    /// (auto-repeat fires Pressed repeatedly) can't re-enter do_start mid-session.
    pub session_active: AtomicBool,
    /// "Konsole als Ziel"-Transkripte, die auf die Prompt-Konsole warten — die
    /// Webview bootet beim ersten Mal noch; sie drained die Queue beim Mount
    /// und auf jedes `echo://prompt-transcript`-Signal (nichts geht verloren).
    pub prompt_pending: Mutex<Vec<String>>,
    /// Aktives lokales Meeting (Pro-Feature, Cargo-Feature `local-meet`).
    #[cfg(feature = "local-meet")]
    pub meet_local: Mutex<Option<crate::meet_local::engine::EngineHandle>>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            config: Mutex::new(config),
            recorder: Recorder::new(),
            target: Mutex::new(None),
            hit_test_active: std::sync::atomic::AtomicBool::new(false),
            meeting_capture: Mutex::new(None),
            session_active: AtomicBool::new(false),
            prompt_pending: Mutex::new(Vec::new()),
            #[cfg(feature = "local-meet")]
            meet_local: Mutex::new(None),
        }
    }
}

/// Blank secret fields before handing the config to the frontend — tokens/keys
/// never need to leave Rust, and a future XSS shouldn't be able to read them.
fn sanitized(mut c: Config) -> Config {
    c.subunit_access_token.clear();
    c.subunit_refresh_token.clear();
    c.subunit_api_key.clear();
    c
}

// ---- Shared engine helpers (called by commands AND the hotkey handler) ----

pub fn do_start(app: &AppHandle) {
    let state = app.state::<AppState>();

    // Already in a session? Then this is a re-entrant call — hold-mode fires Pressed
    // repeatedly on key auto-repeat. Leave the running recording untouched; without
    // this a held key would re-capture the target on every repeat. We gate on
    // session_active (set/cleared on the user's start/finish) rather than
    // recorder.is_recording() so the guard is set the instant the user presses.
    if state.session_active.swap(true, Ordering::SeqCst) {
        return;
    }

    let (dev, lock, mode, endpoint) = {
        let c = state.config.lock();
        (c.mic_device_name.clone(), c.target_lock, c.mode.clone(), c.subunit_endpoint.clone())
    };
    log::info!("do_start: target_lock={lock}");
    // Prewarm the pooled cloud connection NOW (record-start) so DNS+TCP+TLS is
    // done by the time the user stops talking — no handshake between "stop" and
    // the transcript. Detached + best-effort; only for the cloud engine.
    if mode == "subunit" {
        std::thread::spawn(move || crate::http::prewarm(&endpoint));
    }
    // ALWAYS capture the focused window — Auto-Mode picks the cleanup style
    // from it. Re-focusing on paste still happens only with target_lock on
    // (deliver() gates that internally).
    *state.target.lock() = Some(crate::inject::capture_active_window());
    // Wait for the recorder to actually open the mic. A failure here (no device /
    // busy / permission) must surface as an error — never a phantom "recording"
    // state where the user talks into nothing.
    if let Err(msg) = state
        .recorder
        .start(if dev.is_empty() { None } else { Some(dev) })
    {
        log::warn!("do_start: mic start failed: {msg}");
        *state.target.lock() = None;
        state.session_active.store(false, Ordering::SeqCst); // never strand the guard
        emit_state(app, EngineState::Error, Some(msg));
        return;
    }
    emit_state(app, EngineState::Recording, None);
}

pub fn do_cancel(app: &AppHandle) {
    let state = app.state::<AppState>();
    // The session is over — clear the re-entry guard so the next press is accepted.
    state.session_active.store(false, Ordering::SeqCst);
    let _ = state.recorder.stop();
    *state.target.lock() = None;
    emit_state(app, EngineState::Idle, None);
}

/// Stop + transcribe synchronously. Blocking (network), so the hotkey handler
/// calls this on a spawned thread; the IPC command calls it directly.
pub fn do_transcribe(app: &AppHandle) -> Result<TranscriptResult, EngineError> {
    let state = app.state::<AppState>();
    // The session is over — clear the re-entry guard so the next press is accepted.
    state.session_active.store(false, Ordering::SeqCst);
    let cap = match state.recorder.stop() {
        Some(c) => c,
        None => return Err(EngineError::new("no_recording", "keine aktive Aufnahme")),
    };
    if cap.samples.is_empty() {
        emit_state(app, EngineState::Idle, None);
        return Err(EngineError::new("empty", "leere Aufnahme"));
    }

    emit_state(app, EngineState::Transcribing, None);

    // Latency measurement system: t_total spans recorder-stop → text delivered.
    // Per-phase numbers (encode/stt from the engine, cleanup/inject here) are
    // logged as ONE greppable line and stored with the history entry, so we can
    // iterate on latency against real field data instead of feelings.
    let t_total = std::time::Instant::now();

    // Cloud path: refresh the access token if it's expired before we call out.
    if state.config.lock().mode == "subunit" {
        crate::auth::ensure_fresh(app);
    }
    let cfg = state.config.lock().clone();

    // Duration → long-form detection (Python parity: switch style + store separately).
    let duration_s = cap.samples.len() as f64 / cap.sample_rate.max(1) as f64;
    let is_long =
        cfg.long_form_threshold_seconds > 0 && duration_s >= cfg.long_form_threshold_seconds as f64;
    // Request timed segments only when we'll diarize this long-form recording.
    let want_segments = is_long && cfg.diarization_enabled;

    // The cleanup style (long-form > auto-mode > config) is known BEFORE we call
    // out — the target window was captured at record-start — so it can ride along
    // on the transcribe request (combined transcribe+cleanup, one round trip less).
    let (app_name, title) = {
        let t = state.target.lock();
        (
            t.as_ref().map(|t| t.app.clone()).unwrap_or_default(),
            t.as_ref().map(|t| t.title.clone()).unwrap_or_default(),
        )
    };
    let style = if is_long {
        cfg.long_form_cleanup_style.clone()
    } else if cfg.cleanup_auto_mode {
        let (style, source) = crate::auto_mode::pick_style(
            &app_name,
            &title,
            &cfg.auto_mode_overrides,
            &cfg.cleanup_style,
        );
        // App name only at info (titles can carry document names → debug).
        log::info!("auto-mode: style={style} source={source} app=\"{app_name}\"");
        style
    } else {
        cfg.cleanup_style.clone()
    };
    // Combined round trip only for normal dictation: long-form cleanup can take
    // up to 90 s server-side — that stays on the separate /v1/cleanup call so the
    // transcribe request can't blow its 120 s budget.
    let inline_cleanup = !is_long && cfg.cleanup_enabled && style != "raw";

    log::info!(
        "transcribe: mode={} duration={duration_s:.1}s long_form={is_long} want_segments={want_segments} inline_cleanup={inline_cleanup}",
        cfg.mode
    );
    let t_tx = std::time::Instant::now();
    let result = match transcribe::run_opts(
        &cfg,
        &cap.samples,
        cap.sample_rate,
        want_segments,
        inline_cleanup.then_some(style.as_str()),
    ) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("transcribe: failed ({}) after {:?}", e.code, t_tx.elapsed());
            emit_state(app, EngineState::Error, Some(e.message.clone()));
            return Err(e);
        }
    };
    log::info!(
        "transcribe: ok engine_mode={} chars={} server_cleanup={} (+{:?})",
        result.quality_mode,
        result.text.chars().count(),
        result.cleaned_text.is_some(),
        t_tx.elapsed()
    );

    // Target window (captured at record-start), consumed for the paste-back below.
    let target = state.target.lock().take();

    // Keep the timed segments for diarization (the reconstructed result below
    // drops them — the IPC payload stays lean).
    let segments = result.segments;

    // Post-process: prefer the server-side cleanup from the combined round trip;
    // fall back to the separate /v1/cleanup call (old server, local engine, or
    // long-form). Then DACH formatting. "raw" = passthrough. cleanup_ms times
    // only the separate call — the inline path already sits inside stt_ms.
    let t_cleanup = std::time::Instant::now();
    let mut text = match result.cleaned_text {
        Some(cleaned) if !cleaned.trim().is_empty() => cleaned,
        _ if cfg.cleanup_enabled && style != "raw" => {
            crate::cleanup::maybe_cleanup(&cfg, &result.text, &style)
        }
        _ => result.text,
    };
    if cfg.dach_format_enabled {
        text = crate::dach::dach_format(&text);
    }
    let cleanup_ms = t_cleanup.elapsed().as_millis() as u64;
    let result = TranscriptResult {
        text,
        quality_mode: result.quality_mode,
        segments: Vec::new(),
        cleaned_text: None,
        timings: result.timings,
    };

    // The recording had audio but transcribed to nothing (silence / a mic that
    // delivered no signal). Surface that clearly instead of a silent "Done" with
    // nothing pasted — otherwise a dead/muted mic looks exactly like "Echo stopped
    // working" (the empty-result streak we saw in the field). Skip delivery/history.
    if result.text.trim().is_empty() {
        log::info!("transcribe: empty transcript (no speech detected) — skipping delivery");
        emit_state(
            app,
            EngineState::Error,
            Some("Keine Sprache erkannt – Mikrofon prüfen?".into()),
        );
        return Ok(result);
    }

    // "Konsole als Ziel": the transcript belongs to the Prompt Console, not the
    // app behind. Still copy it so a manual paste works everywhere. Otherwise:
    // paste-back into the captured target window (clipboard + paste per config).
    let t_inject = std::time::Instant::now();
    if cfg.prompt_console_as_target {
        if let Err(e) = crate::inject::set_clipboard(&result.text) {
            log::warn!("clipboard failed: {e}");
        }
        crate::prompt_console::receive_transcript(app, &result.text);
    } else if let Err(e) = crate::inject::deliver(&result.text, &cfg, target.as_ref()) {
        log::warn!("inject failed: {e}");
    }
    let inject_ms = t_inject.elapsed().as_millis() as u64;

    // The one latency line we iterate against (counts only — never content).
    let total_ms = t_total.elapsed().as_millis() as u64;
    log::info!(
        "latency: total={total_ms}ms encode={}ms stt={}ms cleanup={cleanup_ms}ms inject={inject_ms}ms \
         tier={} style={style} audio={duration_s:.1}s chars={}",
        result.timings.encode_ms,
        result.timings.stt_ms,
        result.quality_mode,
        result.text.chars().count()
    );

    // Best-effort push to the Synapse knowledge base (detached so the up-to-5s
    // round-trip never delays the user). No-op unless synapse_save_enabled.
    if cfg.synapse_save_enabled && !result.text.trim().is_empty() {
        let (c, t, wt) = (cfg.clone(), result.text.clone(), title.clone());
        std::thread::spawn(move || crate::synapse::maybe_save(&c, &t, &wt));
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Stats (config) + history/meetings (SQLite store).
    let (history_enabled, history_size) = {
        let mut c = state.config.lock();
        c.total_transcriptions += 1;
        c.total_audio_seconds += duration_s;
        let _ = c.save();
        (c.history_enabled, c.history_size.max(0) as usize)
    };
    if history_enabled && !result.text.trim().is_empty() {
        let entry = serde_json::json!({
            "text": result.text,
            "quality_mode": result.quality_mode,
            "ts": now,
            // Latency breakdown + applied style — the History UI shows them and
            // we mine real-world numbers from them.
            "latency_ms": total_ms,
            "stt_ms": result.timings.stt_ms,
            "cleanup_ms": cleanup_ms,
            "style": style,
            "duration_s": duration_s,
        });
        crate::store::add_history(&entry, history_size);
        use tauri::Emitter;
        let _ = app.emit("echo://history-changed", ());
    }
    if is_long && !result.text.trim().is_empty() {
        crate::store::add_meeting(&serde_json::json!({
            "ts": now,
            "text": result.text,
            "quality_mode": result.quality_mode,
            "duration_s": duration_s as i64,
        }));
    }

    // Long-form diarization: detached (can take up to ~120s) so it never delays
    // "Done". On completion it tags the stored meeting (found by ts) with a
    // speaker-labelled transcript + signals the UI to refresh.
    if want_segments && !segments.is_empty() {
        use tauri::Emitter;
        if let Ok(wav) = transcribe::samples_to_wav(&cap.samples, cap.sample_rate) {
            let (app2, cfg2) = (app.clone(), cfg.clone());
            std::thread::spawn(move || {
                if let Some(speaker_text) =
                    crate::diarize::speaker_transcript(&cfg2, wav, &segments)
                {
                    crate::store::update_meeting_by_ts(now as i64, "speaker_text", &speaker_text);
                    let _ = app2.emit("echo://meetings-updated", ());
                }
            });
        }
    }

    emit_transcript(app, result.text.clone(), result.quality_mode.clone());
    // Done (and Error) settle back to Idle centrally in emit_state — so the overlay
    // idle behaviour re-engages and the orb never gets stuck on done-green/error-amber.
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
    config.vocab_regex_cache = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    config.build_vocab_regex_cache();

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
        // plan ist ein Server-Entitlement (auth.rs setzt es nach dem
        // Workspace-Fetch) — ein Frontend-Roundtrip darf es nie ändern,
        // sonst wäre das Pro-Gating lokal umgehbar.
        config.plan = cur.plan.clone();
        cur.hotkey != config.hotkey
            || cur.prompt_console_hotkey != config.prompt_console_hotkey
    };
    config.save().map_err(|e| e.to_string())?;
    *state.config.lock() = config;
    if hotkey_changed {
        crate::hotkey::reregister_from_config(&app);
    }
    // Live-apply overlay settings (show/hide, size, position, style/color/idle).
    crate::overlay::apply_config(&app);
    Ok(())
}

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Copy arbitrary text to the clipboard (History "Kopieren" action).
#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    crate::inject::set_clipboard(&text).map_err(|e| e.to_string())
}

/// Open the config/data folder (~/.config/echo) in the OS file manager.
#[tauri::command]
pub fn open_config_dir() {
    let dir = crate::config::config_dir();
    crate::meet::open_url(&dir.to_string_lossy());
}

/// Open an external URL in the default browser (About → GitHub link).
/// Only http(s) links are honoured — a frontend-supplied `file:`, `javascript:`
/// or custom-scheme value must not be able to invoke an arbitrary OS handler.
#[tauri::command]
pub fn open_external(url: String) {
    if !crate::meet::is_web_url(&url) {
        log::warn!("open_external: refusing non-web URL");
        return;
    }
    crate::meet::open_url(&url);
}

/// Delete one history entry by index (newest = 0), then persist.
#[tauri::command]
pub fn delete_history_entry(id: i64) {
    crate::store::delete_history(id);
}

/// Clear the whole transcription history.
#[tauri::command]
pub fn clear_history() {
    crate::store::clear_history();
}

/// Newest-first history page from the store. `query` = case-insensitive
/// substring search on the transcript text; empty = everything.
#[tauri::command]
pub fn history_list(query: Option<String>, limit: Option<u32>, offset: Option<u32>) -> Vec<serde_json::Value> {
    crate::store::list_history(
        query.as_deref().unwrap_or(""),
        limit.unwrap_or(200).min(1000),
        offset.unwrap_or(0),
    )
}

/// Total number of stored history entries (Home stat card).
#[tauri::command]
pub fn history_count() -> i64 {
    crate::store::count_history()
}

/// All stored meetings, newest first (each with its store `id`).
#[tauri::command]
pub fn meetings_list() -> Vec<serde_json::Value> {
    crate::store::list_meetings()
}

/// Persist a drag-set overlay position (logical screen px) as `custom-x-y` so
/// the orb reopens where the user dropped it. Called from the overlay on drag.
#[tauri::command]
pub fn set_orb_position(app: AppHandle, state: State<'_, AppState>, x: f64, y: f64) -> Result<(), String> {
    let cfg = {
        let mut c = state.config.lock();
        c.orb_position = format!("custom-{}-{}", x.round() as i64, y.round() as i64);
        c.clone()
    };
    cfg.save().map_err(|e| e.to_string())?;
    // A drag sets a custom position; let the main window's position UI catch up.
    {
        use tauri::Emitter;
        let _ = app.emit("echo://config-changed", ());
    }
    Ok(())
}

/// Current orb-satellite display state (UI mode / language / cleanup).
pub(crate) fn orb_quick_json(c: &Config) -> serde_json::Value {
    let mode = if c.mode == "local" { "local" } else { "cloud" };
    serde_json::json!({
        "mode": mode,
        "language": c.language,
        // off | auto (style follows the focused app) | a concrete style.
        "cleanup": if !c.cleanup_enabled {
            "off".to_string()
        } else if c.cleanup_auto_mode {
            "auto".to_string()
        } else {
            c.cleanup_style.clone()
        },
    })
}

/// Read the orb-satellite quick state without changing anything.
#[tauri::command]
pub fn orb_quick(state: State<'_, AppState>) -> serde_json::Value {
    orb_quick_json(&state.config.lock())
}

/// Cycle one orb satellite (`which` = "mode" | "language" | "cleanup"), persist,
/// and return the new quick state. The satellites are the orb's inline controls.
#[tauri::command]
pub fn orb_cycle(
    app: AppHandle,
    state: State<'_, AppState>,
    which: String,
) -> Result<serde_json::Value, String> {
    let cfg = {
        let mut c = state.config.lock();
        match which.as_str() {
            // local → cloud → local
            "mode" => {
                if c.mode == "local" {
                    c.mode = "subunit".to_string();
                    c.last_cloud_mode = "subunit".to_string();
                } else {
                    c.mode = "local".to_string();
                }
            }
            // de → en → auto → de
            "language" => {
                let order = ["de", "en", "auto"];
                let next = order
                    .iter()
                    .position(|x| *x == c.language)
                    .map(|i| (i + 1) % order.len())
                    .unwrap_or(0);
                c.language = order[next].to_string();
            }
            // off → prompt → email → slack → formal → off
            "cleanup" => {
                if !c.cleanup_enabled {
                    c.cleanup_enabled = true;
                    c.cleanup_style = "prompt".to_string();
                } else {
                    let order = ["prompt", "email", "slack", "formal"];
                    let idx = order.iter().position(|x| *x == c.cleanup_style).unwrap_or(0);
                    if idx + 1 >= order.len() {
                        c.cleanup_enabled = false;
                    } else {
                        c.cleanup_style = order[idx + 1].to_string();
                    }
                }
            }
            _ => {}
        }
        c.clone()
    };
    cfg.save().map_err(|e| e.to_string())?;
    // Mode change can flip the overlay's state colour mapping; keep it in sync.
    crate::overlay::apply_config(&app);
    // Tell the main window to refresh — an orb-satellite cycle changes
    // mode/language/cleanup, which its Settings/mode UI must reflect.
    {
        use tauri::Emitter;
        let _ = app.emit("echo://config-changed", ());
    }
    Ok(orb_quick_json(&cfg))
}

/// Set one orb satellite directly (`which` = "mode" | "language" | "cleanup",
/// `value` = the option key) — the expanded island panels pick a value instead
/// of cycling. Persists and returns the new quick state, mirroring `orb_cycle`'s
/// side effects (overlay restyle + main-window refresh).
#[tauri::command]
pub fn orb_set(
    app: AppHandle,
    state: State<'_, AppState>,
    which: String,
    value: String,
) -> Result<serde_json::Value, String> {
    let cfg = {
        let mut c = state.config.lock();
        match (which.as_str(), value.as_str()) {
            ("mode", "local") => {
                c.mode = "local".to_string();
            }
            ("mode", "cloud") => {
                if c.mode == "local" {
                    c.mode = "subunit".to_string();
                }
                c.last_cloud_mode = c.mode.clone();
            }
            ("language", "de") | ("language", "en") | ("language", "auto") => {
                c.language = value.clone();
            }
            ("cleanup", "off") => c.cleanup_enabled = false,
            // Auto-Mode: cleanup on, style picked per focused app/window.
            ("cleanup", "auto") => {
                c.cleanup_enabled = true;
                c.cleanup_auto_mode = true;
            }
            ("cleanup", "prompt") | ("cleanup", "email") | ("cleanup", "slack")
            | ("cleanup", "formal") => {
                c.cleanup_enabled = true;
                c.cleanup_auto_mode = false; // a concrete pick overrides Auto
                c.cleanup_style = value.clone();
            }
            _ => return Err(format!("unknown orb setting {which}={value}")),
        }
        c.clone()
    };
    cfg.save().map_err(|e| e.to_string())?;
    // Mode change can flip the overlay's state colour mapping; keep it in sync.
    crate::overlay::apply_config(&app);
    // Tell the main window to refresh — see orb_cycle.
    {
        use tauri::Emitter;
        let _ = app.emit("echo://config-changed", ());
    }
    Ok(orb_quick_json(&cfg))
}

#[tauri::command]
pub fn list_audio_devices() -> Vec<String> {
    crate::recorder::list_input_devices()
}

/// Hardware summary + recommended local model (shown in the model manager).
#[tauri::command]
pub fn hardware_info() -> crate::hardware::HardwareInfo {
    crate::hardware::detect()
}

/// Re-process a stored meeting's transcript with a cleanup style (summary,
/// action_items, decisions, minutes, recap_email, …) via /v1/cleanup. Returns
/// the styled text; the frontend shows it without overwriting the raw transcript.
/// Refreshes the cloud token first since meetings can sit for a while.
#[tauri::command]
pub fn process_meeting(app: AppHandle, id: i64, style: String) -> Result<String, String> {
    let state = app.state::<AppState>();
    let text = crate::store::meeting_text(id).ok_or_else(|| "meeting not found".to_string())?;
    if text.trim().is_empty() {
        return Err("empty transcript".to_string());
    }
    crate::auth::ensure_fresh(&app);
    let cfg = state.config.lock().clone();
    crate::cleanup::run_style(&cfg, &text, &style).map_err(|e| e.to_string())
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

/// Sign in via the browser OAuth loopback flow. `auth::login` blocks (it waits up
/// to 30 min for the loopback callback), so run it on a blocking thread instead of
/// the command/main thread — otherwise the whole UI freezes until the user
/// finishes (or the timeout fires).
#[tauri::command]
pub async fn login(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::auth::login(&app).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("login task: {e}"))?
}

/// Toggle launch-at-login: flip the OS autostart entry and persist the preference.
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())?;
    } else {
        mgr.disable().map_err(|e| e.to_string())?;
    }
    let state = app.state::<AppState>();
    let cfg = {
        let mut c = state.config.lock();
        c.autostart_enabled = enabled;
        c.clone()
    };
    cfg.save().map_err(|e| e.to_string())
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
    c.plan = "free".to_string(); // signed out → no entitlement
    c.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_local_models() -> Vec<crate::models::ModelInfo> {
    crate::models::list_models()
}

#[tauri::command]
pub async fn download_model(app: AppHandle, model: String) {
    // Progress streams via the echo://model-progress event.
    if let Err(e) = crate::models::download(&app, &model).await {
        use tauri::Emitter;
        let _ = app.emit(
            "echo://model-progress",
            serde_json::json!({ "model": model, "error": e.to_string() }),
        );
    }
}

#[tauri::command]
pub fn delete_local_model(model: String) -> Result<(), String> {
    crate::models::delete(&model).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn start_meeting(app: AppHandle) -> Result<crate::meet::MeetingInfo, String> {
    let cfg = app.state::<AppState>().config.lock().clone();
    let info = crate::meet::create_meeting(&cfg).map_err(|e| e.to_string())?;
    crate::meet::open_url(&info.share_url);
    Ok(info)
}

/// Fresh subunit access token for the embedded meet UI (the native "Meeting" view runs
/// the meet.subunit.ai React app in-app; it authenticates with this token instead of the
/// web SSO redirect). Refreshes first so the embed never gets a stale token. The token
/// stays inside Echo's own local webview — it is never sent to a remote origin.
#[tauri::command]
pub fn meet_token(app: AppHandle) -> String {
    crate::auth::ensure_fresh(&app);
    app.state::<AppState>().config.lock().subunit_access_token.clone()
}

/// Start a local dual-audio meeting recording: the mic (you) + the system loopback
/// (the remote Teams/Zoom/Meet participants). Triggered from the meeting-detect
/// prompt's "record". Windows-only (loopback); errors on other platforms.
#[tauri::command]
pub fn start_meeting_recording(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.meeting_capture.lock().is_some() {
        return Ok(()); // already recording — idempotent
    }
    let device = state.config.lock().mic_device_name.clone();
    let dev = if device.trim().is_empty() { None } else { Some(device) };
    let cap = crate::meeting_capture::MeetingCapture::start(dev)?;
    *state.meeting_capture.lock() = Some(cap);
    log::info!("meeting recording started (mic + system loopback)");
    Ok(())
}

/// Stop the meeting recording, mix mic+loopback, transcribe the mixed track, and
/// store it as a meeting. Returns the transcript text.
#[tauri::command]
pub fn stop_meeting_recording(app: AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    let state = app.state::<AppState>();
    let cap = state
        .meeting_capture
        .lock()
        .take()
        .ok_or_else(|| "keine Meeting-Aufnahme aktiv".to_string())?;
    let (mixed, sr) = cap.stop_and_mix();
    if mixed.is_empty() {
        return Err("Meeting-Aufnahme war leer".to_string());
    }
    let cfg = state.config.lock().clone();
    let duration_s = mixed.len() as f64 / sr.max(1) as f64;
    let result =
        transcribe::run_opts(&cfg, &mixed, sr, false, None).map_err(|e| format!("{e}"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if !result.text.trim().is_empty() {
        crate::store::add_meeting(&serde_json::json!({
            "ts": now,
            "text": result.text,
            "quality_mode": result.quality_mode,
            "duration_s": duration_s as i64,
        }));
    }
    let _ = app.emit("echo://meetings-updated", ());
    log::info!("meeting recording stopped + transcribed ({duration_s:.0}s)");
    Ok(result.text)
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

/// One-click update: re-check, download + install (silent on Windows via the
/// `installMode: passive` config), reporting progress on `echo://update-progress`,
/// then relaunch into the new version. No installer wizard, no manual steps.
/// Diverges via `app.restart()` on success, so it only *returns* `Ok(false)` when
/// there was nothing to install, or `Err` if download/install failed.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<bool, String> {
    use tauri::Emitter;
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = match updater.check().await.map_err(|e| e.to_string())? {
        Some(u) => u,
        None => return Ok(false), // already up to date
    };

    let app_dl = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let pct = match total {
                    Some(t) if t > 0 => (downloaded as f64 / t as f64) * 100.0,
                    _ => 0.0,
                };
                let _ = app_dl.emit("echo://update-progress", pct);
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    // Files are in place — relaunch into the new version (never returns).
    app.restart();
}

// ---- Lokales Meet-Backend (Pro-Feature, Cargo-Feature `local-meet`) ----
// Die Commands existieren in JEDEM Build (stabile IPC-Oberfläche für die UI);
// ohne das Feature antworten sie mit built=false bzw. einem klaren Fehler.

#[derive(serde::Serialize)]
pub struct MeetLocalAvailability {
    /// Binary enthält die lokale Pipeline (Cargo-Feature `local-meet`).
    pub built: bool,
    /// Workspace-Tier erlaubt das Pro-Feature.
    pub plan_ok: bool,
    /// Gerät ist stark genug (Apple Silicon oder ≥ 16 GB RAM).
    pub hw_ok: bool,
    /// Voiceprint-Modell schon heruntergeladen.
    pub speaker_model: bool,
    /// Es läuft gerade ein lokales Meeting.
    pub active: bool,
}

fn meet_local_plan_ok(plan: &str) -> bool {
    matches!(plan, "pro" | "enterprise" | "ops" | "pilot")
}

#[tauri::command]
pub fn meet_local_available(state: State<AppState>) -> MeetLocalAvailability {
    let plan_ok = meet_local_plan_ok(&state.config.lock().plan);
    let hw = crate::hardware::detect();
    let hw_ok = (cfg!(target_os = "macos") && cfg!(target_arch = "aarch64")) || hw.ram_gb >= 15.0;
    #[cfg(feature = "local-meet")]
    {
        MeetLocalAvailability {
            built: true,
            plan_ok,
            hw_ok,
            speaker_model: crate::meet_local::model_fetch::speaker_model_downloaded(),
            active: state.meet_local.lock().is_some(),
        }
    }
    #[cfg(not(feature = "local-meet"))]
    {
        MeetLocalAvailability { built: false, plan_ok, hw_ok, speaker_model: false, active: false }
    }
}

#[cfg(feature = "local-meet")]
#[tauri::command]
pub fn meet_local_start(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let (plan, mic, model, language) = {
        let c = state.config.lock();
        let lang = if c.language == "auto" || c.language.is_empty() {
            None
        } else {
            Some(c.language.clone())
        };
        (c.plan.clone(), c.mic_device_name.clone(), c.local_model.clone(), lang)
    };
    if !meet_local_plan_ok(&plan) {
        return Err("Lokale Meeting-Verarbeitung ist ein Pro-Feature.".into());
    }
    let mut slot = state.meet_local.lock();
    if let Some(h) = slot.as_ref() {
        if !h.is_finished() {
            return Err("Es läuft schon ein lokales Meeting.".into());
        }
    }
    let mic = if mic.is_empty() { None } else { Some(mic) };
    *slot = Some(crate::meet_local::engine::start(app, mic, model, language)?);
    Ok(())
}

#[cfg(feature = "local-meet")]
#[tauri::command]
pub fn meet_local_add_participant(state: State<AppState>, name: String) -> Result<String, String> {
    state.meet_local.lock().as_ref().ok_or("Kein lokales Meeting aktiv")?.add_participant(name)
}

#[cfg(feature = "local-meet")]
#[tauri::command]
pub fn meet_local_checkin(state: State<AppState>, name: String) -> Result<(), String> {
    state.meet_local.lock().as_ref().ok_or("Kein lokales Meeting aktiv")?.start_checkin(name)
}

#[cfg(feature = "local-meet")]
#[tauri::command]
pub fn meet_local_status(
    state: State<AppState>,
) -> Option<crate::meet_local::engine::Snapshot> {
    state.meet_local.lock().as_ref().map(|h| h.snapshot())
}

#[cfg(feature = "local-meet")]
#[tauri::command]
pub fn meet_local_stop(state: State<AppState>) -> Result<(), String> {
    state.meet_local.lock().as_ref().ok_or("Kein lokales Meeting aktiv")?.stop();
    Ok(())
}

/// Fertiges/abgebrochenes Meeting aus dem Slot räumen (UI: „Schließen").
#[cfg(feature = "local-meet")]
#[tauri::command]
pub fn meet_local_dismiss(state: State<AppState>) {
    let mut slot = state.meet_local.lock();
    if slot.as_ref().map(|h| h.is_finished()).unwrap_or(false) {
        *slot = None;
    }
}

#[cfg(feature = "local-meet")]
#[tauri::command]
pub fn meet_local_list() -> Vec<serde_json::Value> {
    let dir = crate::meet_local::engine::meetings_dir();
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if let Ok(raw) = std::fs::read(e.path().join("meeting.json")) {
                if let Ok(mut v) = serde_json::from_slice::<serde_json::Value>(&raw) {
                    if let Some(o) = v.as_object_mut() {
                        o.remove("segments"); // Liste bleibt leichtgewichtig
                    }
                    out.push(v);
                }
            }
        }
    }
    out.sort_by_key(|v| std::cmp::Reverse(v["started_at"].as_u64().unwrap_or(0)));
    out
}

#[cfg(feature = "local-meet")]
#[tauri::command]
pub fn meet_local_get(id: String) -> Result<serde_json::Value, String> {
    // id ist von uns generiert ("local-<ts>") — trotzdem gegen Traversal härten
    if id.contains(['/', '\\', '.']) {
        return Err("Ungültige Meeting-ID".into());
    }
    let dir = crate::meet_local::engine::meetings_dir().join(&id);
    let meeting: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.join("meeting.json")).map_err(|_| "Meeting nicht gefunden")?,
    )
    .map_err(|_| "Meeting-Datei kaputt")?;
    let transcript = std::fs::read_to_string(dir.join("transcript.md")).unwrap_or_default();
    Ok(serde_json::json!({ "meeting": meeting, "transcript": transcript }))
}

// Stub-Varianten für Builds ohne `local-meet` — gleiche Command-Namen, damit
// die UI EINEN Codepfad hat und auf `built:false` reagieren kann.
#[cfg(not(feature = "local-meet"))]
mod meet_local_stubs {
    const NOT_BUILT: &str = "Dieses Build enthält das lokale Meet-Backend nicht.";

    #[tauri::command]
    pub fn meet_local_start() -> Result<(), String> {
        Err(NOT_BUILT.into())
    }
    #[tauri::command]
    pub fn meet_local_add_participant(_name: String) -> Result<String, String> {
        Err(NOT_BUILT.into())
    }
    #[tauri::command]
    pub fn meet_local_checkin(_name: String) -> Result<(), String> {
        Err(NOT_BUILT.into())
    }
    #[tauri::command]
    pub fn meet_local_status() -> Option<serde_json::Value> {
        None
    }
    #[tauri::command]
    pub fn meet_local_stop() -> Result<(), String> {
        Err(NOT_BUILT.into())
    }
    #[tauri::command]
    pub fn meet_local_dismiss() {}
    #[tauri::command]
    pub fn meet_local_list() -> Vec<serde_json::Value> {
        Vec::new()
    }
    #[tauri::command]
    pub fn meet_local_get(_id: String) -> Result<serde_json::Value, String> {
        Err(NOT_BUILT.into())
    }
}
#[cfg(not(feature = "local-meet"))]
pub use meet_local_stubs::*;
