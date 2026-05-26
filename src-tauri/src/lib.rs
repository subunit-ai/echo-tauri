//! Echo — Tauri backend entrypoint.

mod commands;
mod config;
mod events;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = config::Config::load();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new(cfg))
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_config,
            commands::app_version,
            commands::list_audio_devices,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
