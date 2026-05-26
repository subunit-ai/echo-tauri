//! Echo — Tauri backend entrypoint.

mod commands;
mod config;
mod events;
mod hotkey;
mod recorder;
mod transcribe;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = config::Config::load();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
        ])
        .setup(|app| {
            if let Err(e) = hotkey::register_from_config(app.handle()) {
                log::warn!("hotkey: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
