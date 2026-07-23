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

/// Window box. MUSS breiter sein als die maximale Bannerbreite (xpbanner.css:
/// `max-width: min(480px, …)`) plus Stack-Padding und Schattenradius — sonst
/// wird die Pille am Fensterrand abgeschnitten (Bug bis v0.5.150: W war 380).
/// Die Höhe trägt den vollen Stapel (MAX_STACK = 3) samt Abständen und Schatten.
/// Der Webview ist transparent, ungenutzte Fläche ist also unsichtbar.
const W: f64 = 560.0;
const H: f64 = 260.0;
/// Abstand von der Bildschirmkante. Der obere Rand hält die macOS-Menüleiste frei.
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
        // Kein OS-Fensterschatten. Auf einem transparenten, dekorationslosen
        // Fenster zeichnet ihn das System um die sichtbare Fläche — auf macOS
        // als „durchsichtiger Ring" etwas größer als die Pille (TJ 2026-07-23),
        // auf Windows als permanenter DWM-Geisterrahmen um die Fenster-Rect.
        // Der Orb-Overlay und die Prompt-Konsole schalten ihn aus demselben
        // Grund ab (overlay.rs). Plattformübergreifend, nicht nur Windows.
        .shadow(false)
        // Never take focus — the user is typing in another app while this pops.
        .focused(false)
        .visible(false);
    let win = builder.build()?;
    // Permanently click-through: unlike the orb there is nothing to interact
    // with, so we never toggle this (no hit-test loop).
    let _ = win.set_ignore_cursor_events(true);
    crate::overlay::pin_topmost(&win);
    position(app, &win);
    Ok(win)
}

/// Park the window CENTRED at the top edge of the monitor the user is actually
/// working on (TJ 2026-07-20: „wird leider nicht mittig oben angezeigt"),
/// clamped so it can never land off-screen.
///
/// Der Bildschirm wird über den MAUSZEIGER bestimmt, nicht über
/// `current_monitor()`: das liefert den Monitor, auf dem das FENSTER zuletzt
/// geparkt wurde. Nach einem Monitorwechsel wäre der Toast also weiter auf dem
/// alten Schirm aufgetaucht — obwohl der Aufruf in `toast_show` genau das
/// verhindern sollte. Fällt auf den Fenster-Monitor zurück, wenn keine
/// Zeigerposition zu holen ist (z. B. headless/Tests).
fn position(app: &AppHandle, win: &WebviewWindow) {
    let mon = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| win.current_monitor().ok().flatten());
    let Some(mon) = mon else {
        return;
    };
    let scale = mon.scale_factor();
    let size = mon.size().to_logical::<f64>(scale);
    let origin = mon.position().to_logical::<f64>(scale);
    let x = (origin.x + (size.width - W) / 2.0).max(origin.x);
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
    position(&app, &win);
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
