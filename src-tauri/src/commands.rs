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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Manager, State};

/// App-wide managed state.
pub struct AppState {
    pub config: Mutex<Config>,
    pub recorder: Recorder,
    /// Window captured at record-start, focused again before paste-back.
    pub target: Mutex<Option<Target>>,
    /// Guards the single overlay cursor hit-test loop (see [`crate::overlay`]).
    pub hit_test_active: std::sync::atomic::AtomicBool,
    /// Interactive hit-rects reported by the overlay webview (logical px,
    /// window-local): the orb plus any currently-visible chips / open panel.
    /// The hit-test loop makes the window mouse-opaque ONLY over these, so the
    /// transparent gaps between them stay click-through (clicks reach the app
    /// behind). Empty until the overlay reports; the loop falls back to the orb
    /// square so first-hover always engages. See [`crate::overlay`].
    pub overlay_hot_rects: Mutex<Vec<crate::overlay::HotRect>>,
    /// Active meeting recording (mic + system loopback), None when not recording.
    pub meeting_capture: Mutex<Option<crate::meeting_capture::MeetingCapture>>,
    /// True while a record session is in progress. Set in [`do_start`], cleared
    /// SYNCHRONOUSLY in do_transcribe/do_cancel the instant the user finishes. The
    /// re-entry guard gates on THIS (not `recorder.is_recording()`) so a held hotkey
    /// (auto-repeat fires Pressed repeatedly) can't re-enter do_start mid-session.
    pub session_active: AtomicBool,
    /// Generation counter, bumped once per genuine record session in [`do_start`].
    /// The per-session mic backstop ([`crate::hold_guard`]) captures the value at
    /// arm time and exits the instant a newer session supersedes it.
    pub session_epoch: AtomicU64,
    /// True when the user WAS signed in (we still hold their `account_email`) but
    /// the cloud session is gone — both tokens were cleared by a rejected refresh,
    /// or never restored since launch. Drives the global "Sitzung abgelaufen — bitte
    /// neu anmelden" banner so a dead session is visible instead of silently failing
    /// mid-dictation. Set/cleared in [`crate::auth`] (emits echo://session-expired /
    /// echo://session-restored on each flip).
    pub session_expired: AtomicBool,
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
        // Derive the initial expired state: we have a remembered account but no
        // tokens left to act with → the session needs a fresh sign-in. Covers the
        // relaunch-while-expired case (TokenDead cleared + saved empty tokens last run).
        let session_expired = !config.account_email.is_empty()
            && config.subunit_access_token.is_empty()
            && config.subunit_refresh_token.is_empty();
        Self {
            config: Mutex::new(config),
            recorder: Recorder::new(),
            target: Mutex::new(None),
            hit_test_active: std::sync::atomic::AtomicBool::new(false),
            overlay_hot_rects: Mutex::new(Vec::new()),
            meeting_capture: Mutex::new(None),
            session_active: AtomicBool::new(false),
            session_epoch: AtomicU64::new(0),
            session_expired: AtomicBool::new(session_expired),
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

    let (dev, lock, mode, endpoint, streaming, live) = {
        let c = state.config.lock();
        (
            c.mic_device_name.clone(),
            c.target_lock,
            c.mode.clone(),
            c.subunit_endpoint.clone(),
            c.streaming_mode != "off",
            c.streaming_mode == "live",
        )
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

    // Arm the universal mic backstop for THIS session: whatever input path started
    // it (combo hotkey, toggle, button, tray, or a platform without the hold-key
    // tap), a lost release event can never strand the mic past the ceiling. The
    // fast, exact release stays with each path (hold_key.rs polls the real key).
    let epoch = state.session_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    crate::hold_guard::arm(app, epoch);

    // Record-start cue, played NATIVELY (sound.rs) so it's instant even when the
    // main window is hidden to the tray — a hidden WKWebView suspends its
    // AudioContext, which delayed the webview-played cue. Only the bundled
    // "standard" cue is native; synth presets stay in the webview (SoundFx skips
    // "standard" so there's no double-play).
    {
        let c = state.config.lock();
        if c.sound_start_enabled && c.sound_start_id == "standard" {
            crate::sound::play_start(c.sound_volume);
        }
    }

    // Open the dictation WebSocket NOW (cloud + streaming on) so the server
    // decodes the take incrementally while the key is held — by release only the
    // tail remains. start() is a cloud-only no-op internally; the mode flag is the
    // kill switch. Any failure degrades to the classic batch upload in do_transcribe.
    if mode == "subunit" && streaming {
        crate::transcribe::stream::start(app, live);
    }
}

pub fn do_cancel(app: &AppHandle) {
    let state = app.state::<AppState>();
    // The session is over — clear the re-entry guard so the next press is accepted.
    state.session_active.store(false, Ordering::SeqCst);
    // Tear down any live streaming session so its server-side per-key slot frees
    // (else the next press could trip the dictation session cap). cancel() sends a
    // {cancel} frame + closes the WS; it does NOT stop the recorder, so the stop
    // below stays the single mic-stop on the cancel path.
    crate::transcribe::stream::cancel();
    let _ = state.recorder.stop();
    *state.target.lock() = None;
    emit_state(app, EngineState::Idle, None);
}

/// Stop + transcribe synchronously. Blocking (network), so the hotkey handler
/// calls this on a spawned thread; the IPC command calls it directly.
pub fn do_transcribe(app: &AppHandle) -> Result<TranscriptResult, EngineError> {
    let state = app.state::<AppState>();

    // Release cue, played NATIVELY (sound.rs) for the same reason as the
    // record-start cue: instant regardless of window visibility. One of three
    // selectable tones (`sound_stop_id`) — the acoustic counterpart to the start
    // cue. Gated by its OWN toggle (`sound_stop_enabled`): it used to ride the
    // start toggle, so a user who silenced the finish/paste sound still heard
    // this on every release with no way to turn it off. Fired first, before any
    // of the (possibly network-blocking) work below, so it lands the instant the
    // key is released, not after a token refresh.
    if state.recorder.is_recording() {
        let c = state.config.lock();
        if c.sound_stop_enabled {
            crate::sound::play_stop(&c.sound_stop_id, c.sound_volume);
        }
    }

    // The session is over — clear the re-entry guard so the next press is accepted.
    state.session_active.store(false, Ordering::SeqCst);

    // Latency measurement system: t_total spans release → text delivered. Per-phase
    // numbers (encode/stt from the engine, cleanup/inject here) are logged as ONE
    // greppable line + stored with history, so we iterate on real field data.
    let t_total = std::time::Instant::now();

    // Client-latency instrumentation (counts-only, PII-safe). These accumulate the
    // per-phase splits the opaque `latency:` line never had, and are emitted as ONE
    // `[client-timing] {json}` line (mirrors the server's `[dictate-timing]`). The
    // async macOS paste logs its own companion `[client-timing] paste {...}` line
    // (see inject::deliver) because it genuinely runs after this fn returns.
    let mut ws_flush_ms: u64 = 0;
    let mut server_final_ms: u64 = 0;
    let mut vocab_ms: u64 = 0;
    let mut stream_finish_ms: u64 = 0;

    // Cloud path: refresh the access token if it's expired before we call out
    // (streaming reuses the same credential, so this covers both paths). On the
    // hot path — a token that expired mid-hold pays a blocking HTTP refresh here.
    let t_auth = std::time::Instant::now();
    if state.config.lock().mode == "subunit" {
        crate::auth::ensure_fresh(app);
    }
    let ensure_fresh_ms = t_auth.elapsed().as_millis() as u64;
    let cfg = state.config.lock().clone();
    let streaming = cfg.mode == "subunit" && cfg.streaming_mode != "off";

    // Target window context (captured at record-start) — Auto-Mode style + Synapse.
    // `url` is the active browser-tab URL (macOS browsers only; empty otherwise).
    let (app_name, url, title) = {
        let t = state.target.lock();
        (
            t.as_ref().map(|t| t.app.clone()).unwrap_or_default(),
            t.as_ref().map(|t| t.url.clone()).unwrap_or_default(),
            t.as_ref().map(|t| t.title.clone()).unwrap_or_default(),
        )
    };

    // Acquire EITHER the server's streamed final (audio already lives server-side,
    // no re-upload) OR a local capture for the classic batch path. On streaming
    // success the mic is already stopped inside stream::finish(); on any stream
    // failure the preserved capture flows into the classic path below — worst case
    // is exactly today's latency, never a lost word.
    let mut streamed: Option<crate::transcribe::stream::StreamFinal> = None;
    let mut resume_id: Option<String> = None;
    let cap_opt: Option<crate::recorder::Capture>;
    if streaming {
        emit_state(app, EngineState::Transcribing, None);
        // Whole finish() call: signals the session thread to flush+end, then blocks
        // on the server final. The StreamFinal below splits this into flush/wait/vocab.
        let t_finish_call = std::time::Instant::now();
        let finished = crate::transcribe::stream::finish();
        stream_finish_ms = t_finish_call.elapsed().as_millis() as u64;
        match finished {
            Some(Ok(fin)) => {
                ws_flush_ms = fin.finish_flush_ms;
                server_final_ms = fin.final_wait_ms;
                vocab_ms = fin.vocab_ms;
                streamed = Some(fin);
                cap_opt = None;
            }
            Some(Err(fail)) => {
                log::warn!(
                    "transcribe: stream failed ({}: {}) — classic fallback",
                    fail.error.code,
                    fail.error.message
                );
                resume_id = fail.resume_id;
                // Mid-hold breaks report with no capture — the recorder still
                // holds the take; stop it here so the resume pickup and the
                // batch fallback both have the audio.
                cap_opt = fail.capture.or_else(|| state.recorder.stop());
            }
            None => cap_opt = state.recorder.stop(), // streaming off mid-take / never started
        }
    } else {
        cap_opt = state.recorder.stop();
    }

    // Live mode that failed AFTER typing part of the take: the user already has
    // that text in their target, so a batch re-paste would DUPLICATE it. Finalize
    // with what was typed instead. (Rare — most stream failures happen at connect,
    // before anything is typed, where live_injected_chars()==0 and we fall through
    // to the clean batch fallback below.)
    if streaming
        && streamed.is_none()
        && cfg.streaming_mode == "live"
        && crate::transcribe::stream::live_injected_chars() > 0
    {
        let typed = crate::transcribe::stream::live_injected_chars();
        log::warn!(
            "transcribe: live stream failed after typing {typed} chars — keeping the partial, skipping batch re-paste"
        );
        *state.target.lock() = None;
        emit_state(app, EngineState::Done, None);
        return Ok(TranscriptResult {
            quality_mode: "cloud-stream-live".to_string(),
            ..Default::default()
        });
    }

    // Flaky-network recovery: the server parks a dropped session's audio (or
    // its already-computed final) under the resume handle for a short window.
    // One cheap reconnect that ships only the missing tail beats re-uploading
    // the whole take over the very link that just failed; if it doesn't work
    // out, the batch fallback below runs exactly as before.
    if streamed.is_none() && crate::transcribe::stream::live_injected_chars() == 0 {
        if let (Some(rid), Some(cap)) = (resume_id.as_deref(), cap_opt.as_ref()) {
            match crate::transcribe::stream::resume_finish(app, rid, cap) {
                Ok(fin) => {
                    log::info!("transcribe: stream resumed after drop — batch re-upload skipped");
                    streamed = Some(fin);
                }
                Err(e) => {
                    log::info!(
                        "transcribe: resume not possible ({}: {}) — classic fallback",
                        e.code,
                        e.message
                    );
                }
            }
        }
    }

    // Both paths now produce the SAME locals so the post-processing tail
    // (cleanup → DACH → inject → history → stats → emit) is byte-identical.
    let result: TranscriptResult;
    let already_injected: bool;
    let duration_s: f64;
    let style: String;

    if let Some(fin) = streamed {
        // ── Streamed final ──────────────────────────────────────────────────
        already_injected = fin.already_injected;
        duration_s = fin.duration_s;
        // Streaming resolved the cleanup style at connect-time the SAME way the
        // batch path does (incl. Auto-Mode from the captured window) — mirror that
        // here so history is labelled with what actually ran. (Long-form
        // re-selection still only applies on the batch path.)
        style = if cfg.cleanup_enabled {
            let resolved = if cfg.cleanup_auto_mode {
                crate::auto_mode::pick_style(
                    &app_name,
                    &url,
                    &title,
                    &cfg.auto_mode_overrides,
                    &cfg.cleanup_style,
                )
                .0
            } else {
                cfg.cleanup_style.clone()
            };
            if resolved != "raw" {
                resolved
            } else {
                "raw".to_string()
            }
        } else {
            "raw".to_string()
        };
        log::info!(
            "transcribe: streamed final ({:.1}s, {} chars, cleaned={}, tier={})",
            duration_s,
            fin.text.chars().count(),
            fin.cleaned_text.is_some(),
            fin.quality_mode
        );
        result = TranscriptResult {
            text: fin.text,
            quality_mode: fin.quality_mode,
            segments: Vec::new(),
            cleaned_text: fin.cleaned_text,
            cleanup_status: fin.cleanup_status,
            // Streamed: no client encode, no separate GPU number — stt_ms is the
            // whole release→final wait (the press→paste latency we tune against).
            timings: transcribe::Timings {
                encode_ms: 0,
                stt_ms: t_total.elapsed().as_millis() as u64,
                server_ms: 0,
            },
            fillers_removed: fin.fillers_removed,
        };
    } else {
        // ── Classic batch path ──────────────────────────────────────────────
        already_injected = false;
        let cap = match cap_opt.as_ref() {
            Some(c) if !c.samples.is_empty() => c,
            Some(_) => {
                emit_state(app, EngineState::Idle, None);
                return Err(EngineError::new("empty", "leere Aufnahme"));
            }
            None => return Err(EngineError::new("no_recording", "keine aktive Aufnahme")),
        };
        emit_state(app, EngineState::Transcribing, None);

        // Duration → long-form detection (Python parity: switch style + store separately).
        duration_s = cap.samples.len() as f64 / cap.sample_rate.max(1) as f64;
        let is_long = cfg.long_form_threshold_seconds > 0
            && duration_s >= cfg.long_form_threshold_seconds as f64;

        // The cleanup style (long-form > auto-mode > config) is known BEFORE we call
        // out — the target window was captured at record-start — so it can ride along
        // on the transcribe request (combined transcribe+cleanup, one round trip less).
        style = if is_long {
            cfg.long_form_cleanup_style.clone()
        } else if cfg.cleanup_auto_mode {
            let (style, source) = crate::auto_mode::pick_style(
                &app_name,
                &url,
                &title,
                &cfg.auto_mode_overrides,
                &cfg.cleanup_style,
            );
            // App name + decision source only at info (titles/URLs can carry
            // document names + query params → debug-level via capture log).
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
            "transcribe: mode={} duration={duration_s:.1}s long_form={is_long} inline_cleanup={inline_cleanup}",
            cfg.mode
        );
        let t_tx = std::time::Instant::now();
        // Diarization retired: long recordings now land in the normal history like any
        // dictation, so we no longer request timed segments (never diarize).
        let r = match transcribe::run_opts(
            &cfg,
            &cap.samples,
            cap.sample_rate,
            false,
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
            r.quality_mode,
            r.text.chars().count(),
            r.cleaned_text.is_some(),
            t_tx.elapsed()
        );
        result = r;
    }

    // Target window (captured at record-start), consumed for the paste-back below.
    let target = state.target.lock().take();

    // Post-process: prefer the server-side cleanup from the combined round trip;
    // fall back to the separate /v1/cleanup call (old server, local engine, or
    // long-form). Then DACH formatting. "raw" = passthrough. cleanup_ms times
    // only the separate call — the inline path already sits inside stt_ms.
    let t_cleanup = std::time::Instant::now();
    let mut text = if already_injected {
        // Live mode already typed the RAW transcript into the target as the user
        // spoke (then reconciled to it) — keep it verbatim for clipboard + history;
        // cleanup/DACH would diverge from what is already on screen.
        result.text
    } else {
        match result.cleaned_text {
            Some(cleaned) if !cleaned.trim().is_empty() => cleaned,
            // Server ran the combined round trip but cleanup is down (all subscriptions
            // at their weekly limit) — a separate /v1/cleanup call would also fail. Paste
            // the raw transcript now instead of burning another ~2 s on a dead service.
            // (Distinct from a missing field on an old server, which still falls through
            // to the separate call below.)
            _ if result.cleanup_status.as_deref() == Some("unavailable") => {
                log::info!("transcribe: server cleanup unavailable (subscription limit) — pasting raw, skipping retry");
                result.text
            }
            // This take came from the cloud→local fallback — the cloud is down
            // RIGHT NOW, so a separate /v1/cleanup call would only stall the
            // paste on a second doomed request. Deliver the local text as-is.
            _ if result.quality_mode == "local-fallback" => {
                log::info!("transcribe: local fallback — skipping cloud cleanup, pasting raw");
                result.text
            }
            _ if cfg.cleanup_enabled && style != "raw" => {
                crate::cleanup::maybe_cleanup(&cfg, &result.text, &style)
            }
            _ => result.text,
        }
    };
    // Split for client-timing: the separate /v1/cleanup network call (0 on the
    // streaming inline path + all the skip cases) vs the local de_comma+dach passes.
    let cleanup_call_ms = t_cleanup.elapsed().as_millis() as u64;
    let t_post = std::time::Instant::now();
    // German commas BEFORE dach: dach's punctuation-spacing normalisation then
    // tidies anything the insertion touched. Both skip live-typed text (can't
    // retro-edit what is already injected into the target app).
    if cfg.de_comma_enabled && !already_injected {
        text = crate::de_comma::insert_commas(&text);
    }
    if cfg.dach_format_enabled && !already_injected {
        text = crate::dach::dach_format(&text);
    }
    let postprocess_ms = t_post.elapsed().as_millis() as u64;
    let cleanup_ms = t_cleanup.elapsed().as_millis() as u64;
    // Latency breakdown — the measurement system we iterate against. server_ms is
    // pure GPU (cloud elapsed_s); stt_ms is the full cloud round trip (so
    // stt_ms - server_ms ≈ network + upload + inline cleanup); cleanup_ms is the
    // SEPARATE /v1/cleanup call only (0 when the inline path or the skip applied).
    log::info!(
        "transcribe latency: encode={}ms stt={}ms server_gpu={}ms net+inline≈{}ms cleanup_call={}ms",
        result.timings.encode_ms,
        result.timings.stt_ms,
        result.timings.server_ms,
        result.timings.stt_ms.saturating_sub(result.timings.server_ms),
        cleanup_ms,
    );
    let result = TranscriptResult {
        text,
        quality_mode: result.quality_mode,
        segments: Vec::new(),
        cleaned_text: None,
        cleanup_status: None,
        timings: result.timings,
        fillers_removed: result.fillers_removed,
    };

    // The recording had audio but transcribed to nothing.
    if result.text.trim().is_empty() {
        // A SHORT empty take is a deliberate abort / accidental tap — no error
        // flash (TJ: Abbruch ist kein Fehler; the state colors are reserved for
        // future states like "Claude denkt"). Quietly back to idle.
        if duration_s < 3.0 {
            log::info!(
                "transcribe: empty transcript on short take ({duration_s:.1}s) — treating as cancel"
            );
            emit_state(app, EngineState::Idle, None);
            return Ok(result);
        }
        // A LONG take with no speech stays a visible warning: a dead/muted mic
        // otherwise looks exactly like "Echo stopped working" (the empty-result
        // streak we saw in the field). Skip delivery/history.
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
    if already_injected {
        // Live mode already typed it into the target as the user spoke — never
        // paste again (that would duplicate). Still copy to the clipboard so a
        // manual re-paste works everywhere.
        if let Err(e) = crate::inject::set_clipboard(&result.text) {
            log::warn!("clipboard failed: {e}");
        }
    } else if cfg.prompt_console_as_target {
        if let Err(e) = crate::inject::set_clipboard(&result.text) {
            log::warn!("clipboard failed: {e}");
        }
        crate::prompt_console::receive_transcript(app, &result.text);
    } else if cfg.prompt_fallback_enabled
        && crate::inject::focused_editable() == Some(false)
    {
        // No editable field has focus — a ⌘V would vanish into the void and the
        // dictation would only survive on the clipboard. Catch it in the Prompt
        // Console instead (shows without stealing focus). Only on a CONFIDENT
        // "no field" probe; anything ambiguous pastes normally.
        log::info!("paste: no editable field focused — routing to prompt console (fallback)");
        if let Err(e) = crate::inject::set_clipboard(&result.text) {
            log::warn!("clipboard failed: {e}");
        }
        crate::prompt_console::receive_transcript(app, &result.text);
    } else if let Err(e) = crate::inject::deliver(&result.text, &cfg, target.as_ref(), t_total) {
        log::warn!("inject failed: {e}");
    }
    // On macOS this is only the DISPATCH time — the real Cmd+V runs async on the
    // main thread and logs its own `[client-timing] paste {...}` (see deliver).
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

    // Structured client-latency line — mirrors the server's `[dictate-timing]`.
    // Splits the previously opaque release→paste-dispatch span into every phase we
    // control on the client. Counts-only (never text). `path` distinguishes the WS
    // streaming split (ws_flush/server_final/vocab populated) from the batch
    // fallback (those 0; stt_ms/server_gpu carry the round trip). The real Cmd+V
    // lands async → its own `[client-timing] paste {...}` line completes the story.
    let ct = serde_json::json!({
        "path": if stream_finish_ms > 0 { "stream" } else { "batch" },
        "total_ms": total_ms,               // release → paste dispatched
        "ensure_fresh_ms": ensure_fresh_ms, // blocking token refresh (0 if fresh)
        "stream_finish_ms": stream_finish_ms, // whole finish() (flush+wait+vocab+chan)
        "ws_flush_ms": ws_flush_ms,         // ship audio tail + {end} frame
        "server_final_ms": server_final_ms, // {end} → server final (net + tail-decode + inline cleanup)
        "vocab_ms": vocab_ms,               // client vocab-replace + comma de-spam + filler strip
        "cleanup_call_ms": cleanup_call_ms, // separate /v1/cleanup call (0 on streaming inline)
        "postprocess_ms": postprocess_ms,   // de_comma + dach
        "inject_dispatch_ms": inject_ms,    // clipboard set + main-thread dispatch (NOT the paste itself on macOS)
        "stt_ms": result.timings.stt_ms,    // batch: full cloud round trip
        "server_gpu_ms": result.timings.server_ms,
        "tier": result.quality_mode,
        "style": style,
        "audio_s": (duration_s * 10.0).round() / 10.0,
        "chars": result.text.chars().count(),
        "already_injected": already_injected,
    });
    log::info!("[client-timing] {ct}");

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

    // Prompt-Coach (Welle 5): a dictation into a KI/prompt surface — a native AI
    // chat / code editor / terminal, a KI browser tab, OR the explicit "Konsole
    // als Ziel" route — is scored post-hoc against the 5-criteria rubric (pure,
    // offline, < 1 ms) and its target app is remembered. Inert for non-prompt
    // targets. This rides alongside everything below: an is_prompt dictation is
    // still delivered + stored + coached exactly like any other.
    let is_prompt = crate::auto_mode::is_prompt_target(&app_name, &url, &title)
        || cfg.prompt_console_as_target;
    let prompt_score: Option<i64> =
        is_prompt.then(|| crate::prompt_coach::score_prompt(&result.text).0);

    // Stats: legacy global config counters + per-account lifetime totals (the
    // Home dashboard reads the latter — real, account-scoped). Word/char counts
    // come from the actually delivered text so "time saved" is a genuine
    // calculation, not a fixed multiplier.
    let words = result.text.split_whitespace().count() as i64;
    let chars = result.text.chars().count() as i64;
    let (history_enabled, history_size, account) = {
        let mut c = state.config.lock();
        c.total_transcriptions += 1;
        c.total_audio_seconds += duration_s;
        let _ = c.save();
        (c.history_enabled, c.history_size.max(0) as usize, crate::presets::account_key(&c))
    };
    crate::store::bump_account_stats(&account, duration_s, words, chars, now as i64);
    // Per-day bucket for the Activity dashboard (never pruned, unlike history).
    let saved = time_saved_seconds(words, duration_s);
    crate::store::bump_daily_stats(&account, words, duration_s, saved, now as i64);
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
            // Prompt-Coach: the target app + (for prompts) the rubric score.
            "target_app": app_name,
            "is_prompt": if is_prompt { 1 } else { 0 },
            "prompt_score": prompt_score, // Option<i64> → number or null
        });
        crate::store::add_history(&entry, history_size);
        use tauri::Emitter;
        let _ = app.emit("echo://history-changed", ());
        // Filler-word counter (TJ: the "äh/ähm/hmm" stats are otherwise blind —
        // strip_fillers runs BEFORE storage, so this is the only place the
        // removed words are ever captured). Genuinely once per dictation, right
        // where the finished dictation itself gets persisted.
        if !result.fillers_removed.is_empty() {
            crate::store::filler_removed_add(&result.fillers_removed, now as i64);
        }
    }
    // Gamification: recognize taught vocabulary (word of the day, coach words)
    // in the delivered text and celebrate it — XP, event, native notification.
    maybe_award_vocab(app, &cfg, &account, &result.text, now as i64);
    // Prompt-Coach pattern-of-the-day: for a prompt dictation, reward today's
    // pattern when it's recognized (same XP ledger + reward event as the vocab
    // coach). Inline + deterministic; a no-op for non-prompt targets.
    if is_prompt {
        crate::prompt_coach::maybe_award_pattern(app, &cfg, &account, &result.text, now as i64);
    }
    // Wortdex: grow the collection from the same delivered text. Detached —
    // context extraction rescans the text per hit and every find is an SQLite
    // write, none of which may delay the Done state (Codex-Review #141).
    {
        let (app2, cfg2, account2, text2) = (app.clone(), cfg.clone(), account.clone(), result.text.clone());
        std::thread::spawn(move || maybe_award_finds(&app2, &cfg2, &account2, &text2, now as i64));
    }
    // Lern-Loop weekly report: inline, not detached — it needs `state`/`cfg` to
    // persist its once-per-week guard, and it's a cheap guard-check (two string
    // compares) on all but the first dictation of a new calendar week.
    maybe_weekly_report(app, &state, &cfg, &account, now as i64);
    // Long recordings are NOT stored separately anymore — they land in the normal
    // history above like any dictation (TJ 2026-07-03). The former meeting store +
    // long-form diarization are retired.

