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
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

/// App-wide managed state.
pub struct AppState {
    pub config: Mutex<Config>,
    pub recorder: Recorder,
    /// Window captured at record-start, focused again before paste-back.
    pub target: Mutex<Option<Target>>,
    /// Live-dictation control signal while streaming (None = not streaming).
    /// See [`crate::live_ws`]: RUN / FINISH / CANCEL.
    pub streaming: Mutex<Option<Arc<AtomicU8>>>,
    /// Guards the single overlay cursor hit-test loop (see [`crate::overlay`]).
    pub hit_test_active: std::sync::atomic::AtomicBool,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            config: Mutex::new(config),
            recorder: Recorder::new(),
            target: Mutex::new(None),
            streaming: Mutex::new(None),
            hit_test_active: std::sync::atomic::AtomicBool::new(false),
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
    let (dev, lock, live) = {
        let c = state.config.lock();
        (c.mic_device_name.clone(), c.target_lock, c.live_type)
    };
    // Live dictation always needs the target so segments type into the right
    // window, even if target_lock is off.
    if lock || live {
        *state.target.lock() = Some(crate::inject::capture_active_window());
    }
    // Wait for the recorder to actually open the mic. A failure here (no device /
    // busy / permission) must surface as an error — never a phantom "recording"
    // state where the user talks into nothing.
    if let Err(msg) = state
        .recorder
        .start(if dev.is_empty() { None } else { Some(dev) })
    {
        log::warn!("do_start: mic start failed: {msg}");
        *state.target.lock() = None;
        emit_state(app, EngineState::Error, Some(msg));
        return;
    }
    emit_state(app, EngineState::Recording, None);

    if live {
        let sig = Arc::new(AtomicU8::new(crate::live_ws::RUN));
        *state.streaming.lock() = Some(sig.clone());
        crate::live_ws::spawn(app.clone(), sig);
    }
}

pub fn do_cancel(app: &AppHandle) {
    let state = app.state::<AppState>();
    // Live: tell the controller to discard + stop (it clears target + emits Idle).
    if let Some(sig) = state.streaming.lock().take() {
        sig.store(crate::live_ws::CANCEL, Ordering::Relaxed);
        return;
    }
    let _ = state.recorder.stop();
    *state.target.lock() = None;
    emit_state(app, EngineState::Idle, None);
}

/// Stop + transcribe synchronously. Blocking (network), so the hotkey handler
/// calls this on a spawned thread; the IPC command calls it directly.
pub fn do_transcribe(app: &AppHandle) -> Result<TranscriptResult, EngineError> {
    let state = app.state::<AppState>();
    // Live dictation: segments were already typed as you spoke. Just tell the
    // controller to flush the final segment + stop (it emits Done) — don't
    // stop()/transcribe() here or we'd race its non-draining snapshots.
    if let Some(sig) = state.streaming.lock().take() {
        sig.store(crate::live_ws::FINISH, Ordering::Relaxed);
        return Ok(TranscriptResult {
            text: String::new(),
            quality_mode: "live".to_string(),
            segments: Vec::new(),
        });
    }
    let cap = match state.recorder.stop() {
        Some(c) => c,
        None => return Err(EngineError::new("no_recording", "keine aktive Aufnahme")),
    };
    if cap.samples.is_empty() {
        emit_state(app, EngineState::Idle, None);
        return Err(EngineError::new("empty", "leere Aufnahme"));
    }

    emit_state(app, EngineState::Transcribing, None);

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

    log::info!(
        "transcribe: mode={} duration={duration_s:.1}s long_form={is_long} want_segments={want_segments}",
        cfg.mode
    );
    let t_tx = std::time::Instant::now();
    let result = match transcribe::run_opts(&cfg, &cap.samples, cap.sample_rate, want_segments) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("transcribe: failed ({}) after {:?}", e.code, t_tx.elapsed());
            emit_state(app, EngineState::Error, Some(e.message.clone()));
            return Err(e);
        }
    };
    log::info!(
        "transcribe: ok engine_mode={} chars={} (+{:?})",
        result.quality_mode,
        result.text.chars().count(),
        t_tx.elapsed()
    );

    // Target window (captured at record-start) + style (long-form > auto-mode > config).
    let target = state.target.lock().take();
    let title = target.as_ref().map(|t| t.title.clone()).unwrap_or_default();
    let style = if is_long {
        cfg.long_form_cleanup_style.clone()
    } else if cfg.cleanup_auto_mode {
        crate::auto_mode::pick_style(&title, &cfg.auto_mode_overrides, &cfg.cleanup_style)
    } else {
        cfg.cleanup_style.clone()
    };

    // Keep the timed segments for diarization (the reconstructed result below
    // drops them — the IPC payload stays lean).
    let segments = result.segments;

    // Post-process: optional server AI-cleanup ("raw" = passthrough) + DACH formatting.
    let mut text = result.text;
    if cfg.cleanup_enabled && style != "raw" {
        text = crate::cleanup::maybe_cleanup(&cfg, &text, &style);
    }
    if cfg.dach_format_enabled {
        text = crate::dach::dach_format(&text);
    }
    let result = TranscriptResult {
        text,
        quality_mode: result.quality_mode,
        segments: Vec::new(),
    };

    // Paste-back into the captured target window (clipboard + paste per config).
    if let Err(e) = crate::inject::deliver(&result.text, &cfg, target.as_ref()) {
        log::warn!("inject failed: {e}");
    }

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

    // Stats + history.
    {
        let mut c = state.config.lock();
        c.total_transcriptions += 1;
        c.total_audio_seconds += duration_s;
        if c.history_enabled && !result.text.trim().is_empty() {
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
        if is_long && !result.text.trim().is_empty() {
            let m = serde_json::json!({
                "ts": now,
                "text": result.text,
                "quality_mode": result.quality_mode,
                "duration_s": duration_s as i64,
            });
            c.meetings.insert(0, m);
            if c.meetings.len() > 100 {
                c.meetings.truncate(100);
            }
        }
        let _ = c.save();
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
                    let state = app2.state::<AppState>();
                    {
                        let mut c = state.config.lock();
                        if let Some(m) = c
                            .meetings
                            .iter_mut()
                            .find(|m| m.get("ts").and_then(|v| v.as_u64()) == Some(now))
                        {
                            if let Some(obj) = m.as_object_mut() {
                                obj.insert("speaker_text".into(), serde_json::json!(speaker_text));
                            }
                        }
                        let _ = c.save();
                    }
                    let _ = app2.emit("echo://meetings-updated", ());
                }
            });
        }
    }

    emit_transcript(app, result.text.clone(), result.quality_mode.clone());
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
        cur.hotkey != config.hotkey
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
#[tauri::command]
pub fn open_external(url: String) {
    crate::meet::open_url(&url);
}

