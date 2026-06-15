//! The Prompt Console — a floating, always-on-top Liquid-Glass window for
//! drafting and engineering prompts anywhere on the desktop. Opened from the
//! orb's ✦ satellite, the global console hotkey, or implicitly when transcripts
//! are routed here ("Konsole als Ziel").
//!
//! Iron rule: content is NEVER lost. Closing the window only hides it (the
//! webview keeps running), the frontend auto-saves every edit to
//! `~/.config/echo/prompts.json` (atomic tmp+rename, same pattern as
//! config.rs), and deleting a non-empty draft archives it to the library.

use std::fs;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::commands::AppState;

pub const LABEL: &str = "prompt";

fn prompts_file() -> std::path::PathBuf {
    crate::config::config_dir().join("prompts.json")
}

/// Serializes saves across threads (debounced frontend saves + flush-on-hide
/// can race) so writers can't clobber the shared temp file mid-rename.
static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Create the console window (no-op if it already exists). The window is
/// transparent + undecorated; on macOS a native HUD vibrancy layer blurs the
/// desktop behind it — the frontend draws dark Liquid Glass on top.
///
/// MUST NOT be called from a synchronous IPC command: those run on the main
/// thread, and window creation dispatches to the same event loop → deadlock
/// on Windows (the "console never appears on Erik's ARM Surface" bug). The
/// `prompt_console_toggle` command is async for exactly this reason.
pub fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    // Native glass behind the webview: try WITH the OS blur effect first, and
    // if that build fails (effect unsupported on this Windows/GPU combo), fall
    // back to a plain transparent window — the CSS glass tint still reads fine.
    match build_window(app, true) {
        Ok(w) => Ok(w),
        Err(e) => {
            log::warn!("prompt console: build with effects failed ({e}) — retrying plain");
            build_window(app, false)
        }
    }
}

fn build_window(app: &AppHandle, effects: bool) -> tauri::Result<WebviewWindow> {
    #[allow(unused_mut)]
    let mut b = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("prompt.html".into()))
        .title("Echo Prompt Terminal")
        .inner_size(460.0, 560.0)
        .min_inner_size(340.0, 380.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .center();
    // Native glass: blur what's BEHIND the window (CSS backdrop-filter can only
    // blur the webview's own content). macOS HUD material = the dark floating
    // console look; Windows Acrylic is the closest equivalent. Linux gets the
    // semi-transparent panel without the OS blur — still coherent.
    #[cfg(target_os = "macos")]
    if effects {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        // Radius matches the CSS shell's border-radius (22px) so the native
        // blur layer never peeks past the rounded corners.
        // EffectState::Active (instead of the default FollowsWindowActiveState):
        // keep the translucent HUD look even when the console isn't the key
        // window — otherwise macOS renders the vibrancy in its INACTIVE
        // appearance (darker / more opaque) the moment focus moves to another
        // app, which is exactly when the floating console is meant to stay glassy.
        b = b.effects(
            EffectsBuilder::new()
                .effect(Effect::HudWindow)
                .state(EffectState::Active)
                .radius(22.0)
                .build(),
        );
    }
    #[cfg(target_os = "windows")]
    if effects {
        use tauri::window::{Effect, EffectsBuilder};
        b = b.effects(EffectsBuilder::new().effect(Effect::Acrylic).build());
    }
    #[cfg(target_os = "linux")]
    let _ = effects;
    b.build()
}