    emit_transcript(app, result.text.clone(), result.quality_mode.clone());
    // Done (and Error) settle back to Idle centrally in emit_state — so the overlay
    // idle behaviour re-engages and the orb never gets stuck on done-green/error-amber.
    emit_state(app, EngineState::Done, None);
    // Auto-vocab: throttled background scan of recent history for recurring
    // mis-heard terms (this dictation is already in history above). Off-thread.
    crate::autovocab::maybe_scan(app);
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
    // Streaming-live already types live → force the redundant instant-live-typing
    // off so the two can never both be active (foot-gun + overlap guard).
    config.enforce_typing_exclusivity();

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
    // Keep the orb's voice-reactivity in sync with config (no recording restart).
    {
        let c = state.config.lock();
        crate::recorder::set_reactivity(c.orb_noise_floor, c.orb_gain, c.orb_gamma);
    }
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

// ── Auto-vocabulary (detect recurring mis-heard terms → hybrid learn) ───────

/// List candidates by status ("pending" suggestions or "added" auto-learned).
/// Pending is DISPLAY-GATED: only candidates the strict gatekeeper positively
/// judged (they carry a `suggestion`) are ever shown. Raw/undecided finds —
/// fresh detections or ones whose curate call failed — stay invisible and are
/// re-judged on the next scan, instead of nagging the user with ordinary words.
#[tauri::command]
pub fn vocab_candidates(status: Option<String>) -> Vec<serde_json::Value> {
    let status = status.unwrap_or_else(|| "pending".to_string());
    let rows = crate::store::list_vcand(&status);
    if status != "pending" {
        return rows;
    }
    rows.into_iter()
        .filter(|c| {
            c.get("suggestion")
                .and_then(|s| s.as_str())
                .is_some_and(|s| !s.trim().is_empty())
        })
        .collect()
}

/// Trigger a background scan now (network suggest runs off-thread; never blocks).
#[tauri::command]
pub fn vocab_scan(app: AppHandle) {
    std::thread::spawn(move || crate::autovocab::scan_and_learn(&app));
}

/// Confirm a pending suggestion (spelling possibly edited) → learn it.
#[tauri::command]
pub fn vocab_confirm(app: AppHandle, key: String, spelling: String) {
    crate::autovocab::confirm(&app, &key, &spelling);
}

/// Dismiss a candidate → never surface it again.
#[tauri::command]
pub fn vocab_ignore(app: AppHandle, key: String) {
    crate::autovocab::ignore(&app, &key);
}

/// Undo an auto-learned term (removes its vocab entry, won't re-add).
#[tauri::command]
pub fn vocab_undo(app: AppHandle, key: String) {
    crate::autovocab::undo(&app, &key);
}

/// Total number of stored history entries (Home stat card).
#[tauri::command]
pub fn history_count() -> i64 {
    crate::store::count_history()
}

/// Average sustained typing speed (words per minute) for a general user — the
/// baseline dictation is compared against for "time saved". Deliberately
/// conservative: pro typists exceed 70 WPM, hunt-and-peck sits near 25; ~40 WPM
/// is a widely cited average, so the figure reads as credible, not inflated.
const TYPING_WPM: f64 = 40.0;

/// Average speaking rate (words per minute), used ONLY to estimate the word count
/// of dictations recorded by pre-stats builds (which never stored words), so the
/// historical "time saved" is consistent with the real lifetime audio. Every new
/// dictation contributes its exact counted words instead of this estimate.
pub const SPEAKING_WPM_ESTIMATE: f64 = 130.0;

/// Real "time saved" by dictating instead of typing: the seconds it would take
/// to TYPE `words` at [`TYPING_WPM`], minus the seconds actually spent speaking.
/// Clamped at zero (a tiny clip with almost no words can't cost more than it
/// saves). This is the honest calculation behind the Home stat.
pub fn time_saved_seconds(words: i64, audio_seconds: f64) -> f64 {
    let typing = (words.max(0) as f64) / TYPING_WPM * 60.0;
    (typing - audio_seconds).max(0.0)
}

/// Real, account-scoped lifetime usage for the Home dashboard. The account is
/// resolved from the signed-in identity (workspace → email → "local"), so each
/// account only ever sees its own numbers. All fields are accumulated from the
/// real measurements of every completed dictation; `time_saved_seconds` is
/// derived via [`time_saved_seconds`] — no decorative multipliers.
#[derive(serde::Serialize)]
pub struct AccountStats {
    pub transcriptions: i64,
    pub audio_seconds: f64,
    pub words: i64,
    pub chars: i64,
    pub time_saved_seconds: f64,
}

#[tauri::command]
pub fn account_stats(state: State<'_, AppState>) -> AccountStats {
    let account = crate::presets::account_key(&state.config.lock());
    let (transcriptions, audio_seconds, words, chars) = crate::store::get_account_stats(&account);
    AccountStats {
        transcriptions,
        audio_seconds,
        words,
        chars,
        time_saved_seconds: time_saved_seconds(words, audio_seconds),
    }
}

// ── Activity + Learning (dashboard/coach — local analysis, account-scoped stats) ──
//
// history-based views (hourly, word frequency, learning) are machine-wide —
// the `history` table has no account column, exactly like the History tab.
// `daily_stats`/`account_stats` readers ARE account-scoped.

/// Per-day activity rows for the trend chart, ASC by day (sparse: only days
/// with activity — the frontend zero-fills the axis). Account-scoped.
#[tauri::command]
pub fn activity_daily(state: State<'_, AppState>, days: Option<u32>) -> Vec<serde_json::Value> {
    let account = crate::presets::account_key(&state.config.lock());
    crate::store::daily_range(&account, &format!("-{} days", days.unwrap_or(30)))
}

/// Dictations per local hour of day over the last `days` (default 30). The
/// backend fills 0..23 without gaps. Machine-wide (history has no account).
#[tauri::command]
pub fn activity_hourly(days: Option<u32>) -> Vec<serde_json::Value> {
    let mut buckets = [0i64; 24];
    for (hour, count) in crate::store::hourly_counts(days.unwrap_or(30)) {
        if (0..24).contains(&hour) {
            buckets[hour as usize] = count;
        }
    }
    (0..24)
        .map(|h| serde_json::json!({ "hour": h, "transcriptions": buckets[h] }))
        .collect()
}

/// Top content words from the retained history (stop-word filtered DE+EN,
/// min length 3, no pure numbers), desc by count. Machine-wide.
#[tauri::command]
pub fn activity_word_frequency(limit: Option<u32>, days: Option<u32>) -> Vec<serde_json::Value> {
    let texts = crate::store::history_texts_since(days.unwrap_or(90));
    crate::analysis::word_frequency(&texts, limit.unwrap_or(40) as usize)
        .into_iter()
        .map(|(word, count)| serde_json::json!({ "word": word, "count": count }))
        .collect()
}

/// Days since 1970-01-01 for a 'YYYY-MM-DD' string (Howard Hinnant's
/// days_from_civil) — pure integer math on the SQLite-bucketed LOCAL dates, so
/// consecutive-day streaks need no date crate. None on malformed input.
pub(crate) fn day_number(day: &str) -> Option<i64> {
    let mut it = day.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    let d: i64 = it.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// (current, longest, last_active_day, active_today) for `account`, computed
/// on the 'YYYY-MM-DD' day strings from `daily_stats`. A current streak is a
/// consecutive run ending today — or yesterday (today simply not dictated yet).
fn compute_streak(account: &str) -> (i64, i64, Option<String>, bool) {
    let days = crate::store::active_days(account); // DESC
    let today = crate::store::today_local();
    let nums: Vec<i64> = days.iter().filter_map(|d| day_number(d)).collect();
    let mut longest = 0i64;
    let mut run = 0i64;
    let mut prev: Option<i64> = None;
    for n in &nums {
        run = match prev {
            Some(p) if p - n == 1 => run + 1,
            _ => 1,
        };
        longest = longest.max(run);
        prev = Some(*n);
    }
    let mut current = 0i64;
    if let (Some(tn), Some(first)) = (day_number(&today), nums.first().copied()) {
        if tn - first <= 1 {
            current = 1;
            let mut prev = first;
            for n in nums.iter().skip(1) {
                if prev - n == 1 {
                    current += 1;
                    prev = *n;
                } else {
                    break;
                }
            }
        }
    }
    let active_today = days.first().map(|d| d == &today).unwrap_or(false);
    (current, longest, days.into_iter().next(), active_today)
}

/// Current/longest dictation streak (consecutive active local days). Account-scoped.
#[tauri::command]
pub fn activity_streak(state: State<'_, AppState>) -> serde_json::Value {
    let account = crate::presets::account_key(&state.config.lock());
    let (current, longest, last_active_day, active_today) = compute_streak(&account);
    serde_json::json!({
        "current": current,
        "longest": longest,
        "last_active_day": last_active_day,
        "active_today": active_today,
    })
}

/// One fetch for the Activity dashboard header: lifetime totals, today,
/// this week (rolling 7 days), streak and the configured goals.
#[tauri::command]
pub fn activity_overview(state: State<'_, AppState>) -> serde_json::Value {
    let (account, daily_word_goal, weekly_word_goal) = {
        let c = state.config.lock();
        (crate::presets::account_key(&c), c.daily_word_goal, c.weekly_word_goal)
    };
    let (transcriptions, audio_seconds, words, _chars) = crate::store::get_account_stats(&account);
    let (today_w, today_t, today_s) = crate::store::daily_sum_since(&account, "0 days");
    let (week_w, week_t, week_s) = crate::store::daily_sum_since(&account, "-6 days");
    let (current, longest, _, _) = compute_streak(&account);
    // Day-resolved recording starts at `daily_since` (backfill was capped by
    // the retained history) — everything earlier only exists in the lifetime
    // totals. The frontend uses the delta for an honest partial-range hint.
    let (daily_w, daily_t, _) = crate::store::daily_sum_since(&account, "-3650 days");
    serde_json::json!({
        "total": {
            "transcriptions": transcriptions,
            "words": words,
            "audio_seconds": audio_seconds,
            "time_saved_seconds": time_saved_seconds(words, audio_seconds),
        },
        "daily_since": crate::store::daily_first_day(&account),
        "daily_words": daily_w,
        "daily_transcriptions": daily_t,
        "today": { "words": today_w, "transcriptions": today_t, "time_saved_seconds": today_s },
        "this_week": { "words": week_w, "transcriptions": week_t, "time_saved_seconds": week_s },
        "streak": { "current": current, "longest": longest },
        "goals": { "daily_word_goal": daily_word_goal, "weekly_word_goal": weekly_word_goal },
    })
}

/// Which fillers ("äh"/"ähm"/"hmm") got stripped before storage, over the last
/// `days` (default 30) — the counter `strip_fillers` itself can't surface,
/// since it runs BEFORE a dictation ever reaches history (the History-driven
/// stats are otherwise blind to fillers: TJ measured only 2 hits across 450
/// real dictations). 100% local, reads `store::filler_removed_add`'s bookings.
#[tauri::command]
pub fn filler_removed_counts(days: Option<u32>) -> Vec<serde_json::Value> {
    crate::store::filler_removed_since(days.unwrap_or(30))
        .into_iter()
        .map(|(word, count)| serde_json::json!({ "word": word, "count": count }))
        .collect()
}

/// Lexical-quality analysis over the last `days` (default 30) of history.
/// 100% local — this command NEVER touches the network (the coach can't hang).
#[tauri::command]
pub fn learning_analysis(days: Option<u32>) -> serde_json::Value {
    let days = days.unwrap_or(30);
    let texts = crate::store::history_texts_since(days);
    let stats = crate::analysis::learning(&texts);
    let mut v = serde_json::to_value(stats).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(o) = v.as_object_mut() {
        o.insert("window_days".into(), serde_json::json!(days));
        o.insert("sample_transcriptions".into(), serde_json::json!(texts.len()));
    }
    v
}

/// LLM word-upgrade hook over the subscription lane, built EXACTLY like
/// `vocab_suggest::curate`: endpoint derived from the configured transcribe
/// URL (`/v1/word-upgrade`), Bearer auth (X-API-Key fallback), best-effort.
/// Returns None on ANY failure — endpoint missing (today's reality), auth,
/// timeout, bad shape — so the caller falls back to the local UPGRADE_MAP.
/// Expected response: {"upgrades":[{"word":…,"alternatives":[{"word":…,"note":…}]}]}
/// — exactly the §12c client shape.
fn word_upgrade_curate(
    cfg: &Config,
    local: &[crate::analysis::Suggestion],
) -> Option<Vec<crate::analysis::Suggestion>> {
    if local.is_empty() || cfg.mode != "subunit" {
        return None;
    }
    let url = cfg
        .subunit_endpoint
        .replace("/v1/transcribe", "/v1/word-upgrade");
    let items: Vec<serde_json::Value> = local
        .iter()
        .map(|s| serde_json::json!({ "word": s.word, "count": s.count, "example": s.example }))
        .collect();
    let mut req = crate::http::client()
        .post(&url)
        .timeout(std::time::Duration::from_secs(30))
        .json(&serde_json::json!({ "words": items, "language": cfg.language }));
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else if !cfg.subunit_api_key.is_empty() {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    }
    let resp = req.send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let j = resp.json::<serde_json::Value>().ok()?;
    let arr = j.get("upgrades")?.as_array()?;
    let mut by_word: std::collections::HashMap<String, Vec<crate::analysis::WordAlternative>> =
        std::collections::HashMap::new();
    for u in arr {
        let Some(word) = u.get("word").and_then(|v| v.as_str()) else { continue };
        let Some(alts) = u.get("alternatives").and_then(|v| v.as_array()) else { continue };
        let parsed: Vec<crate::analysis::WordAlternative> = alts
            .iter()
            .filter_map(|a| {
                let w = a.get("word")?.as_str()?.trim().to_string();
                if w.is_empty() {
                    return None;
                }
                let note = a
                    .get("note")
                    .and_then(|n| n.as_str())
                    .map(|n| n.trim().to_string())
                    .filter(|n| !n.is_empty());
                Some(crate::analysis::WordAlternative { word: w, note })
            })
            .collect();
        if !parsed.is_empty() {
            by_word.insert(word.trim().to_lowercase(), parsed);
        }
    }
    if by_word.is_empty() {
        return None; // nothing usable → local map wins
    }
    // Merge onto the local suggestions: counts/examples stay local truth; a
    // word the LLM didn't rule on keeps its curated alternatives.
    Some(
        local
            .iter()
            .map(|s| crate::analysis::Suggestion {
                word: s.word.clone(),
                count: s.count,
                alternatives: by_word
                    .remove(&s.word)
                    .unwrap_or_else(|| s.alternatives.clone()),
                example: s.example.clone(),
            })
            .collect(),
    )
}

/// Word-upgrade suggestions for the Learning coach — the LOCAL, curated
/// UPGRADE_MAP only. Guaranteed instant, guaranteed zero network (mirrors
/// `learning_analysis`'s "can't hang" contract). This used to also run the
/// `/v1/word-upgrade` LLM augmentation inline — a blocking 30 s-budget network
/// call — and the Wortschatz tab fired it on EVERY history change and every
/// days-window switch, which is exactly why "Verbesserungsvorschläge" felt
/// slow/missing (TJ 2026-07-14). The LLM lane now lives in
/// [`learning_suggestions_llm`], called separately and cached.
#[tauri::command]
pub fn learning_suggestions(days: Option<u32>) -> serde_json::Value {
    let texts = crate::store::history_texts_since(days.unwrap_or(30));
    let local = crate::analysis::local_suggestions(&texts);
    // Remember what the coach actually showed — only taught words can earn XP.
    let shown: Vec<String> = local
        .iter()
        .flat_map(|s| s.alternatives.iter().map(|a| a.word.clone()))
        .collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    crate::store::suggested_words_add(&shown, "local", now);
    serde_json::json!({ "source": "local", "suggestions": local })
}

/// In-memory cache for the LLM word-upgrade augmentation below, keyed on
/// `"{language}|{comma-joined local words}"`. The local word set barely moves
/// between two consecutive dictations, so caching on it is what actually fixes
/// the slowness: the LLM only reruns when the underlying vocabulary genuinely
/// changes, not on every `onHistoryChanged`/days-switch the tab used to fire.
static LLM_SUGGESTIONS_CACHE: once_cell::sync::Lazy<
    Mutex<std::collections::HashMap<String, Vec<crate::analysis::Suggestion>>>,
> = once_cell::sync::Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

/// LLM augmentation of the coach's word-upgrade suggestions — the ONLY command
/// that ever calls `/v1/word-upgrade` (a blocking network call, 30 s budget) and
/// therefore the ONLY one that can be slow. Cache-first (see
/// `LLM_SUGGESTIONS_CACHE`): a hit returns immediately with zero network. On a
/// miss, subscription mode off, or ANY failure/timeout, falls back to the same
/// local suggestions `learning_suggestions` returns — never an error outward.
///
/// `(async)`: the (possible) LLM call is blocking — a plain sync command would
/// run it on the MAIN thread and freeze the whole Wortschatz UI while it waits
/// (Tauri v2: sync commands run on the main thread). `(async)` spawns it on the
/// runtime's pool so the tab stays fluid even on a cache miss.
#[tauri::command(async)]
pub fn learning_suggestions_llm(state: State<'_, AppState>, days: Option<u32>) -> serde_json::Value {
    let texts = crate::store::history_texts_since(days.unwrap_or(30));
    let local = crate::analysis::local_suggestions(&texts);
    let cfg = state.config.lock().clone();
    let (source, suggestions) = if cfg.mode == "subunit" && !local.is_empty() {
        let key = format!(
            "{}|{}",
            cfg.language,
            local.iter().map(|s| s.word.as_str()).collect::<Vec<_>>().join(",")
        );
        let cached = LLM_SUGGESTIONS_CACHE.lock().get(&key).cloned();
        if let Some(hit) = cached {
            ("llm", hit)
        } else {
            match word_upgrade_curate(&cfg, &local) {
                Some(s) => {
                    LLM_SUGGESTIONS_CACHE.lock().insert(key, s.clone());
                    ("llm", s)
                }
                None => ("local", local),
            }
        }
    } else {
        ("local", local)
    };
    // Remember what the coach actually showed — only taught words can earn XP.
    // Runs for BOTH branches (local fallback incl.) — INSERT OR IGNORE, so a
    // word already remembered from the fast `learning_suggestions` path is a
    // harmless no-op here.
    let shown: Vec<String> = suggestions
        .iter()
        .flat_map(|s| s.alternatives.iter().map(|a| a.word.clone()))
        .collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    crate::store::suggested_words_add(&shown, source, now);
    serde_json::json!({ "source": source, "suggestions": suggestions })
}

/// Daily/weekly word goals (Activity rings). Struct param mirrors `set_config`,
/// sidestepping the Tauri v2 snake_case↔camelCase key convention.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct Goals {
    pub daily_word_goal: i64,
    pub weekly_word_goal: i64,
}

#[tauri::command]
pub fn goals_get(state: State<'_, AppState>) -> Goals {
    let c = state.config.lock();
    Goals {
        daily_word_goal: c.daily_word_goal,
        weekly_word_goal: c.weekly_word_goal,
    }
}

#[tauri::command]
pub fn goals_set(app: AppHandle, state: State<'_, AppState>, goals: Goals) -> Result<(), String> {
    {
        let mut c = state.config.lock();
        c.daily_word_goal = goals.daily_word_goal.max(0);
        c.weekly_word_goal = goals.weekly_word_goal.max(0);
        c.save().map_err(|e| e.to_string())?;
    }
    use tauri::Emitter;
    let _ = app.emit("echo://config-changed", ());
    Ok(())
}

/// Persist an Activity export (CSV/JSON built in TS, PNG from the Wrapped
/// poster canvas) into ~/Downloads and reveal it. There is no dialog/fs plugin
/// in this app — this tiny command is the whole persistence path. Returns the
/// written path.
#[tauri::command]
pub fn activity_export(kind: String, filename: String, contents_b64: String) -> Result<String, String> {
    if !matches!(kind.as_str(), "csv" | "json" | "png") {
        return Err(format!("unsupported export kind: {kind}"));
    }
    // Path hardening: a plain basename only — no separators, no traversal.
    if filename.trim().is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err("invalid filename".to_string());
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_b64.trim())
        .map_err(|e| format!("base64: {e}"))?;
    let dir = dirs::download_dir().unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("Downloads")
    });
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&filename);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    let shown = path.to_string_lossy().to_string();
    crate::meet::open_url(&shown);
    Ok(shown)
}

