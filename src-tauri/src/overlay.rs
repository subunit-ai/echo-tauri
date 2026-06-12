//! The floating orb overlay window: transparent, always-on-top, with a cursor
//! hit-test so the overlay only catches the mouse while the user engages the
//! orb — everywhere else, clicks pass through to the app underneath. The bubble
//! fallback is a pure visual indicator (always click-through).
//!
//! Window anatomy (the 2026-06 remodel): the orb canvas is a `dim × dim` square
//! sitting bottom-center, surrounded by transparent GUTTERS that give the
//! satellite islands room to live BESIDE the orb (left / right / above / below)
//! instead of on top of its drawing — so wide canvas styles (bars, wave) are
//! never covered. Hovering the orb engages the whole window (islands become
//! interactive); leaving the window rect disengages back to click-through.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::commands::AppState;

// Transparent space around the orb square for the satellite islands, in logical
// px. KEEP IN SYNC with the same constants in src/overlay/Orb.tsx — the React
// side lays the canvas + islands out against these exact insets.
pub const GUTTER_X: f64 = 168.0;
pub const GUTTER_TOP: f64 = 168.0;
pub const GUTTER_BOTTOM: f64 = 64.0;

/// Overlay window size for a given orb diameter (logical px).
fn window_size(dim: f64) -> (f64, f64) {
    (dim + 2.0 * GUTTER_X, dim + GUTTER_TOP + GUTTER_BOTTOM)
}

/// Start the cursor hit-test loop (idempotent via `hit_test_active`). While the
/// orb is shown it polls the global cursor and runs a small engage state machine:
/// disengaged → the only hot zone is the orb's inscribed circle (bottom-center
/// of the window); touching it engages the WHOLE window so the satellite islands
/// in the gutters are reachable. Moving outside the window rect disengages back
/// to click-through. Every transition is pushed to the webview via
/// `echo://orb-hover`, which is what shows/hides the islands (the webview gets
/// no mouse events while click-through, so it can't track hover itself). Exits
/// (and restores click-through) when the orb is hidden or the window closes.
pub fn ensure_hit_test(app: &AppHandle) {
    if app
        .state::<AppState>()
        .hit_test_active
        .swap(true, Ordering::SeqCst)
    {
        return; // a loop is already running
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(50));
        let mut last_ignore: Option<bool> = None;
        let mut engaged = false;
        loop {
            tick.tick().await;
            let orb_on = app.state::<AppState>().config.lock().use_orb_overlay;
            let win = app.get_webview_window("overlay");
            if !orb_on || win.is_none() {
                if let Some(w) = &win {
                    let _ = w.set_ignore_cursor_events(true); // leave it click-through
                }
                break;
            }
            let win = win.unwrap();
            let inside = match (
                app.cursor_position(),
                win.outer_position(),
                win.outer_size(),
                win.scale_factor(),
            ) {
                (Ok(cur), Ok(pos), Ok(size), Ok(scale)) => {
                    let (px, py) = (pos.x as f64, pos.y as f64);
                    let (w, h) = (size.width as f64, size.height as f64);
                    if engaged {
                        // Stay engaged anywhere inside the window rect.
                        cur.x >= px && cur.x <= px + w && cur.y >= py && cur.y <= py + h
                    } else {
                        // Engage only via the orb circle (bottom-center square).
                        let orb_d = (w - 2.0 * GUTTER_X * scale).max(1.0);
                        let cx = px + w / 2.0;
                        let cy = py + GUTTER_TOP * scale + orb_d / 2.0;
                        let r = orb_d / 2.0;
                        let (dx, dy) = (cur.x - cx, cur.y - cy);
                        dx * dx + dy * dy <= r * r
                    }
                }
                _ => false,
            };
            if inside != engaged {
                engaged = inside;
                let _ = app.emit("echo://orb-hover", serde_json::json!({ "hover": engaged }));
            }
            let ignore = !engaged;
            if last_ignore != Some(ignore) {
                let _ = win.set_ignore_cursor_events(ignore);
                last_ignore = Some(ignore);
            }
        }
        if engaged {
            // The loop can exit mid-engage (orb toggled off) — hide the islands.
            let _ = app.emit("echo://orb-hover", serde_json::json!({ "hover": false }));
        }
        app.state::<AppState>()
            .hit_test_active
            .store(false, Ordering::SeqCst);
    });
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("overlay").is_some() {
        return Ok(());
    }
    let (size_mult, position, orb_mode) = {
        let st = app.state::<AppState>();
        let c = st.config.lock();
        (c.orb_overlay_size as f64, c.orb_position.clone(), c.use_orb_overlay)
    };
    let dim = (150.0 * size_mult).clamp(80.0, 480.0);
    let (w, h) = window_size(dim);

    let win = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("Echo Overlay")
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .build()?;

    // Start click-through; the hit-test loop (orb mode) enables interactivity only
    // while the cursor is over the orb. Bubble mode stays click-through throughout.
    let _ = win.set_ignore_cursor_events(true);
    position_window(&win, &position, dim);
    if orb_mode {
        ensure_hit_test(app);
    }
    Ok(())
}