/// Show/hide the console (orb satellite + global hotkey). Hiding never loses
/// content — the webview stays alive and the draft is persisted anyway.
pub fn toggle(app: &AppHandle) {
    match app.get_webview_window(LABEL) {
        Some(w) => {
            if w.is_visible().unwrap_or(false) {
                let _ = w.hide();
            } else {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        None => match create(app) {
            // Explicitly show + focus + raise after creating: on Windows a freshly
            // built transparent window can come up hidden or behind others.
            Ok(w) => {
                let _ = w.show();
                let _ = w.set_focus();
                let _ = w.set_always_on_top(true);
            }
            Err(e) => log::warn!("prompt console: create failed: {e}"),
        },
    }
}

/// Route a finished transcript into the console ("Konsole als Ziel"). The text
/// goes through a pending queue in AppState — the webview may still be booting
/// on first use, so the event only signals "drain the queue" (the frontend also
/// drains on mount; nothing is ever dropped). Shows the window without focusing
/// it, so dictation doesn't yank the user out of their app.
pub fn receive_transcript(app: &AppHandle, text: &str) {
    app.state::<AppState>().prompt_pending.lock().push(text.to_string());
    match app.get_webview_window(LABEL) {
        Some(w) => {
            if !w.is_visible().unwrap_or(false) {
                let _ = w.show();
            }
        }
        None => {
            if let Err(e) = create(app) {
                log::warn!("prompt console: create failed: {e}");
            }
        }
    }
    let _ = app.emit_to(LABEL, "echo://prompt-transcript", ());
}

// ---- IPC commands ----

/// ASYNC on purpose: sync commands execute on the main thread, and creating a
/// webview window from there deadlocks on Windows (the event loop is busy
/// running the command). Async commands run on a worker thread → safe.
#[tauri::command]
pub async fn prompt_console_toggle(app: AppHandle) {
    toggle(&app);
}

/// Raw prompts.json contents ("" = first run; the frontend owns the schema).
#[tauri::command]
pub fn prompts_load() -> String {
    fs::read_to_string(prompts_file()).unwrap_or_default()
}

/// Persist the console state (drafts + library), atomically — a crash mid-write
/// can never truncate the user's prompts.
#[tauri::command]
pub fn prompts_save(data: String) -> Result<(), String> {
    if data.len() > 10_000_000 {
        return Err("prompts.json über 10 MB — Speichern verweigert".into());
    }
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let dir = crate::config::config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("prompts.{}.tmp", std::process::id()));
    let write_then_rename = || -> std::io::Result<()> {
        fs::write(&tmp, data.as_bytes())?;
        fs::rename(&tmp, prompts_file())
    };
    if let Err(e) = write_then_rename() {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// Drain queued "Konsole als Ziel" transcripts (called by the console on mount
/// and on every `echo://prompt-transcript` signal).
#[tauri::command]
pub fn prompt_take_pending(state: tauri::State<'_, AppState>) -> Vec<String> {
    std::mem::take(&mut *state.prompt_pending.lock())
}

/// "Einfügen": paste the prompt into the app BEHIND the console. The console
/// has key focus while the user clicks, so yield it first (hide → the previous
/// app becomes frontmost again), paste, then re-show without stealing focus.
#[tauri::command]
pub fn prompt_insert(app: AppHandle, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    crate::inject::set_clipboard(&text).map_err(|e| e.to_string())?;
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
    std::thread::spawn(move || {
        // Give the OS a beat to re-activate the underlying app before the chord.
        std::thread::sleep(std::time::Duration::from_millis(300));
        crate::inject::paste_clipboard_into_focused(&text);
        std::thread::sleep(std::time::Duration::from_millis(400));
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.show();
        }
    });
    Ok(())
}

/// AI-Coach "Refine": rewrite the draft into a clean, well-structured prompt via
/// the server's `/v1/cleanup` `style: "prompt"` (the same subscription-Claude
/// path the dictation cleanup uses — NOT a metered API call). Ignores
/// `cleanup_enabled` (Refine is an explicit user action). ASYNC + spawn_blocking:
/// the round trip can take tens of seconds, and sync commands run on the main
/// thread — blocking it would freeze the whole UI (same reasoning as `login`).
#[tauri::command]
pub async fn prompt_refine(app: AppHandle, text: String) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("leerer Prompt".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Meetings can sit a while; a draft can too — refresh the cloud token
        // first, exactly like `process_meeting`.
        crate::auth::ensure_fresh(&app);
        let cfg = app.state::<AppState>().config.lock().clone();
        crate::cleanup::run_style(&cfg, &text, "prompt").map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("refine task: {e}"))?
}