// ── Learning gamification (word-of-day pinning, XP, detection, leaderboard) ──
//
// The word of the day is PINNED once per local day (store::wod_log): the old
// pick-on-read would silently skip to the next unused word the moment you
// spoke today's word — nothing stable to recognize or celebrate. XP is a pure
// vocabulary currency: only taught words earn it (today's pinned word, coach
// alternatives that were actually shown, past words of the day).

pub const XP_WORD_OF_DAY: i64 = 50;
pub const XP_COACH_WORD: i64 = 20;
/// At most this many coach words earn XP per local day. Without a cap, every
/// word ever taught (pinned words of the day accumulate to 120+) pays again
/// every single day — reciting the list would out-earn every other activity.
pub const COACH_XP_DAILY_CAP: i64 = 5;

/// Level from total XP — cumulative quadratic thresholds (level n needs
/// 100·n² XP: 100, 400, 900, …). Returns (level, floor_xp, next_level_xp).
pub(crate) fn level_for_xp(xp: i64) -> (i64, i64, i64) {
    let mut level = 0i64;
    while 100 * (level + 1) * (level + 1) <= xp {
        level += 1;
    }
    (level, 100 * level * level, 100 * (level + 1) * (level + 1))
}

/// Inverse of `day_number` (Hinnant's civil_from_days) — days since epoch back
/// to 'YYYY-MM-DD'. Keeps the crate chrono-free like everything else here.
fn day_string(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let (y, m) = if mp < 10 { (yoe + era * 400, mp + 3) } else { (yoe + era * 400 + 1, mp - 9) };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Monday of the week containing `day` — the leaderboard's week key (calendar
/// weeks, not rolling windows, so everyone competes in the same frame).
pub(crate) fn week_monday(day: &str) -> String {
    match day_number(day) {
        // 1970-01-01 was a Thursday → Monday-based weekday index = (dn+3) mod 7.
        Some(dn) => day_string(dn - (((dn + 3) % 7 + 7) % 7)),
        None => day.to_string(),
    }
}

/// Today's pinned word of the day, pinning it first if this is the day's first
/// ask. The pick prefers words not dictated in the last 30 days; once pinned
/// the word stays for the whole day (detection + card agree).
fn ensure_wod_pinned(day: &str) -> String {
    if let Some(w) = crate::store::wod_get(day) {
        return w;
    }
    let texts = crate::store::history_texts_since(30);
    let recent: std::collections::HashSet<String> =
        texts.iter().flat_map(|t| crate::analysis::tokenize(t)).collect();
    let (entry, _) = crate::analysis::pick_word_of_day(day, &recent);
    crate::store::wod_pin(day, entry.word)
}

/// „Wort des Tages“ — the day's pinned pick with its curated card data.
/// `already_used` now means "used in a dictation TODAY" (XP ledger truth).
#[tauri::command]
pub fn word_of_day(state: State<'_, AppState>) -> serde_json::Value {
    let account = crate::presets::account_key(&state.config.lock());
    let day = crate::store::today_local();
    let word = ensure_wod_pinned(&day);
    let entry = crate::analysis::WORD_OF_DAY
        .iter()
        .find(|e| e.word.to_lowercase() == word.to_lowercase())
        .unwrap_or_else(|| {
            // Pinned word vanished from the curated list (version change) —
            // repin today deterministically so card + detection stay aligned.
            let texts = crate::store::history_texts_since(30);
            let recent: std::collections::HashSet<String> =
                texts.iter().flat_map(|t| crate::analysis::tokenize(t)).collect();
            let (e, _) = crate::analysis::pick_word_of_day(&day, &recent);
            crate::store::wod_replace(&day, e.word);
            e
        });
    serde_json::json!({
        "word": entry.word,
        "meaning": entry.meaning,
        "example": entry.example,
        "synonyms": entry.synonyms,
        "already_used": crate::store::learning_event_exists(&account, &day, "word_of_day"),
        "xp": XP_WORD_OF_DAY,
    })
}

/// Scan one delivered dictation for taught vocabulary and celebrate new hits:
/// XP ledger (idempotent per day+word), `echo://learning-reward` for the UI,
/// a native notification (the app is usually in the background while the user
/// dictates into another app), and a detached leaderboard sync.
pub fn maybe_award_vocab(app: &AppHandle, cfg: &Config, account: &str, text: &str, now: i64) {
    if text.trim().is_empty() {
        return;
    }
    let day = crate::store::today_local();
    if day.is_empty() {
        return;
    }
    let wod = ensure_wod_pinned(&day);
    let mut coach = crate::store::suggested_words_all();
    for w in crate::store::wod_words_before(&day, 120) {
        coach.insert(w.to_lowercase());
    }
    let (wod_hit, coach_hits) = crate::analysis::find_vocab_hits(text, &wod, &coach);
    let mut events: Vec<serde_json::Value> = Vec::new();
    if wod_hit
        && crate::store::learning_award(account, &day, "word_of_day", &wod, XP_WORD_OF_DAY, now)
    {
        events.push(serde_json::json!({ "kind": "word_of_day", "word": wod, "xp": XP_WORD_OF_DAY }));
    }
    let mut coach_today = crate::store::learning_kind_count(account, "coach_word", Some(&day));
    for w in coach_hits {
        if coach_today >= COACH_XP_DAILY_CAP {
            break;
        }
        if crate::store::learning_award(account, &day, "coach_word", &w, XP_COACH_WORD, now) {
            coach_today += 1;
            events.push(serde_json::json!({ "kind": "coach_word", "word": w, "xp": XP_COACH_WORD }));
        }
    }
    if events.is_empty() {
        return;
    }
    let xp_total = crate::store::learning_xp(account, None);
    let (level, _, _) = level_for_xp(xp_total);
    use tauri::Emitter;
    let _ = app.emit(
        "echo://learning-reward",
        serde_json::json!({ "events": events, "xp_total": xp_total, "level": level }),
    );
    push_learning_score_detached(cfg.clone(), account.to_string());
}

// ---- Wortdex: collectible word finds ----

/// XP per NEW find, by band. Deliberately below the word-of-the-day reward —
/// finds happen in passing, taught words are the actual work.
fn find_xp(band: crate::rarity::Band) -> i64 {
    use crate::rarity::Band::*;
    match band {
        Common => 5,
        Uncommon => 10,
        Rare => 20,
        Epic => 40,
        Mythic => 75,
        Legendary => 150,
    }
}

/// At most this many finds earn XP per local day — everything beyond is still
/// recorded in the collection, just without XP (anti-farming backstop).
const FIND_XP_DAILY_CAP: i64 = 3;

/// Scan one delivered dictation for collectible words (rarity tables) and
/// grow the Wortdex: every sighting bumps the collection, a NEW find awards
/// XP (day-capped) and the rarest new find of the dictation is celebrated via
/// `echo://word-find` + native notification (band >= selten).
///
/// Precision guards, in order: real sentences only (>= 8 tokens), the user's
/// own vocabulary terms never count (taught, not found), and a dictation whose
/// unique tokens are >40 % collectible is dropped entirely — that is someone
/// reading a word list, not speaking.
/// Pure detection core (unit-testable): collectible hits of one dictation,
/// rarest first — or None when a precision gate rejects the whole text.
/// Gates: >= 8 tokens (real sentences only), own vocabulary excluded (taught,
/// not found), and >40 % collectible unique tokens on a longer text = someone
/// reading a word list → drop everything.
fn detect_finds(
    text: &str,
    own: &std::collections::HashSet<String>,
) -> Option<Vec<(String, crate::rarity::Band, u16)>> {
    let tokens = crate::analysis::tokenize(text);
    if tokens.len() < 8 {
        return None;
    }
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut uniq: Vec<&String> = Vec::new();
    for t in &tokens {
        if seen.insert(t.as_str()) {
            uniq.push(t);
        }
    }
    let mut hits: Vec<(String, crate::rarity::Band, u16)> = uniq
        .iter()
        .filter_map(|t| {
            if own.contains(t.as_str()) {
                return None;
            }
            crate::rarity::lookup(t).map(|(b, d)| ((*t).clone(), b, d))
        })
        .collect();
    if hits.is_empty() {
        return None;
    }
    if uniq.len() >= 15 && hits.len() * 5 > uniq.len() * 2 {
        log::info!(
            "wortdex: skipped anomalous dictation ({} of {} unique tokens collectible)",
            hits.len(),
            uniq.len()
        );
        return None;
    }
    // Rarest first — the celebration slot and the XP budget go to the deepest words.
    hits.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
    Some(hits)
}

pub fn maybe_award_finds(app: &AppHandle, cfg: &Config, account: &str, text: &str, now: i64) {
    let day = crate::store::today_local();
    if day.is_empty() {
        return;
    }
    let own: std::collections::HashSet<String> = cfg
        .vocabulary
        .iter()
        .flat_map(|e| [e.write_as.trim().to_lowercase(), e.sounds_like.trim().to_lowercase()])
        .collect();
    let Some(hits) = detect_finds(text, &own) else { return };
    // Words the coach taught first (word of the day, coach words, weekly pack).
    // Speaking one of those is the learning loop paying INTO the collection, not
    // a spontaneous discovery — the Wortdex remembers which it was.
    let mut taught = crate::store::suggested_words_all();
    for w in crate::store::wod_words_before(&day, 120) {
        taught.insert(w.to_lowercase());
    }
    let surfaces = crate::analysis::surface_forms(text);
    let mut awarded_today =
        crate::store::learning_kind_count(account, "word_find", Some(&day));
    let mut celebrated: Option<serde_json::Value> = None;
    let mut any_new = false;
    for (word, band, dex) in hits {
        let display = surfaces.get(word.as_str()).cloned().unwrap_or_else(|| word.clone());
        // Privacy: with history disabled the user opted out of keeping dictation
        // text — the find keeps the WORD, never the sentence (Codex-Review #141).
        let context = if cfg.history_enabled {
            crate::analysis::context_sentence(text, &word)
        } else {
            String::new()
        };
        let origin = if taught.contains(&word) { "learned" } else { "found" };
        let is_new = crate::store::word_find_record(
            account,
            &word,
            &display,
            band.as_i64(),
            dex as i64,
            &context,
            now,
            origin,
        );
        if !is_new {
            continue;
        }
        any_new = true;
        let mut xp = 0;
        if awarded_today < FIND_XP_DAILY_CAP
            && crate::store::learning_award(account, &day, "word_find", &word, find_xp(band), now)
        {
            awarded_today += 1;
            xp = find_xp(band);
        }
        // Emit for the rarest new find even beyond the daily XP cap — an open
        // Wortdex must refresh on every growth; the UI gates its toast on
        // xp > 0 (Codex-Review #141). Notifications stay XP-only.
        if celebrated.is_none() {
            celebrated = Some(serde_json::json!({
                "word": word,
                "display": display,
                "band": band.as_i64(),
                "dex": dex,
                "xp": xp,
                "counts": crate::store::word_find_band_counts(account),
            }));
        }
    }
    if let Some(payload) = celebrated {
        use tauri::Emitter;
        let _ = app.emit("echo://word-find", payload);
    }
    if any_new {
        push_learning_score_detached(cfg.clone(), account.to_string());
    }
}


/// The collection for the Wortdex tab: rows + per-band counts. 100% local.
#[tauri::command]
pub fn wortdex_list(state: State<'_, AppState>) -> serde_json::Value {
    let account = crate::presets::account_key(&state.config.lock());
    // counts[0]=Gewoehnlich .. counts[5]=Legendaer.
    serde_json::json!({
        "finds": crate::store::word_finds_list(&account, 5000),
        "counts": crate::store::word_find_band_counts(&account),
    })
}

/// Achievement catalog: (id, target). Computed on demand from existing data —
/// no persistence, no migration, always consistent with the ledgers. Each id
/// doubles as an equippable account title (learning.titles.<id> in the UI);
/// `config.learning_title` stores the equipped id.
const ACHIEVEMENTS: &[(&str, i64)] = &[
    ("first_rare", 1),
    ("first_epic", 1),
    ("first_mythic", 1),
    ("first_legendary", 1),
    ("finds_10", 10),
    ("finds_50", 50),
    ("finds_200", 200),
    ("wod_7", 7),
    ("wod_30", 30),
    ("coach_25", 25),
    ("streak_7", 7),
    ("streak_30", 30),
    ("level_5", 5),
    ("level_10", 10),
];

/// Raw progress for one achievement id from the already-gathered ledger inputs.
/// Pure and total — the single source of truth for the id→progress mapping, so
/// the UI list, the earned-id push and any future reader all agree. Returns the
/// progress BEFORE the display clamp; callers compare it against the target to
/// derive the earned state.
fn achievement_progress(
    id: &str,
    counts: &[i64; 6], // [Gewoehnlich..Legendaer]
    finds_total: i64,
    wod: i64,
    coach: i64,
    longest_streak: i64,
    level: i64,
) -> i64 {
    match id {
        "first_rare" => counts[2].min(1),
        "first_epic" => counts[3].min(1),
        "first_mythic" => counts[4].min(1),
        "first_legendary" => counts[5].min(1),
        "finds_10" | "finds_50" | "finds_200" => finds_total,
        "wod_7" | "wod_30" => wod,
        "coach_25" => coach,
        "streak_7" | "streak_30" => longest_streak,
        "level_5" | "level_10" => level,
        _ => 0,
    }
}

/// Every achievement as `(id, target, raw_progress, earned_ts)`. Gathers the
/// ledgers once and routes progress through `achievement_progress`, so both the
/// UI list (`achievements_list`) and the leaderboard push (`earned_achievement_ids`)
/// build on identical numbers — no logic drift. `earned` is `raw_progress >=
/// target`; `earned_ts` is only meaningful once earned (the datable ids look up
/// their moment; the rest are `None`).
fn achievement_states(account: &str) -> Vec<(&'static str, i64, i64, Option<i64>)> {
    let counts = crate::store::word_find_band_counts(account); // [Gewoehnlich..Legendaer]
    let finds_total: i64 = counts.iter().sum();
    let wod = crate::store::learning_kind_count(account, "word_of_day", None);
    let coach = crate::store::learning_kind_count(account, "coach_word", None);
    let (_, longest_streak, _, _) = compute_streak(account);
    let (level, _, _) = level_for_xp(crate::store::learning_xp(account, None));
    ACHIEVEMENTS
        .iter()
        .map(|(id, target)| {
            let progress = achievement_progress(
                id, &counts, finds_total, wod, coach, longest_streak, level,
            );
            let earned_ts: Option<i64> = match *id {
                "first_rare" => crate::store::word_find_first_ts(account, 3),
                "first_epic" => crate::store::word_find_first_ts(account, 4),
                "first_mythic" => crate::store::word_find_first_ts(account, 5),
                "first_legendary" => crate::store::word_find_first_ts(account, 6),
                "finds_10" | "finds_50" | "finds_200" => {
                    crate::store::word_finds_nth_ts(account, *target as u32)
                }
                _ => None,
            };
            (*id, *target, progress, earned_ts)
        })
        .collect()
}

/// All achievements with progress + earned state (and, where the ledgers can
/// date it, the moment it was earned).
#[tauri::command]
pub fn achievements_list(state: State<'_, AppState>) -> Vec<serde_json::Value> {
    let account = crate::presets::account_key(&state.config.lock());
    achievement_states(&account)
        .into_iter()
        .map(|(id, target, progress, earned_ts)| {
            let earned = progress >= target;
            serde_json::json!({
                "id": id,
                "target": target,
                "progress": progress.min(target),
                "earned": earned,
                "earned_ts": if earned { earned_ts } else { None },
            })
        })
        .collect()
}

/// The ids the account has earned (`progress >= target`), in catalog order —
/// the compact form the leaderboard push ships so a member's profile card can
/// render its badges. Shares `achievement_states`, so it can never disagree
/// with what `achievements_list` shows the same account.
pub(crate) fn earned_achievement_ids(account: &str) -> Vec<String> {
    achievement_states(account)
        .into_iter()
        .filter(|(_, target, progress, _)| progress >= target)
        .map(|(id, ..)| id.to_string())
        .collect()
}

// ---- Prompt-Coach (Welle 5) ----

/// Prompt-Coach dashboard over the last `days` (default 30). Reads the prompt
/// dictations from history and re-derives the rubric per row (deterministic, so
/// it matches what was scored at capture). `enough` gates the UI until there's a
/// meaningful sample (≥ 5 prompts). All local, no network.
#[tauri::command]
pub fn prompt_coach_stats(state: State<'_, AppState>, days: Option<u32>) -> serde_json::Value {
    let _ = &state; // history is a single local store (not account-partitioned)
    let days = days.unwrap_or(30).clamp(1, 365);
    let rows = crate::store::prompt_history_since(days);
    let prompts = rows.len() as i64;

    let mut score_sum = 0i64;
    let mut scored = 0i64;
    let (mut goal, mut context, mut constraints, mut format, mut negative) = (0i64, 0i64, 0i64, 0i64, 0i64);
    // app -> (n, score_sum, scored_n)
    let mut by_app: std::collections::HashMap<String, (i64, i64, i64)> = std::collections::HashMap::new();
    for (_ts, app, score, text) in &rows {
        let (_s, rub) = crate::prompt_coach::score_prompt(text);
        goal += rub["goal"].as_bool().unwrap_or(false) as i64;
        context += rub["context"].as_bool().unwrap_or(false) as i64;
        constraints += rub["constraints"].as_bool().unwrap_or(false) as i64;
        format += rub["format"].as_bool().unwrap_or(false) as i64;
        negative += rub["negative"].as_bool().unwrap_or(false) as i64;
        let key = if app.is_empty() { "—".to_string() } else { app.clone() };
        let e = by_app.entry(key).or_insert((0, 0, 0));
        e.0 += 1;
        if let Some(sc) = score {
            score_sum += *sc;
            scored += 1;
            e.1 += *sc;
            e.2 += 1;
        }
    }
    let avg_score = if scored > 0 { (score_sum as f64 / scored as f64).round() as i64 } else { 0 };
    // Hit rate over ALL prompts (every prompt row has a re-derived rubric),
    // rounded to 2 decimals.
    let rate = |c: i64| -> f64 {
        if prompts > 0 {
            (c as f64 / prompts as f64 * 100.0).round() / 100.0
        } else {
            0.0
        }
    };

    // Top 6 apps by prompt count.
    let mut apps: Vec<(i64, serde_json::Value)> = by_app
        .into_iter()
        .map(|(app, (n, ssum, sn))| {
            let avg = if sn > 0 { (ssum as f64 / sn as f64).round() as i64 } else { 0 };
            (n, serde_json::json!({ "app": app, "n": n, "avg": avg }))
        })
        .collect();
    apps.sort_by(|a, b| b.0.cmp(&a.0));
    let apps: Vec<serde_json::Value> = apps.into_iter().take(6).map(|(_, v)| v).collect();

    // Score trend by local day (oldest first), avg rounded to an integer.
    let trend: Vec<serde_json::Value> = crate::store::prompt_trend_since(days)
        .into_iter()
        .map(|(day, avg, n)| serde_json::json!({ "day": day, "avg": avg.round() as i64, "n": n }))
        .collect();

    // Most recent prompts (rows are already newest-first), head = first 80 chars.
    let recent: Vec<serde_json::Value> = rows
        .iter()
        .take(10)
        .map(|(ts, app, score, text)| {
            let head: String = text.chars().take(80).collect();
            serde_json::json!({ "ts": ts, "app": app, "score": score, "head": head })
        })
        .collect();

    serde_json::json!({
        "enough": prompts >= 5,
        "prompts": prompts,
        "avg_score": avg_score,
        "rubric_rates": {
            "goal": rate(goal),
            "context": rate(context),
            "constraints": rate(constraints),
            "format": rate(format),
            "negative": rate(negative),
        },
        "by_app": apps,
        "trend": trend,
        "recent": recent,
    })
}

/// Today's prompt pattern for the home card: its id (i18n key), the XP it earns,
/// and whether it was already applied+rewarded today.
#[tauri::command]
pub fn prompt_pattern_today(state: State<'_, AppState>) -> serde_json::Value {
    let account = crate::presets::account_key(&state.config.lock());
    let day = crate::store::today_local();
    let pat = crate::prompt_coach::pick_pattern(&day);
    serde_json::json!({
        "id": pat.id,
        "xp": crate::prompt_coach::PROMPT_PATTERN_XP,
        "done_today": crate::store::learning_event_exists(&account, &day, "prompt_pattern"),
    })
}


/// Best-effort leaderboard sync over the subunit lane (detached — never
/// delays a dictation). Mirrors word_upgrade_curate's endpoint/auth recipe.
pub(crate) fn push_learning_score_detached(cfg: Config, account: String) {
    if cfg.mode != "subunit" {
        return;
    }
    std::thread::spawn(move || push_learning_score(&cfg, &account));
}

fn push_learning_score(cfg: &Config, account: &str) {
    let day = crate::store::today_local();
    if day.is_empty() {
        return;
    }
    let week = week_monday(&day);
    let name = {
        let nick = cfg.nickname.trim();
        let disp = cfg.display_name.trim();
        if !nick.is_empty() { nick } else { disp }
    };
    let url = cfg.subunit_endpoint.replace("/v1/transcribe", "/v1/learning/score");
    // Profile payload for the clickable leaderboard cards: the member's earned
    // badge ids + the three PRESTIGE Wortdex tiers [Episch, Mythisch, Legendär].
    // The server contract keeps three band slots (unchanged), so we surface the
    // top three of the six local tiers — the ones worth showing off; the profile
    // renders them with their own labels. (Full 6-tier leaderboard = server work.)
    let earned = earned_achievement_ids(account);
    let counts = crate::store::word_find_band_counts(account); // [Gewoehnlich..Legendaer]
    let mut req = crate::http::client()
        .post(&url)
        .timeout(std::time::Duration::from_secs(10))
        .json(&serde_json::json!({
            "week": week,
            "xp_week": crate::store::learning_xp(account, Some(&week)),
            "xp_total": crate::store::learning_xp(account, None),
            "words": crate::store::learning_distinct_words(account),
            "name": name,
            // Equipped achievement title (id) — rendered locale-side by every
            // client; unknown/empty ids are simply not shown.
            "title": cfg.learning_title,
            "achievements": earned,
            "bands": [counts[3], counts[4], counts[5]], // Episch, Mythisch, Legendär
            // Account profile-picture URL so the leaderboard can show this
            // member's photo to everyone else. Empty/None → the row stays on
            // initials; old servers ignore the extra field.
            "avatar": cfg.avatar_url.clone().unwrap_or_default(),
        }));
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else if !cfg.subunit_api_key.is_empty() {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    } else {
        return;
    }
    let _ = req.send();
}

/// XP state for the Wortschatz header: totals, level maths, today's word-of-
/// day status and the recent award feed. 100% local.
#[tauri::command]
pub fn learning_xp(state: State<'_, AppState>) -> serde_json::Value {
    let account = crate::presets::account_key(&state.config.lock());
    let day = crate::store::today_local();
    let week = week_monday(&day);
    let xp_total = crate::store::learning_xp(&account, None);
    let (level, level_floor_xp, next_level_xp) = level_for_xp(xp_total);
    serde_json::json!({
        "xp_total": xp_total,
        "xp_week": crate::store::learning_xp(&account, Some(&week)),
        "level": level,
        "level_floor_xp": level_floor_xp,
        "next_level_xp": next_level_xp,
        "wod_used_today": crate::store::learning_event_exists(&account, &day, "word_of_day"),
        "distinct_words": crate::store::learning_distinct_words(&account),
        "events": crate::store::learning_events_recent(&account, 10),
    })
}

/// Today's XP menu for the daily-tasks card: every way to earn XP right now,
/// each with its reward and done state — all read from the same local ledgers
/// the award paths write, so a checked-off task can never disagree with the XP
/// header. 100% local (SQLite only).
#[tauri::command]
pub fn learning_daily_tasks(state: State<'_, AppState>) -> serde_json::Value {
    let cfg = state.config.lock().clone();
    let account = crate::presets::account_key(&cfg);
    let day = crate::store::today_local();
    let day_num = day_number(&day).unwrap_or(0);

    // Word of the day (pins today's word as a side effect, same as `word_of_day`).
    let wod = ensure_wod_pinned(&day);
    let wod_done = crate::store::learning_event_exists(&account, &day, "word_of_day");

    // Coach words that still pay today: the taught pool (shown suggestions +
    // earlier pinned words of the day) minus today's credits and the current
    // word of the day, rotated by the day number so the card offers fresh
    // words each day instead of pinning the alphabet's first three forever.
    let credited: std::collections::HashSet<String> = crate::store::learning_words_today(
        &account,
        &day,
        "coach_word",
    )
    .into_iter()
    .collect();
    let mut pool: Vec<String> = crate::store::suggested_words_all().into_iter().collect();
    for w in crate::store::wod_words_before(&day, 120) {
        pool.push(w.to_lowercase());
    }
    pool.sort();
    pool.dedup();
    pool.retain(|w| !credited.contains(w) && *w != wod.to_lowercase());
    let coach_words: Vec<String> = if pool.is_empty() {
        Vec::new()
    } else {
        let start = (day_num.max(0) as usize) % pool.len();
        pool.iter().cycle().skip(start).take(3.min(pool.len())).cloned().collect()
    };
    let coach_today = crate::store::learning_kind_count(&account, "coach_word", Some(&day));

    // Rhetoric dojo: today's rotating exercise; XP is once per day.
    let ex = crate::dojo::pick_exercise(&day, day_num);
    let dojo_done = crate::store::learning_event_exists(&account, &day, "dojo");

    // Kata path: daily training XP + the next unfinished kata (once-ever XP).
    let kata_train_done = crate::store::learning_event_exists(&account, &day, "kata_train");
    let completed: std::collections::HashSet<String> = crate::store::kata_all(&account)
        .into_iter()
        .filter(|(_, _, done)| *done != 0)
        .map(|(id, _, _)| id)
        .collect();
    let next_kata = crate::kata::KATAS
        .iter()
        .find(|k| !completed.contains(k.id))
        .map(|k| k.id);

    // Prompt pattern of the day (once per day).
    let pat = crate::prompt_coach::pick_pattern(&day);
    let pattern_done = crate::store::learning_event_exists(&account, &day, "prompt_pattern");

    // Wortdex finds: XP-capped per day; the collection itself never caps.
    let finds_today = crate::store::learning_kind_count(&account, "word_find", Some(&day));

    serde_json::json!({
        "wod": { "word": wod, "xp": XP_WORD_OF_DAY, "done": wod_done },
        "coach": {
            "words": coach_words,
            "xp_each": XP_COACH_WORD,
            "earned_today": coach_today,
            "cap": COACH_XP_DAILY_CAP,
        },
        "dojo": { "kind": ex.kind.as_str(), "xp": crate::dojo::DOJO_XP, "done": dojo_done },
        "kata": {
            "train_done": kata_train_done,
            "train_xp": crate::kata::KATA_TRAIN_XP,
            "next": next_kata,
            "next_xp": crate::kata::KATA_XP,
        },
        "pattern": { "id": pat.id, "xp": crate::prompt_coach::PROMPT_PATTERN_XP, "done": pattern_done },
        "finds": { "today": finds_today, "cap": FIND_XP_DAILY_CAP },
    })
}

/// Deterministic Sprechprofil: six rhetoric dimensions (0–100) over the last
/// `days` (default 30) with sub-metrics, a "ghost" polygon (the same window one
/// period earlier) and rule-based insights (recent 7 days vs. the previous 30).
/// 100% local, no network.
///
/// `(async)`: on a cold cache the per-day backfill tokenizes up to ~5000 history
/// texts and runs MTLD + the heuristic passes; as a sync command that would
/// freeze the Learning tab on open. Warm calls only recompute days with new
/// dictations (the rest come straight from `speech_daily`).
#[tauri::command(async)]
pub fn speech_profile(state: State<'_, AppState>, days: Option<u32>) -> serde_json::Value {
    let account = crate::presets::account_key(&state.config.lock());
    let days = days.unwrap_or(30).clamp(1, 3650);
    // Window + one period earlier (ghost) + a 37-day span for the insight
    // baseline (recent 7 days vs. the previous 30).
    let lookback = (days * 2).max(37);
    let rows = crate::store::speech_daily_collect(&account, lookback);

    // ISO day cutoffs: window is [today-(days-1) .. today]; ghost the period
    // before it; insight windows at 6 / 36 days back.
    let win_from = crate::store::local_date_offset((days - 1) as i64);
    let ghost_from = crate::store::local_date_offset((days * 2 - 1) as i64);
    let recent_from = crate::store::local_date_offset(6);
    let base_from = crate::store::local_date_offset(36);

    let pick = |lo: &str, hi: Option<&str>| {
        crate::speech_profile::aggregate(
            rows.iter()
                .filter(|(d, _)| d.as_str() >= lo && hi.map_or(true, |h| d.as_str() < h))
                .map(|(_, s)| s),
        )
    };
    let window = pick(&win_from, None);
    let ghost = pick(&ghost_from, Some(&win_from));
    let recent7 = pick(&recent_from, None);
    let prev30 = pick(&base_from, Some(&recent_from));

    let window_texts = crate::store::history_texts_since(days);
    crate::speech_profile::build_profile(&window, &window_texts, Some(&ghost), &recent7, &prev30, days)
}

/// Per-day Sprechprofil trend (overall + the six scores per day, ascending, only
/// days with ≥ 50 words) for the dimension sparklines. Local; `(async)` for the
/// same cold-cache reason as `speech_profile`.
#[tauri::command(async)]
pub fn speech_profile_trend(state: State<'_, AppState>, days: Option<u32>) -> serde_json::Value {
    let account = crate::presets::account_key(&state.config.lock());
    let days = days.unwrap_or(30).clamp(1, 3650);
    let rows = crate::store::speech_daily_collect(&account, days);
    crate::speech_profile::build_trend(&rows)
}

/// Community leaderboard („wer erweitert seinen Wortschatz am meisten?“):
/// pushes the own score, then fetches this week's board. Subscription mode
/// only; ANY failure degrades to {"available": false} — the card just hides.
///
/// `(async)`: push + fetch are two blocking network calls (10 s each). As a
/// sync command they would run on the MAIN thread and freeze the Wortschatz
/// tab for up to 20 s on open; `(async)` moves them onto the runtime pool.
#[tauri::command(async)]
pub fn learning_leaderboard(state: State<'_, AppState>) -> serde_json::Value {
    let cfg = state.config.lock().clone();
    let unavailable = serde_json::json!({ "available": false });
    if cfg.mode != "subunit" {
        return unavailable;
    }
    let account = crate::presets::account_key(&cfg);
    push_learning_score(&cfg, &account); // board should include "me" right away
    let day = crate::store::today_local();
    let week = week_monday(&day);
    let url = cfg.subunit_endpoint.replace("/v1/transcribe", "/v1/learning/leaderboard");
    let mut req = crate::http::client()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .query(&[("week", week.as_str())]);
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else if !cfg.subunit_api_key.is_empty() {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    } else {
        return unavailable;
    }
    let Ok(resp) = req.send() else { return unavailable };
    if !resp.status().is_success() {
        return unavailable;
    }
    let Ok(mut body) = resp.json::<serde_json::Value>() else { return unavailable };
    if let Some(o) = body.as_object_mut() {
        o.insert("available".into(), serde_json::json!(true));
        return body;
    }
    unavailable
}

// ── Lern-Loop (Welle 3): ownership stages, weekly word packs, weekly report ──
//
// Spaced repetition over REAL dictations. The XP ledger already records one row
// per (account, day, kind, word), so distinct usage DAYS per taught word are
// readable straight from it — no new detection write path. Stages and due-state
// are pure functions of that footprint (below), unit-tested in isolation.

/// Ownership stage of a taught word from its usage footprint. Pure — the sole
/// source of truth for the three tiers, unit-tested at the boundaries.
/// `span_days` = last_day − first_day (in days).
///   used      — ≥1 usage day (the floor)
///   fortified — ≥3 usage days AND span ≥7 days
///   mastered  — ≥5 usage days AND span ≥21 days
fn word_stage(use_days: i64, span_days: i64) -> &'static str {
    if use_days >= 5 && span_days >= 21 {
        "mastered"
    } else if use_days >= 3 && span_days >= 7 {
        "fortified"
    } else {
        "used"
    }
}