/// Apply the current config to the live overlay so changes in Settings take effect
/// immediately (no restart): create/close the window when `use_orb_overlay` toggles,
/// resize + reposition for size/position, and push the visual settings
/// (style/color/idle/auto-hide) to the canvas. Called from `set_config`.
pub fn apply_config(app: &AppHandle) {
    let (orb_mode, show_bubble, size_mult, position, style, color_idle, color_working, color_done, idle_pulse, idle_mode, speed, quick) = {
        let st = app.state::<AppState>();
        let c = st.config.lock();
        (
            c.use_orb_overlay,
            c.show_bubble,
            c.orb_overlay_size as f64,
            c.orb_position.clone(),
            c.orb_overlay_style.clone(),
            c.orb_color_idle.clone(),
            c.orb_color_working.clone(),
            c.orb_color_done.clone(),
            c.orb_idle_pulse,
            c.orb_idle_mode.clone(),
            c.orb_speed,
            // Satellite quick-state so the orb reflects mode/language/cleanup
            // changes made from the main window (Settings / BigModeSwitch) live.
            crate::commands::orb_quick_json(&c),
        )
    };
    // Orb wins when enabled; otherwise the bubble is the fallback indicator.
    let enabled = orb_mode || show_bubble;

    // Disabled → close the window if it's open and stop.
    if !enabled {
        if let Some(w) = app.get_webview_window("overlay") {
            let _ = w.close();
        }
        return;
    }

    // Enabled → ensure the window exists, then resize/reposition to match.
    if app.get_webview_window("overlay").is_none() {
        let _ = create(app);
    }
    let Some(win) = app.get_webview_window("overlay") else {
        return;
    };
    let dim = (150.0 * size_mult).clamp(80.0, 480.0);
    let (w, h) = window_size(dim);
    let _ = win.set_size(LogicalSize::new(w, h));
    // Orb = dynamic cursor hit-test (idempotent), bubble = always click-through.
    if orb_mode {
        ensure_hit_test(app);
    } else {
        let _ = win.set_ignore_cursor_events(true);
    }
    position_window(&win, &position, dim);

    // Push the visual config; the overlay root picks Orb vs Bubble from `orbEnabled`
    // and the Orb restyles from the rest — all without a reload.
    let _ = app.emit(
        "echo://orb-config",
        serde_json::json!({
            "orbEnabled": orb_mode,
            "style": style,
            "colorIdle": color_idle,
            "colorWorking": color_working,
            "colorDone": color_done,
            "idlePulse": idle_pulse,
            "idleMode": idle_mode,
            "speed": speed,
            "quick": quick,
        }),
    );
}

/// Place the overlay so the ORB (not the window) sits at the anchor. The anchor
/// string — including drag-saved "custom-<x>-<y>" values from before the gutter
/// remodel — always describes the orb square's top-left in logical screen px;
/// the window extends beyond it by the gutters. The final window position is
/// clamped fully on-screen so the satellite islands always have room to open.
fn position_window(win: &WebviewWindow, anchor: &str, dim: f64) {
    let monitor = match win.current_monitor() {
        Ok(Some(m)) => m,
        _ => return,
    };
    let scale = monitor.scale_factor();
    let msize = monitor.size().to_logical::<f64>(scale);
    let mpos = monitor.position().to_logical::<f64>(scale);
    let (w, h) = window_size(dim);

    // Drag-set custom position: "custom-<x>-<y>" (orb top-left, logical px).
    let custom = anchor.strip_prefix("custom-").and_then(|rest| {
        let mut it = rest.splitn(2, '-');
        match (it.next()?.parse::<f64>(), it.next()?.parse::<f64>()) {
            (Ok(x), Ok(y)) => Some((x, y)),
            _ => None,
        }
    });

    let (orb_x, orb_y) = custom.unwrap_or_else(|| {
        let margin = 40.0;
        let bottom_margin = 64.0; // clear the taskbar/dock
        let x = if anchor.contains("left") {
            mpos.x + margin
        } else if anchor.contains("right") {
            mpos.x + msize.width - dim - margin
        } else {
            mpos.x + (msize.width - dim) / 2.0
        };
        let y = if anchor.contains("top") {
            mpos.y + margin
        } else {
            mpos.y + msize.height - dim - bottom_margin
        };
        (x, y)
    });

    // Orb anchor → window top-left, clamped into the monitor (min wins when the
    // monitor is somehow smaller than the window).
    let x = (orb_x - GUTTER_X)
        .min(mpos.x + msize.width - w)
        .max(mpos.x);
    let y = (orb_y - GUTTER_TOP)
        .min(mpos.y + msize.height - h)
        .max(mpos.y);
    let _ = win.set_position(LogicalPosition::new(x, y));
}
