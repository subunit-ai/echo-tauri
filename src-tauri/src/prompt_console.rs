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
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::commands::AppState;

pub const LABEL: &str = "prompt";

/// Generation counter for the genie hide handshake: toggle() asks the webview
/// to play the suck-into-the-pill animation and the webview calls
/// `prompt_console_hide_now` when done. A delayed FALLBACK force-hide covers a
/// wedged webview — the generation guard keeps that fallback from hiding a
/// window the user re-opened in the meantime.
static GENIE_GEN: AtomicU64 = AtomicU64::new(0);

fn prompts_file() -> std::path::PathBuf {
    crate::config::config_dir().join("prompts.json")
}

/// Serializes saves across threads (debounced frontend saves + flush-on-hide
/// can race) so writers can't clobber the shared temp file mid-rename.
static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Create the console window (no-op if it already exists). The window is
/// transparent + undecorated; the native vibrancy layer (macOS HUD / Windows
/// Acrylic) is applied by the WEBVIEW after its entrance animation settles —
/// see `prompt_set_effects`. Building without effects keeps the genie
/// animation clean: the OS blur is a full-window slab that ignores CSS
/// transforms, so it must only exist while the window is at rest.
///
/// MUST NOT be called from a synchronous IPC command: those run on the main
/// thread, and window creation dispatches to the same event loop → deadlock
/// on Windows (the "console never appears on Erik's ARM Surface" bug). The
/// `prompt_console_toggle` command is async for exactly this reason.
pub fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("prompt.html".into()))
        .title("Echo Prompt Terminal")
        .inner_size(460.0, 560.0)
        .min_inner_size(340.0, 380.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .center()
        .build()
}

/// Apply / strip the native glass behind the webview (blurs what's BEHIND the
/// window — CSS backdrop-filter can only blur the webview's own content).
/// macOS HUD material = the dark floating console look; Windows Acrylic is the
/// closest equivalent; Linux gets the semi-transparent panel without OS blur.
///
/// macOS goes through window-vibrancy directly because tauri's
/// `set_effects(None)` cannot REMOVE an NSVisualEffectView (only Windows
/// implements clearing) — and `apply_vibrancy` STACKS a new view per call, so
/// it's always clear-then-apply. Main-thread hop: AppKit requirement.
fn set_native_glass(w: &WebviewWindow, on: bool) {
    #[cfg(target_os = "macos")]
    {
        let w2 = w.clone();
        let _ = w.run_on_main_thread(move || {
            let _ = window_vibrancy::clear_vibrancy(&w2);
            if on {
                // HudWindow + Active state + 22px radius — mirrors the shell's
                // former builder config (Active keeps the glassy look when the
                // console isn't the key window; radius hugs the CSS corners).
                let _ = window_vibrancy::apply_vibrancy(
                    &w2,
                    window_vibrancy::NSVisualEffectMaterial::HudWindow,
                    Some(window_vibrancy::NSVisualEffectState::Active),
                    Some(22.0),
                );
            }
        });
    }
    #[cfg(target_os = "windows")]
    {
        use tauri::window::{Effect, EffectsBuilder};
        let _ = if on {
            w.set_effects(EffectsBuilder::new().effect(Effect::Acrylic).build())
        } else {
            w.set_effects(None)
        };
    }
    #[cfg(target_os = "linux")]
    let _ = (w, on);
}

/// Tell the orb overlay the terminal is genie-ing out of / into the pill so it
/// can play its absorb/emit pulse. Best-effort — no overlay, no pulse.
fn notify_orb(app: &AppHandle, dir: &str) {
    let _ = app.emit_to("overlay", "echo://orb-genie", dir);
}