/// Whether a taught word is DUE for a refresh dictation. Pure, unit-tested.
/// `days_since_last` = today − last_day. used → ≥3 d, fortified → ≥7 d,
/// mastered → never (it's owned).
fn word_due(stage: &str, days_since_last: i64) -> bool {
    match stage {
        "used" => days_since_last >= 3,
        "fortified" => days_since_last >= 7,
        _ => false,
    }
}

/// Ownership board for the Lern-Loop: every taught word with its stage, usage
/// footprint and due-state, `due` first then oldest `last_day` first. 100% local
/// (reads the XP ledger); the UI renders the spaced-repetition queue from this.
#[tauri::command]
pub fn learning_words_progress(state: State<'_, AppState>) -> serde_json::Value {
    let account = crate::presets::account_key(&state.config.lock());
    let today_n = day_number(&crate::store::today_local());
    let usage = crate::store::learning_word_usage(&account);
    let mut due_count = 0i64;
    // (due, last_day_number, payload) — sorted after the pass.
    let mut rows: Vec<(bool, i64, serde_json::Value)> = Vec::with_capacity(usage.len());
    for (word, use_days, first_day, last_day) in usage {
        let last_n = day_number(&last_day);
        let span = match (day_number(&first_day), last_n) {
            (Some(f), Some(l)) => l - f,
            _ => 0,
        };
        let stage = word_stage(use_days, span);
        // Days since last use — only meaningful with both dates parsed.
        let since_last = match (today_n, last_n) {
            (Some(t), Some(l)) => t - l,
            _ => 0,
        };
        let due = word_due(stage, since_last);
        if due {
            due_count += 1;
        }
        rows.push((
            due,
            last_n.unwrap_or(0),
            serde_json::json!({
                "word": word,
                "stage": stage,
                "use_days": use_days,
                "first_day": first_day,
                "last_day": last_day,
                "due": due,
            }),
        ));
    }
    // due first (true before false), then last_day ascending (stalest first).
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let words: Vec<serde_json::Value> = rows.into_iter().map(|(_, _, v)| v).collect();
    serde_json::json!({ "words": words, "due_count": due_count })
}

