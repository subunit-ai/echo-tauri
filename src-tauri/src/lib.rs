//! Echo — Tauri backend entrypoint.

mod auth;
mod auto_mode;
mod cleanup;
mod commands;
mod config;
mod dach;
mod events;
mod hotkey;
mod inject;
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
    let _sentry = sentry::init((
        std::env::var("ECHO_SENTRY_DSN").unwrap_or_default(),
        sentry::ClientOptions {
            release: sentry::release_name!(),
            ..Default::default()
        },
    ));

    let cfg = config::Config::load();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| hotkey::on_event(app, shortcut, event))
                .build(),
        )
        .manage(AppState::new(cfg))
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_config,
            commands::app_version,
            commands::list_audio_devices,
            commands::mic_level,
            commands::start_recording,
            commands::cancel_recording,
            commands::stop_and_transcribe,
            commands::login,
            commands::logout,
            commands::check_for_updates,
        ])
        .setup(|app| {
            // Global hotkey
            if let Err(e) = hotkey::register_from_config(app.handle()) {
                log::warn!("hotkey: {e}");
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

            // Floating orb overlay window (transparent, always-on-top, click-through).
            if app.state::<AppState>().config.lock().use_orb_overlay {
                if let Err(e) = overlay::create(app.handle()) {
                    log::warn!("overlay: {e}");
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