/// Show/hide the console (orb satellite + global hotkey). Hiding never loses
/// content — the webview stays alive and the draft is persisted anyway.
///
/// Both directions run the genie animation in the webview: on show the window
/// appears first (stage is pre-collapsed, so nothing flashes) and the webview
/// materializes it out of the pill; on hide the webview sucks it back into the
/// pill and then calls `prompt_console_hide_now`. A delayed fallback force-hide
/// covers a wedged webview.
pub fn toggle(app: &AppHandle) {
    match app.get_webview_window(LABEL) {
        Some(w) => {
            if w.is_visible().unwrap_or(false) {
                let gen = GENIE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
                let _ = app.emit_to(LABEL, "echo://prompt-genie", "out");
                notify_orb(app, "out");
                let app2 = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(900));
                    if GENIE_GEN.load(Ordering::SeqCst) != gen {
                        return; // re-opened (or already handled) meanwhile
                    }
                    if let Some(w) = app2.get_webview_window(LABEL) {
                        if w.is_visible().unwrap_or(false) {
                            let _ = w.hide();
                        }
                    }
                });
            } else {
                GENIE_GEN.fetch_add(1, Ordering::SeqCst);
                let _ = w.show();
                let _ = w.set_focus();
                let _ = app.emit_to(LABEL, "echo://prompt-genie", "in");
                notify_orb(app, "in");
            }
        }
        None => match create(app) {
            // Explicitly show + focus + raise after creating: on Windows a freshly
            // built transparent window can come up hidden or behind others. The
            // webview plays its entrance on mount (the genie event below would
            // land before its listeners exist — the mount path covers first boot).
            Ok(w) => {
                GENIE_GEN.fetch_add(1, Ordering::SeqCst);
                let _ = w.show();
                let _ = w.set_focus();
                let _ = w.set_always_on_top(true);
                notify_orb(app, "in");
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
                GENIE_GEN.fetch_add(1, Ordering::SeqCst);
                let _ = w.show();
                // Materialize out of the pill here too — but WITHOUT focus, so
                // dictation never yanks the user out of their app.
                let _ = app.emit_to(LABEL, "echo://prompt-genie", "in");
                notify_orb(app, "in");
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

/// Immediate hide — the webview calls this once its genie-out animation has
/// finished (the animated half of the `toggle` handshake). Bumping the
/// generation retires the pending fallback force-hide.
#[tauri::command]
pub async fn prompt_console_hide_now(app: AppHandle) {
    GENIE_GEN.fetch_add(1, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}

/// Pill centre in LOGICAL screen coordinates — the webview turns this into the
/// transform-origin of its genie animation. None → no visible orb → fall back
/// to a plain scale-fade.
#[tauri::command]
pub fn prompt_genie_anchor(app: AppHandle) -> Option<(f64, f64)> {
    crate::overlay::orb_anchor(&app)
}

/// The webview toggles the native glass around its genie animation: the OS
/// vibrancy is a full-window layer that ignores CSS transforms — left on, it
/// would linger as a static frosted slab while the shell shrinks into the pill.
/// Off right before animating, back on once settled.
#[tauri::command]
pub async fn prompt_set_effects(app: AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window(LABEL) {
        set_native_glass(&w, on);
    }
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

/// AI-Coach text passes via the server's `/v1/cleanup` (the same
/// subscription-Claude path the dictation cleanup uses — NOT a metered API
/// call). Two styles are exposed to the prompt webview:
///   - "prompt" → Refine: rewrite the draft into a structured prompt.
///   - "tidy"   → Correct: lightest-touch fix (typos, punctuation, casing),
///                wording kept.
/// Ignores `cleanup_enabled` (these are explicit user actions). ASYNC +
/// spawn_blocking: the round trip can take tens of seconds, and sync commands
/// run on the main thread — blocking it would freeze the whole UI (same
/// reasoning as `login`).
#[tauri::command]
pub async fn prompt_cleanup(app: AppHandle, text: String, style: String) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("leerer Prompt".into());
    }
    // Whitelist: only the two prompt-terminal styles may be requested from here.
    let style = match style.as_str() {
        "prompt" | "tidy" => style,
        _ => return Err(format!("unsupported style: {style}")),
    };
    tauri::async_runtime::spawn_blocking(move || {
        // Meetings can sit a while; a draft can too — refresh the cloud token
        // first, exactly like `process_meeting`.
        crate::auth::ensure_fresh(&app);
        let cfg = app.state::<AppState>().config.lock().clone();
        crate::cleanup::run_style(&cfg, &text, &style).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("cleanup task: {e}"))?
}