/// Shape a cached pack payload (`{"words":[{word,meaning,example,why}]}`) into
/// the wire response, enriching every word with its LIVE `use_days` from the XP
/// ledger (a cached pack never goes stale on progress).
fn pack_response(week: &str, payload: &str, usage: &[(String, i64, String, String)]) -> serde_json::Value {
    let parsed: serde_json::Value = serde_json::from_str(payload).unwrap_or(serde_json::json!({}));
    let items = parsed.get("words").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let use_days: std::collections::HashMap<String, i64> =
        usage.iter().map(|(w, d, _, _)| (w.to_lowercase(), *d)).collect();
    let words: Vec<serde_json::Value> = items
        .iter()
        .map(|it| {
            let word = it.get("word").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let n = use_days.get(&word.to_lowercase()).copied().unwrap_or(0);
            serde_json::json!({
                "word": word,
                "meaning": it.get("meaning").and_then(|v| v.as_str()).unwrap_or(""),
                "example": it.get("example").and_then(|v| v.as_str()).unwrap_or(""),
                "why": it.get("why").and_then(|v| v.as_str()).unwrap_or(""),
                "use_days": n,
            })
        })
        .collect();
    serde_json::json!({ "week": week, "source": "llm", "words": words })
}

/// This week's personalized word pack from cache. `use_days` per word is read
/// LIVE from the ledger; no cache yet → `source:"none"`, empty words. 100% local.
#[tauri::command]
pub fn word_pack_get(state: State<'_, AppState>) -> serde_json::Value {
    let account = crate::presets::account_key(&state.config.lock());
    let week = week_monday(&crate::store::today_local());
    match crate::store::word_pack_get(&account, &week) {
        Some(payload) => {
            let usage = crate::store::learning_word_usage(&account);
            pack_response(&week, &payload, &usage)
        }
        None => serde_json::json!({ "week": week, "source": "none", "words": [] }),
    }
}

