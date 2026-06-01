//! Echo — Tauri backend entrypoint.

mod auth;
mod auto_mode;
mod cleanup;
mod commands;
mod config;
mod dach;
mod diarize;
mod events;
mod hardware;
mod hotkey;
mod inject;
mod live_ws; // LIVE dictation (WS stream → WhisperLive); replaced the old batch streaming.rs
mod meet;
mod models;
mod synapse;
mod overlay;
mod recorder;
mod transcribe;

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
                .level_for("tokio_tungstenite", log::LevelFilter::Warn)
                .level_for("tungstenite", log::LevelFilter::Warn)
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
        // Real quit is the tray's "Beenden" (app.exit). Only the main window; the
        // overlay manages its own lifecycle.
        .on_window_event(|window, event| {
            if window.label() == "main" {
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
            commands::delete_history_entry,
            commands::clear_history,
            commands::set_orb_position,
            commands::orb_quick,
            commands::orb_cycle,
            commands::list_audio_devices,
            commands::hardware_info,
            commands::process_meeting,
            commands::mic_level,
            commands::start_recording,
            commands::cancel_recording,
            commands::stop_and_transcribe,
            commands::login,
            commands::logout,
            commands::set_autostart,
            commands::check_for_updates,
            commands::install_update,
            commands::start_meeting,
            commands::list_local_models,
            commands::download_model,
            commands::delete_local_model,
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

            // Best-effort auto-update check (no-op until signed releases exist).
            if app.state::<AppState>().config.lock().auto_update_check {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(updater) = handle.updater() {
                        match updater.check().await {
                            // Don't silently install on launch (high blast radius).
                            // Surface availability; install is user-triggered via
                            // the check_for_updates command.
                            Ok(Some(update)) => {
                                log::info!("update available: {}", update.version);
                                let _ = handle.emit("echo://update-available", update.version);
                            }
                            Ok(None) => {}
                            Err(e) => log::debug!("update check: {e}"),
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