/// Delete one history entry by index (newest = 0), then persist.
#[tauri::command]
pub fn delete_history_entry(state: State<'_, AppState>, index: usize) -> Result<(), String> {
    let cfg = {
        let mut c = state.config.lock();
        if index < c.history.len() {
            c.history.remove(index);
        }
        c.clone()
    };
    cfg.save().map_err(|e| e.to_string())
}

/// Clear the whole transcription history, then persist.
#[tauri::command]
pub fn clear_history(state: State<'_, AppState>) -> Result<(), String> {
    let cfg = {
        let mut c = state.config.lock();
        c.history.clear();
        c.clone()
    };
    cfg.save().map_err(|e| e.to_string())
}

/// Persist a drag-set overlay position (logical screen px) as `custom-x-y` so
/// the orb reopens where the user dropped it. Called from the overlay on drag.
#[tauri::command]
pub fn set_orb_position(state: State<'_, AppState>, x: f64, y: f64) -> Result<(), String> {
    let cfg = {
        let mut c = state.config.lock();
        c.orb_position = format!("custom-{}-{}", x.round() as i64, y.round() as i64);
        c.clone()
    };
    cfg.save().map_err(|e| e.to_string())
}

/// Current orb-satellite display state (UI mode / language / cleanup).
fn orb_quick_json(c: &Config) -> serde_json::Value {
    let mode = if c.mode == "local" {
        "local"
    } else if c.cloud_superfast {
        "superfast"
    } else {
        "cloud"
    };
    serde_json::json!({
        "mode": mode,
        "language": c.language,
        "cleanup": if c.cleanup_enabled { c.cleanup_style.clone() } else { "off".to_string() },
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
            // local → cloud → superfast → local
            "mode" => {
                if c.mode == "local" {
                    c.mode = "subunit".to_string();
                    c.cloud_superfast = false;
                    c.last_cloud_mode = "subunit".to_string();
                } else if !c.cloud_superfast {
                    c.cloud_superfast = true;
                } else {
                    c.mode = "local".to_string();
                    c.cloud_superfast = false;
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
pub fn process_meeting(app: AppHandle, index: usize, style: String) -> Result<String, String> {
    let state = app.state::<AppState>();
    let text = {
        let c = state.config.lock();
        c.meetings
            .get(index)
            .and_then(|m| m.get("text"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "meeting not found".to_string())?
    };
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