/// Personal rhetoric + vocabulary coach (LLM, subscription lane).
///
/// The ONLY learning feature that sends dictation EXCERPTS off the device, so it
/// is hard-gated on `cfg.coach_llm_enabled` (opt-in, default OFF) on top of the
/// usual subunit-mode gate. Everything it sends besides the excerpts is already
/// derived locally: the six on-device rhetoric scores, the vocabulary metrics
/// and the words the coach has taught (so it never re-teaches).
///
/// Best-effort like every other LLM lane: any failure returns
/// `{available:false}` and the UI simply keeps its local content.
#[tauri::command(async)]
pub fn learning_coach(state: State<'_, AppState>, days: Option<u32>) -> serde_json::Value {
    let unavailable = serde_json::json!({ "available": false });
    let cfg = state.config.lock().clone();
    if cfg.mode != "subunit" || !cfg.coach_llm_enabled {
        return unavailable;
    }
    let days = days.unwrap_or(30).clamp(7, 90);

    let texts = crate::store::history_texts_since(days);
    if texts.len() < 3 {
        return unavailable; // too little to say anything honest about
    }
    let stats = crate::analysis::learning(&texts);
    let overused: Vec<serde_json::Value> = stats
        .overused_words
        .iter()
        .take(8)
        .map(|o| serde_json::json!({ "word": o.word, "count": o.count }))
        .collect();
    let weak: Vec<String> = stats.weak_words.iter().take(10).map(|w| w.word.clone()).collect();
    let known: Vec<String> = crate::store::suggested_words_all().into_iter().take(60).collect();
    // The excerpts — bounded on purpose: enough for the coach to hear HOW the
    // user writes, never the whole history.
    let samples: Vec<String> = texts
        .iter()
        .take(8)
        .map(|t| t.chars().take(300).collect::<String>())
        .collect();

    // Rhetoric scores from the SAME on-device engine the Sprechprofil renders,
    // so both surfaces always agree (and the server never re-derives them).
    let prof = speech_profile(state, Some(days));
    let mut rhetoric = serde_json::Map::new();
    if let Some(o) = prof.get("overall").and_then(|v| v.as_f64()) {
        rhetoric.insert("overall".into(), serde_json::json!(o.round() as i64));
    }
    if let Some(dims) = prof.get("dimensions").and_then(|v| v.as_array()) {
        for d in dims {
            if let (Some(k), Some(s)) = (
                d.get("key").and_then(|v| v.as_str()),
                d.get("score").and_then(|v| v.as_f64()),
            ) {
                rhetoric.insert(k.to_string(), serde_json::json!(s.round() as i64));
            }
        }
    }

    let mut body = serde_json::json!({
        "samples": samples,
        "rhetoric": rhetoric,
        "unique_words": stats.unique_words,
        "ttr": stats.type_token_ratio * 100.0,
        "avg_sentence": stats.avg_sentence_length,
        "overused": overused,
        "weak": weak,
        "known_words": known,
    });
    if cfg.language != "auto" {
        body["language"] = serde_json::json!(cfg.language);
    }

    let url = cfg.subunit_endpoint.replace("/v1/transcribe", "/v1/learning/coach");
    let mut req = crate::http::client()
        .post(&url)
        // Measured: the lane needs ~52 s for a full coaching pass, and the
        // server gives it 110 s — the client must outlast that, never cut it off.
        .timeout(std::time::Duration::from_secs(130))
        .json(&body);
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else if !cfg.subunit_api_key.is_empty() {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    } else {
        return unavailable;
    }
    let Ok(resp) = req.send() else { return unavailable };
    if !resp.status().is_success() {
        return unavailable;
    }
    let Ok(j) = resp.json::<serde_json::Value>() else { return unavailable };
    let Some(coach) = j.get("coach") else { return unavailable };
    let verdict = coach.get("verdict").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if verdict.is_empty() {
        return unavailable; // an empty verdict is not worth a card
    }
    serde_json::json!({
        "available": true,
        "verdict": verdict,
        "strengths": coach.get("strengths").cloned().unwrap_or(serde_json::json!([])),
        "improvements": coach.get("improvements").cloned().unwrap_or(serde_json::json!([])),
        "words": coach.get("words").cloned().unwrap_or(serde_json::json!([])),
    })
}

