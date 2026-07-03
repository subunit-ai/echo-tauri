//! Echo — Tauri backend entrypoint.

mod auth;
mod auto_mode;
mod autovocab;
mod cleanup;
mod commands;
mod config;
mod dach;
// Speaker diarization fed the old meeting store, retired 2026-07-03 (long recordings
// now land in the normal history). Kept for a possible future meeting revival.
#[allow(dead_code)]
mod diarize;
mod events;
mod hardware;
mod help; // "Echo fragen" — grounded help assistant over the Abo backend
mod hotkey;
mod http; // shared pooled HTTP client + prewarm for the cloud path
mod inject;
mod intro; // first-run intro: dictation preview without injection
mod loopback; // system-audio loopback capture (meeting "other side"); pairs with recorder.rs
mod meet;
mod meet_local; // lokales Meet-Backend (Pro): geteilte Diarisierung aus crates/meet-core
mod meeting_capture; // mic + system-loopback → mixed 16k track for meeting transcripts
mod meeting_detect;
mod models;
mod prompt_console;
mod presets; // per-account orb profiles (local-first)
mod presets_sync; // /v1/presets cloud sync
mod synapse;
mod overlay;
mod recorder;
mod sound; // native record-start cue (instant even when the window is hidden)
mod store; // SQLite history + meetings + orb profiles (echo.db)
mod transcribe;
mod vocab_suggest; // auto-vocab spelling guess via the Abo cleanup backend

