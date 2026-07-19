//! System-wide achievement toast — the XP banner, but OUTSIDE the app.
//!
//! An unlocked word / level-up should feel like a console achievement: it pops
//! up wherever the user currently is, over whatever app they are working in.
//! Rendering it inside the main window meant nobody ever saw it, because Echo is
//! backgrounded while you dictate into something else.
//!
//! Its own window on purpose, NOT the orb overlay: the overlay is sized and
//! positioned around the orb (a toast would move it and enlarge its hit rect),
//! it only exists when the orb/bubble is enabled, and idle-hide takes it away
//! exactly when an award lands. This one is independent of all that.
//!
//! Created once, hidden, and permanently click-through: it must never steal
//! focus or swallow a click in the app underneath. The reward events reach it
//! for free — `app.emit` broadcasts to every webview.

use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "toast";

/// Window box. Height fits the two-line banner plus the stack's breathing room;
/// the webview itself is transparent, so unused space is invisible.
const W: f64 = 380.0;
const H: f64 = 190.0;
/// Distance from the screen edge. The top gap clears the macOS menu bar.
const MARGIN_RIGHT: f64 = 22.0;
const MARGIN_TOP: f64 = 44.0;

/// Create the toast window once — hidden, unfocused, click-through, pinned above
/// everything (incl. other apps' fullscreen, via the same NSWindow level the orb
/// uses). Idempotent: returns the existing window if it is already there.
pub fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("toast.html".into()))
        .title("Echo")
        .inner_size(W, H)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        // Never take focus — the user is typing in another app while this pops.
        .focused(false)
        .visible(false);
    // Windows: DWM draws the shadow around the WINDOW RECT, which on a
    // transparent window is a permanent ghost frame (same reason the overlay and
    // the prompt console disable it).
    #[cfg(target_os = "windows")]
    let builder = builder.shadow(false);
    let win = builder.build()?;
    // Permanently click-through: unlike the orb there is nothing to interact
    // with, so we never toggle this (no hit-test loop).
    let _ = win.set_ignore_cursor_events(true);
    crate::overlay::pin_topmost(&win);
    position(&win);
    Ok(win)
}

/// Park the window in the top-right corner of the monitor it currently sits on,
/// clamped so it can never land off-screen.
fn position(win: &WebviewWindow) {
    let Ok(Some(mon)) = win.current_monitor() else {
        return;
    };
    let scale = mon.scale_factor();
    let size = mon.size().to_logical::<f64>(scale);
    let origin = mon.position().to_logical::<f64>(scale);
    let x = (origin.x + size.width - W - MARGIN_RIGHT).max(origin.x);
    let y = (origin.y + MARGIN_TOP).max(origin.y);
    let _ = win.set_position(LogicalPosition::new(x, y));
}

/// Show the toast layer. `(async)`: window work must not run on the sync IPC
/// thread (that dispatches to the same event loop → deadlock on Windows).
/// Deliberately no `set_focus` — showing must not pull the user out of their app.
#[tauri::command(async)]
pub fn toast_show(app: AppHandle) {
    let win = match app.get_webview_window(LABEL) {
        Some(w) => w,
        None => match create(&app) {
            Ok(w) => w,
            Err(e) => {
                log::warn!("toast: {e}");
                return;
            }
        },
    };
    // Re-position on every show: the user may have moved to another monitor.
    position(&win);
    let _ = win.show();
    crate::overlay::pin_topmost(&win);
}

/// Hide it again once the banner has left, so it never occupies the screen while
/// there is nothing to say. Kept alive (hidden), never closed — recreating a
/// webview per toast would be far slower than a show/hide.
#[tauri::command(async)]
pub fn toast_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}