/// Fetch a fresh personalized word pack from the server, cache it for this week,
/// and register its words for detection + XP (the coach_word path). Mirrors
/// `word_upgrade_curate`'s endpoint/auth recipe. `(async)`: the lane really takes
/// ~37 s (timeout 50 s), so a sync command would freeze the tab; on ANY failure
/// or an empty pack it returns `{"source":"error"}` and never touches the cache.
/// Subscription mode only.
#[tauri::command(async)]
pub fn word_pack_fetch(state: State<'_, AppState>) -> serde_json::Value {
    let err = || serde_json::json!({ "source": "error" });
    let cfg = state.config.lock().clone();
    if cfg.mode != "subunit" {
        return err();
    }
    let account = crate::presets::account_key(&cfg);
    let day = crate::store::today_local();
    if day.is_empty() {
        return err();
    }
    let week = week_monday(&day);

    // Local request context: over-used words (top 8), the user's domain
    // vocabulary (top non-weak content words), and everything already known so
    // the server never re-teaches (coach universe + past words of the day + the
    // words of every prior pack, deduped, capped at 60).
    let texts = crate::store::history_texts_since(30);
    let stats = crate::analysis::learning(&texts);
    let overused: Vec<serde_json::Value> = stats
        .overused_words
        .iter()
        .take(8)
        .map(|o| serde_json::json!({ "word": o.word, "count": o.count }))
        .collect();
    let domain_words: Vec<String> = stats
        .top_words
        .iter()
        .filter(|w| !crate::analysis::is_weak_word(&w.word))
        .take(10)
        .map(|w| w.word.clone())
        .collect();
    let mut known: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut push_known = |w: String, known: &mut Vec<String>, seen: &mut std::collections::HashSet<String>| {
        let c = w.trim().to_lowercase();
        if !c.is_empty() && seen.insert(c.clone()) {
            known.push(c);
        }
    };
    for w in crate::store::suggested_words_all() {
        push_known(w, &mut known, &mut seen);
    }
    for w in crate::store::wod_words_before(&day, 200) {
        push_known(w, &mut known, &mut seen);
    }
    for payload in crate::store::word_packs_payloads(&account) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&payload) {
            if let Some(arr) = v.get("words").and_then(|x| x.as_array()) {
                for it in arr {
                    if let Some(w) = it.get("word").and_then(|x| x.as_str()) {
                        push_known(w.to_string(), &mut known, &mut seen);
                    }
                }
            }
        }
    }
    known.truncate(60);

    let mut body = serde_json::json!({
        "overused": overused,
        "domain_words": domain_words,
        "known_words": known,
    });
    if cfg.language != "auto" {
        body["language"] = serde_json::json!(cfg.language);
    }

    let url = cfg.subunit_endpoint.replace("/v1/transcribe", "/v1/word-packs");
    let mut req = crate::http::client()
        .post(&url)
        .timeout(std::time::Duration::from_secs(50)) // lane runs ~37 s
        .json(&body);
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else if !cfg.subunit_api_key.is_empty() {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    } else {
        return err();
    }
    let Ok(resp) = req.send() else { return err() };
    if !resp.status().is_success() {
        return err();
    }
    let Ok(j) = resp.json::<serde_json::Value>() else { return err() };
    let Some(pack) = j.get("pack").and_then(|v| v.as_array()) else { return err() };
    let items: Vec<serde_json::Value> = pack
        .iter()
        .filter_map(|p| {
            let word = p.get("word")?.as_str()?.trim().to_string();
            if word.is_empty() {
                return None;
            }
            let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            Some(serde_json::json!({
                "word": word,
                "meaning": s("meaning"),
                "example": s("example"),
                "why": s("why"),
            }))
        })
        .collect();
    if items.is_empty() {
        return err(); // never overwrite the cache with an empty pack
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let payload = serde_json::json!({ "words": items }).to_string();
    crate::store::word_pack_upsert(&account, &week, &payload, now);
    // Registering the words on the coach path wires detection + XP automatically.
    let pack_words: Vec<String> = items
        .iter()
        .filter_map(|i| i.get("word").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    crate::store::suggested_words_add(&pack_words, "pack", now);
    let usage = crate::store::learning_word_usage(&account);
    pack_response(&week, &payload, &usage)
}

/// The newest weekly report (or null when none has been generated yet). 100%
/// local — `maybe_weekly_report` builds and persists them on the dictation path.
#[tauri::command]
pub fn weekly_report_get(state: State<'_, AppState>) -> serde_json::Value {
    let account = crate::presets::account_key(&state.config.lock());
    match crate::store::weekly_report_latest(&account) {
        Some(p) => serde_json::from_str(&p).unwrap_or(serde_json::Value::Null),
        None => serde_json::Value::Null,
    }
}

/// Once-per-week guard: on the FIRST dictation of a new calendar week, build the
/// deterministic report for the week that just CLOSED (XP this week vs. before,
/// new finds), persist it, emit `echo://weekly-report` + a native notification,
/// and stamp the guard so it fires exactly once. Cheap enough to run inline on
/// the dictation path: two string compares when not due, a handful of COUNT
/// queries otherwise (no network). An empty previous week is silently skipped
/// (guard still advances) so nobody gets a "0 XP" notification on/after install.
fn maybe_weekly_report(app: &AppHandle, state: &State<'_, AppState>, cfg: &Config, account: &str, now: i64) {
    if !cfg.weekly_report_enabled {
        return;
    }
    let today = crate::store::today_local();
    if today.is_empty() {
        return;
    }
    let this_mo = week_monday(&today);
    if this_mo == cfg.last_weekly_report_week {
        return; // already handled this week (the common case, 2 string ops)
    }
    let Some(this_dn) = day_number(&this_mo) else { return };
    let prev_mo = day_string(this_dn - 7);
    let prevprev_mo = day_string(this_dn - 14);
    let xp = crate::store::learning_xp_between(account, &prev_mo, &this_mo);
    let xp_before = crate::store::learning_xp_between(account, &prevprev_mo, &prev_mo);
    // UTC-midnight epoch of the week bounds (day_number × 86400) — the same
    // date→epoch convention `history_texts_since` uses; a few hours of week-edge
    // skew is immaterial for a coarse weekly count.
    let from_ts = day_number(&prev_mo).unwrap_or(0) * 86_400;
    let finds = crate::store::word_finds_between(account, from_ts, this_dn * 86_400);

    // Advance the guard regardless (so a genuinely empty week reports once and
    // moves on); only build/announce a report when the closed week had activity.
    let updated = {
        let mut c = state.config.lock();
        c.last_weekly_report_week = this_mo.clone();
        c.clone()
    };
    let _ = updated.save();

    if xp == 0 && finds == 0 {
        return; // empty week → no report, no notification
    }
    let payload = serde_json::json!({
        "week_prev": prev_mo,
        "xp": xp,
        "xp_before": xp_before,
        "finds": finds,
    });
    crate::store::weekly_report_upsert(account, &prev_mo, &payload.to_string(), now);
    use tauri::Emitter;
    let _ = app.emit("echo://weekly-report", payload);
    notify_weekly(app, &cfg.ui_language, xp, finds);
}

/// Native weekly-report notification (de for German UIs, EN otherwise).
fn notify_weekly(app: &AppHandle, ui_language: &str, xp: i64, finds: i64) {
    let de = ui_language.to_lowercase().starts_with("de");
    let (title, body) = if de {
        ("Deine Echo-Woche", format!("Letzte Woche: +{xp} XP und {finds} neue Funde."))
    } else {
        ("Your Echo week", format!("Last week: +{xp} XP and {finds} new finds."))
    };
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

/// All stored meetings, newest first (each with its store `id`).
#[tauri::command]
pub fn meetings_list() -> Vec<serde_json::Value> {
    crate::store::list_meetings()
}

/// Persist a drag-set overlay position (logical screen px) as `center-x-y` —
/// the orb's CENTRE, not its top-left — so later size changes scale the orb in
/// place around that point instead of letting it drift. The overlay still
/// reports the orb square's top-left (its historical contract); the centre is
/// derived here from the configured size. Called from the overlay on drag.
#[tauri::command]
pub fn set_orb_position(app: AppHandle, state: State<'_, AppState>, x: f64, y: f64) -> Result<(), String> {
    let cfg = {
        let mut c = state.config.lock();
        let dim = crate::overlay::orb_dim(c.orb_overlay_size as f64);
        c.orb_position = format!(
            "center-{}-{}",
            (x + dim / 2.0).round() as i64,
            (y + dim / 2.0).round() as i64
        );
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
            // off → prompt → email → slack → formal → notes → letter → social → off
            // ("tidy"/Standard ist am 2026-07-20 entfallen — die Stufe war auf
            // echten Diktaten messbar wirkungslos; nur transformierende Stile
            // bleiben. Siehe CLEANUP_STYLE_OPTIONS in Settings.tsx.)
            "cleanup" => {
                if !c.cleanup_enabled {
                    c.cleanup_enabled = true;
                    c.cleanup_style = "prompt".to_string();
                } else {
                    let order = [
                        "prompt", "email", "slack", "formal", "notes", "letter", "social",
                    ];
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
            // "tidy" bewusst NICHT mehr annehmbar (entfernt 2026-07-20).
            ("cleanup", "prompt") | ("cleanup", "email") | ("cleanup", "slack")
            | ("cleanup", "formal") | ("cleanup", "notes")
            | ("cleanup", "letter") | ("cleanup", "social") => {
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

/// Level + real 16-band voice spectrum in one call — the orb's per-frame food.
/// One IPC round-trip instead of two; bands are all-zero when not recording.
#[derive(Clone, serde::Serialize)]
pub struct MicFeatures {
    pub level: f32,
    pub bands: Vec<f32>,
}

#[tauri::command]
pub fn mic_features(state: State<'_, AppState>) -> MicFeatures {
    MicFeatures {
        level: state.recorder.level(),
        bands: crate::recorder::band_levels().to_vec(),
    }
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
    log::info!("transcribe trigger: ipc (frontend button)");
    do_transcribe(&app)
}

/// Sign in via the browser OAuth loopback flow. `auth::login` blocks (it waits up
/// to 30 min for the loopback callback), so run it on a blocking thread instead of
/// the command/main thread — otherwise the whole UI freezes until the user
/// finishes (or the timeout fires).
#[tauri::command]
pub async fn login(app: AppHandle) -> Result<String, String> {
    let app_for_sync = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        crate::auth::login(&app).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("login task: {e}"))?;
    // Pull this account's orb profiles now that we're authenticated.
    if res.is_ok() {
        crate::presets_sync::kick(&app_for_sync);
    }
    res
}

/// Upload a new account profile picture (raw file bytes + MIME type from the
/// webview's file picker). Blocking HTTP → run off the command thread, like
/// `login`. Errors are stable codes (`too_large`, `unsupported_image`,
/// `rate_limited`, `unauthorized`, `network`, …) the frontend translates.
#[tauri::command]
pub async fn upload_avatar(app: AppHandle, bytes: Vec<u8>, mime: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::auth::upload_avatar(&app, bytes, mime))
        .await
        .map_err(|e| format!("avatar task: {e}"))?
}

/// Remove the account profile picture (server + local mirror).
#[tauri::command]
pub async fn delete_avatar(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::auth::delete_avatar(&app))
        .await
        .map_err(|e| format!("avatar task: {e}"))?
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
pub fn logout(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut c = state.config.lock();
        c.subunit_access_token.clear();
        c.subunit_refresh_token.clear();
        c.subunit_token_issued_at = 0.0;
        c.subunit_token_expires_in = 0;
        c.subunit_workspace_id.clear();
        c.account_email.clear();
        c.avatar_url = None; // account-owned — gone with the account
        c.plan = "free".to_string(); // signed out → no entitlement
        c.save().map_err(|e| e.to_string())?;
    }
    // An explicit sign-out is NOT an expired session — clear the flag (and hide the
    // banner) so the Account tab cleanly shows the normal "Sign in" affordance.
    crate::auth::set_session_expired(&app, false);
    Ok(())
}

/// True when the user was signed in but the cloud session is gone (a rejected
/// refresh dropped both tokens, or it wasn't restored since launch). Drives the
/// re-login banner; the frontend also live-updates from the session-expired /
/// session-restored events.
#[tauri::command]
pub fn auth_session_expired(state: State<'_, AppState>) -> bool {
    state.session_expired.load(Ordering::Relaxed)
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
    // A recorded meeting is just a long recording — it goes into the normal history
    // (Verlauf), NOT a separate store (TJ 2026-07-03).
    if cfg.history_enabled && !result.text.trim().is_empty() {
        crate::store::add_history(
            &serde_json::json!({
                "ts": now,
                "text": result.text,
                "quality_mode": result.quality_mode,
                "duration_s": duration_s,
            }),
            cfg.history_size.max(0) as usize,
        );
        let _ = app.emit("echo://history-changed", ());
        // A separate finished recording from `do_transcribe`'s (a meeting, not a
        // dictation) — its own fillers, so this is not a double-count of anything.
        if !result.fillers_removed.is_empty() {
            crate::store::filler_removed_add(&result.fillers_removed, now as i64);
        }
    }
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

/// One-click update: re-check, download + install (fully silent on Windows via the
/// `installMode: quiet` config → NSIS `/S /R`, no visible installer window),
/// reporting progress on `echo://update-progress`,
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
    let (plan, mic, model) = {
        let c = state.config.lock();
        (c.plan.clone(), c.mic_device_name.clone(), c.local_model.clone())
    };
    // Meetings laufen IMMER mit Sprach-Auto-Detect (None) — anders als das Diktat,
    // wo `config.language` bewusst pinbar ist (z.B. DE für niedrige Latenz). Ein
    // Meeting hat mehrere Sprecher, oft gemischtsprachig, und darf nicht am Diktat-
    // Pin hängen (sonst würde ein englisches Meeting fälschlich auf die Diktat-
    // Sprache gezwungen). Konsistent mit dem Cloud-Meet, das serverseitig ebenfalls
    // auf "auto" defaultet.
    let language: Option<String> = None;
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

#[cfg(test)]
mod wortdex_tests {
    use super::detect_finds;

    fn own(words: &[&str]) -> std::collections::HashSet<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn normal_sentence_yields_rarest_first() {
        // Real sentence, two collectibles: "eloquenz" (selten) beats
        // "diskrepanz" (bemerkenswert) for the celebration slot.
        let hits = detect_finds(
            "Die Diskrepanz zwischen Anspruch und Eloquenz war heute wirklich bemerkenswert groß",
            &own(&[]),
        )
        .expect("must detect");
        assert_eq!(hits[0].0, "eloquenz");
        assert!(hits.iter().any(|h| h.0 == "diskrepanz"));
    }

    #[test]
    fn short_texts_are_gated() {
        assert!(detect_finds("Diskrepanz ist groß", &own(&[])).is_none());
    }

    #[test]
    fn own_vocabulary_never_counts() {
        // Taught vocabulary is never a find. Since the six-tier system also
        // collects everyday words, the sentence may yield other hits — but the
        // taught "diskrepanz" must never be among them.
        let hits = detect_finds(
            "Die Diskrepanz zwischen den beiden Angeboten war am Ende wirklich enorm",
            &own(&["diskrepanz"]),
        );
        if let Some(hits) = hits {
            assert!(
                !hits.iter().any(|h| h.0 == "diskrepanz"),
                "taught words are not finds"
            );
        }
    }

    #[test]
    fn word_list_reading_is_dropped_entirely() {
        // 16 unique tokens, nearly all collectible → anomaly gate.
        let listing = "Diskrepanz Eloquenz Redundanz kohärent stringent obsolet \
                       sukzessive antizipieren Tautologie prägnant ephemer apodiktisch \
                       ubiquitär Apotheose eklatant marginal";
        assert!(detect_finds(listing, &own(&[])).is_none());
    }

    #[test]
    fn everyday_dictation_grows_the_dex() {
        // Six-tier change (Gewöhnlich/Ungewöhnlich are collectible): an ordinary
        // sentence now grows the Wortdex — the dex is a living record of one's
        // vocabulary, not only the rare showpieces. Every hit must be a valid
        // band (1..=6). The daily XP cap + rarest-first celebration keep this
        // from feeling spammy.
        let hits = detect_finds(
            "Bitte schick mir die Datei morgen früh, dann schaue ich sie mir direkt an",
            &own(&[]),
        );
        if let Some(hits) = hits {
            assert!(hits.iter().all(|h| (1..=6).contains(&h.1.as_i64())));
        }

        // The ceiling still holds: a sentence of only ultra-common function
        // words (Zipf ≥ 4.6) stays silent — nothing there is collectible.
        assert!(detect_finds(
            "und dann haben wir das noch mit ihnen zusammen so gemacht",
            &own(&[]),
        )
        .is_none());
    }
}

#[cfg(test)]
mod stats_tests {
    use super::time_saved_seconds;

    #[test]
    fn time_saved_is_typing_minus_speaking() {
        // 40 words at 40 WPM = 60s to type; spoken in 20s → 40s saved.
        assert!((time_saved_seconds(40, 20.0) - 40.0).abs() < 1e-9);
        // 400 words = 600s typing, spoken in 200s → 400s saved.
        assert!((time_saved_seconds(400, 200.0) - 400.0).abs() < 1e-9);
        // Never negative: a long ramble with few words can't cost more than it saves.
        assert_eq!(time_saved_seconds(1, 300.0), 0.0);
        // Zero words → zero saved, no panic.
        assert_eq!(time_saved_seconds(0, 0.0), 0.0);
        assert_eq!(time_saved_seconds(-5, 0.0), 0.0);
    }
}

#[cfg(test)]
mod learning_loop_tests {
    use super::{word_due, word_stage};

    #[test]
    fn stage_thresholds() {
        // Floor: any usage day, no span requirement.
        assert_eq!(word_stage(1, 0), "used");
        assert_eq!(word_stage(2, 30), "used"); // days too few for fortified

        // fortified needs ≥3 days AND span ≥7.
        assert_eq!(word_stage(3, 7), "fortified"); // exactly on both bounds
        assert_eq!(word_stage(3, 6), "used"); // span one short → not fortified
        assert_eq!(word_stage(2, 7), "used"); // days one short → not fortified
        assert_eq!(word_stage(4, 20), "fortified"); // ≥3 days, span ≥7 but <21

        // mastered needs ≥5 days AND span ≥21.
        assert_eq!(word_stage(5, 21), "mastered"); // exactly on both bounds
        assert_eq!(word_stage(5, 20), "fortified"); // span one short → still fortified
        assert_eq!(word_stage(4, 21), "fortified"); // days one short → still fortified
        assert_eq!(word_stage(9, 40), "mastered");
    }

    #[test]
    fn due_windows() {
        // used → due at ≥3 days since last use.
        assert!(!word_due("used", 2));
        assert!(word_due("used", 3)); // exact boundary
        assert!(word_due("used", 10));
        // fortified → due at ≥7 days.
        assert!(!word_due("fortified", 6));
        assert!(word_due("fortified", 7)); // exact boundary
        // mastered → never due.
        assert!(!word_due("mastered", 3));
        assert!(!word_due("mastered", 100));
    }
}

#[cfg(test)]
mod achievement_tests {
    use super::{achievement_progress, ACHIEVEMENTS};

    /// Reproduce `earned_achievement_ids`' predicate over hand-seeded ledger
    /// inputs, exercising the *real* (pure) `achievement_progress` the command
    /// path uses — so this proves the id-selection logic without drift. DB-free
    /// on purpose: the store readers have their own round-trip test in `store`,
    /// and the connection is a process-wide singleton (a second DB-touching test
    /// would race that one).
    fn earned(
        counts: [i64; 6], // [Gewoehnlich..Legendaer]
        wod: i64,
        coach: i64,
        streak: i64,
        level: i64,
    ) -> Vec<&'static str> {
        let finds_total: i64 = counts.iter().sum();
        ACHIEVEMENTS
            .iter()
            .filter(|(id, target)| {
                achievement_progress(id, &counts, finds_total, wod, coach, streak, level) >= *target
            })
            .map(|(id, _)| *id)
            .collect()
    }

    #[test]
    fn earned_ids_match_seeded_ledgers() {
        // Empty account → no badges (level starts at 0, so even level_5 is out).
        assert!(earned([0, 0, 0, 0, 0, 0], 0, 0, 0, 0).is_empty());

        // Mid-game: 5 gewöhnlich + 4 ungewöhnlich + 3 selten + 2 episch + 1
        // mythisch + 1 legendär (=16 finds → clears finds_10, not finds_50/200),
        // first sighting of every "first" band (selten…legendär), 8 WoD, 25 coach
        // words, a 30-day streak, level 6. Result in catalog order. (Gewöhnlich
        // and Ungewöhnlich have no "first" badge — they only feed finds_N.)
        assert_eq!(
            earned([5, 4, 3, 2, 1, 1], 8, 25, 30, 6),
            vec![
                "first_rare",
                "first_epic",
                "first_mythic",
                "first_legendary",
                "finds_10",
                "wod_7",
                "coach_25",
                "streak_7",
                "streak_30",
                "level_5",
            ]
        );

        // Exact boundaries only: 10 finds all in the low tiers (no first_rare/
        // epic/mythic/legendary), wod=7, coach=25, streak=7, level=5.
        assert_eq!(
            earned([6, 4, 0, 0, 0, 0], 7, 25, 7, 5),
            vec!["finds_10", "wod_7", "coach_25", "streak_7", "level_5"]
        );

        // Everything maxed → all badges.
        assert_eq!(earned([200, 50, 20, 10, 5, 3], 30, 25, 30, 10).len(), ACHIEVEMENTS.len());
    }
}