use commands::AppState;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Crash/error reporting. No-op unless ECHO_SENTRY_DSN is set (DSN lives in
    // env / CI, never in the repo). We never attach audio or transcript text.
    // DSN baked at compile time (option_env!) so shipped binaries report without
    // needing the env var on the user's machine. Empty = disabled (no-op).
    let _sentry = sentry::init((
        option_env!("ECHO_SENTRY_DSN").unwrap_or(""),
        sentry::ClientOptions {
            release: sentry::release_name!(),
            ..Default::default()
        },
    ));

    let cfg = config::Config::load();

    tauri::Builder::default()
        // Single-instance guard FIRST: a second launch must not spawn a rival
        // process fighting over the global hotkey / tray / config file. Instead it
        // hands focus to the already-running window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(
            // File + stdout logging. The file lands in the OS log dir
            // (Win: %LOCALAPPDATA%\ai.subunit.echo\logs\echo.log) so it can be pulled
            // over the Bridge to diagnose field issues — especially the Win-ARM
            // paste-back. Our own modules log at Debug; noisy deps are clamped to Warn.
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("echo_lib", log::LevelFilter::Debug)
                .level_for("reqwest", log::LevelFilter::Warn)
                .max_file_size(5_000_000)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("echo".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Launch-at-login. The actual OS entry is toggled via the set_autostart
        // command + reconciled on setup against config.autostart_enabled.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| hotkey::on_event(app, shortcut, event))
                .build(),
        )
        .manage(AppState::new(cfg))
        // Closing the main window hides it to the tray instead of quitting — Echo
        // is a background hotkey daemon; an accidental X must not kill the hotkey.
        // Real quit is the tray's "Beenden" (app.exit). The Prompt Console hides
        // too (iron rule: a dismissed console never loses its draft — the webview
        // keeps running). The overlay manages its own lifecycle.
        .on_window_event(|window, event| {
            let label = window.label();
            if label == "main" || label == crate::prompt_console::LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_config,
            commands::app_version,
            commands::copy_text,
            commands::open_config_dir,
            commands::open_external,
            commands::history_list,
            commands::history_count,
            commands::account_stats,
            commands::delete_history_entry,
            commands::clear_history,
            commands::vocab_candidates,
            commands::vocab_scan,
            commands::vocab_confirm,
            commands::vocab_ignore,
            commands::vocab_undo,
            commands::meetings_list,
            commands::set_orb_position,
            commands::orb_quick,
            commands::orb_cycle,
            commands::orb_set,
            overlay::overlay_set_hot_rects,
            prompt_console::prompt_console_toggle,
            prompt_console::prompts_load,
            prompt_console::prompts_save,
            prompt_console::prompt_take_pending,
            prompt_console::prompt_insert,
            prompt_console::prompt_cleanup,
            help::help_ask,
            commands::list_audio_devices,
            commands::hardware_info,
            commands::process_meeting,
            commands::mic_level,
            commands::mic_features,
            commands::start_recording,
            commands::cancel_recording,
            commands::stop_and_transcribe,
            commands::login,
            commands::logout,
            commands::auth_session_expired,
            commands::set_autostart,
            commands::check_for_updates,
            commands::install_update,
            commands::start_meeting,
            commands::meet_token,
            commands::start_meeting_recording,
            commands::stop_meeting_recording,
            commands::list_local_models,
            commands::download_model,
            commands::delete_local_model,
            commands::meet_local_available,
            commands::meet_local_start,
            commands::meet_local_add_participant,
            commands::meet_local_checkin,
            commands::meet_local_status,
            commands::meet_local_stop,
            commands::meet_local_dismiss,
            commands::meet_local_list,
            commands::meet_local_get,
            intro::transcribe_preview,
            intro::intro_stream_start,
            intro::intro_stream_stop,
            hotkey::hotkey_set_suspended,
            presets::list_orb_profiles,
            presets::save_orb_profile,
            presets::apply_orb_profile,
            presets::rename_orb_profile,
            presets::delete_orb_profile,
            presets::duplicate_orb_profile,
        ])
        .setup(|app| {
            // Version/platform banner — first line in every log, mirrors the old
            // Python "Echo X.Y.Z starting" so field logs are immediately attributable.
            log::info!(
                "Echo {} starting (os={}, arch={})",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH,
            );

            // Spawn the native cue player. The record-start sound is played from
            // Rust, not the webview — a hidden main window suspends the webview's
            // AudioContext (delay), and a held native stream dies after sleep; the
            // player opens a fresh stream per cue so it's instant + sleep-proof. See sound.rs.
            crate::sound::init();

            // History/meetings live in SQLite (echo.db) — durable, searchable,
            // and a finishing dictation no longer rewrites the whole config file.
            // One-time migration empties the legacy config.json arrays.
            if let Err(e) = store::init() {
                log::warn!("store: init failed ({e}) — history disabled this session");
            } else {
                let st = app.state::<AppState>();
                let (h, m) = {
                    let c = st.config.lock();
                    (c.history.clone(), c.meetings.clone())
                };
                if !h.is_empty() || !m.is_empty() {
                    match store::migrate_from_config(&h, &m) {
                        Ok(()) => {
                            let mut c = st.config.lock();
                            c.history.clear();
                            c.meetings.clear();
                            let _ = c.save();
                        }
                        Err(e) => log::warn!("store: migration failed: {e}"),
                    }
                }

                // Seed / repair the per-account stats table from the legacy global
                // counters, so users upgrading from pre-stats builds keep their
                // historical numbers (attributed to whichever account is active at
                // upgrade). Versioned so a changed seed heals already-seeded
                // installs: v1 backfilled historical words from the tiny retained
                // history window → inconsistent with lifetime audio → "time saved"
                // clamped to 0; v2 estimates historical words from the audio total.
                const STATS_SEED_VERSION: i32 = 2;
                {
                    let mut c = st.config.lock();
                    if c.stats_seed_version < STATS_SEED_VERSION {
                        let account = crate::presets::account_key(&c);
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0);
                        store::seed_or_repair_account_stats(
                            &account,
                            c.total_transcriptions,
                            c.total_audio_seconds,
                            crate::commands::SPEAKING_WPM_ESTIMATE,
                            now,
                        );
                        c.stats_seeded = true;
                        c.stats_seed_version = STATS_SEED_VERSION;
                        let _ = c.save();
                    }
                }
            }

            // Seed the orb's voice-reactivity from config (defaults until a profile
            // tweaks it), and pull this account's orb profiles in the background.
            {
                let st = app.state::<AppState>();
                let c = st.config.lock();
                crate::recorder::set_reactivity(c.orb_noise_floor, c.orb_gain, c.orb_gamma);
            }
            crate::presets_sync::kick(app.handle());

            // macOS: the paste-back path must reach the main thread (enigo crashes
            // off-thread). Stash the handle for inject::macos_inject, then trigger the
            // Accessibility prompt — synthetic Cmd+V silently no-ops without it.
            crate::inject::set_app_handle(app.handle().clone());
            crate::inject::prime_accessibility();

            // Global hotkey
            if let Err(e) = hotkey::register_from_config(app.handle()) {
                log::warn!("hotkey: {e}");
            }

            // Reconcile the OS autostart entry with the saved preference (e.g. a
            // user removed it via the OS, or it was set on another machine).
            {
                use tauri_plugin_autostart::ManagerExt;
                let want = app.state::<AppState>().config.lock().autostart_enabled;
                let mgr = app.autolaunch();
                match mgr.is_enabled() {
                    Ok(is) if is != want => {
                        let r = if want { mgr.enable() } else { mgr.disable() };
                        if let Err(e) = r {
                            log::warn!("autostart reconcile: {e}");
                        }
                    }
                    Err(e) => log::warn!("autostart is_enabled: {e}"),
                    _ => {}
                }
            }

            // Auto-meeting detection: poll for a Teams/Zoom/Meet call → prompt to
            // record (the poller itself re-checks the config toggle each tick, so it's
            // cheap to always spawn; no-op on non-Windows).
            meeting_detect::spawn(app.handle().clone());

            // System tray
            let open = MenuItemBuilder::with_id("open", "Echo öffnen").build(app)?;
            let toggle = MenuItemBuilder::with_id("toggle", "Aufnahme umschalten").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Beenden").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&open, &toggle])
                .separator()
                .item(&quit)
                .build()?;
            let mut tray = TrayIconBuilder::with_id("tray").menu(&menu).on_menu_event(|app, event| {
                match event.id().as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "toggle" => {
                        let st = app.state::<AppState>();
                        if st.recorder.is_recording() {
                            let a = app.clone();
                            std::thread::spawn(move || {
                                let _ = commands::do_transcribe(&a);
                            });
                        } else {
                            commands::do_start(app);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                }
            });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Floating overlay window (transparent, always-on-top). Shows the orb
            // when enabled, else the bubble indicator if that's on.
            {
                let st = app.state::<AppState>();
                let want_overlay = {
                    let c = st.config.lock();
                    c.use_orb_overlay || c.show_bubble
                };
                if want_overlay {
                    if let Err(e) = overlay::create(app.handle()) {
                        log::warn!("overlay: {e}");
                    }
                }
            }

            // Auto-update check — on launch AND every 3 h, so a long-running
            // background instance surfaces a new release without a restart. We
            // never auto-install (high blast radius); we emit availability and the
            // top-bar "Jetzt aktualisieren" button (or Settings) triggers the
            // install. Re-reads the config each tick so toggling it takes effect.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        let enabled = handle.state::<AppState>().config.lock().auto_update_check;
                        if enabled {
                            if let Ok(updater) = handle.updater() {
                                match updater.check().await {
                                    Ok(Some(update)) => {
                                        log::info!("update available: {}", update.version);
                                        let _ = handle.emit("echo://update-available", update.version);
                                    }
                                    Ok(None) => {}
                                    Err(e) => log::debug!("update check: {e}"),
                                }
                            }
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(3 * 3600)).await;
                    }
                });
            }

            // Keep the cloud session alive PROACTIVELY while Echo runs — not just when
            // the user happens to dictate. Without this the rotating refresh token only
            // gets exercised on use; a long idle gap lets it age out server-side and the
            // next action silently fails with "please sign in again" (exactly the
            // customer-facing surprise this guards against). `ensure_fresh` is a cheap
            // no-op until the access token is near expiry; each real refresh rotates the
            // refresh token and resets its server-side lifetime, so as long as Echo is
            // open the session never lapses from disuse. A rejected (dead) token flips
            // the session-expired flag + banner instead of failing quietly. Poll well
            // under any sane refresh-token TTL.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(15 * 60));
                    let has_refresh = {
                        let st = handle.state::<AppState>();
                        let c = st.config.lock();
                        !c.subunit_refresh_token.is_empty()
                    };
                    if has_refresh {
                        crate::auth::ensure_fresh(&handle);
                    }
                });
            }

            // Arm the cloud→local dictation fallback: the fallback in
            // transcribe::run_opts only fires when a local model is ALREADY on
            // disk (it must never download mid-dictation) — but nobody downloads
            // a model by hand, so in practice it was silently dead. Quietly fetch
            // the small "base" model (~150 MB) once in the background when the
            // build has the local engine and no model exists yet. Delayed so app
            // start (auth refresh, overlay) wins the bandwidth first; a failed
            // fetch just retries on the next start.
            #[cfg(feature = "local-whisper")]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(45)).await;
                    let (enabled, mode, model) = {
                        let st = handle.state::<AppState>();
                        let c = st.config.lock();
                        (c.local_fallback_autofetch, c.mode.clone(), c.local_model.clone())
                    };
                    // Local mode manages its models itself (ensure_blocking on use).
                    if !enabled || mode == "local" {
                        return;
                    }
                    if crate::models::is_downloaded(&model)
                        || crate::models::best_downloaded().is_some()
                    {
                        return; // already armed
                    }
                    log::info!(
                        "fallback autofetch: no local model on disk — fetching `base` in the background"
                    );
                    if let Err(e) = crate::models::download(&handle, "base").await {
                        log::warn!("fallback autofetch failed (retries next start): {e}");
                    }
                });
            }

            // Refresh the displayed plan from the active workspace tier on startup —
            // config.plan was never fetched in older builds, so it kept showing the
            // local default ("free") regardless of the account's real tier.
            {
                let logged_in = {
                    let st = app.state::<AppState>();
                    let c = st.config.lock();
                    !c.subunit_access_token.is_empty() || !c.subunit_refresh_token.is_empty()
                };
                if logged_in {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || crate::auth::refresh_plan(&handle));
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // macOS: clicking the Dock icon sends Reopen (NOT a second launch, so
            // the single-instance plugin never sees it). Echo only hides its main
            // window on close — without this handler a Dock click did nothing.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
