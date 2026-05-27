//! The floating orb overlay window: transparent, always-on-top, click-through.
//!
//! v1 is a pure visual indicator (cursor events ignored). Interactive satellites
//! + drag-to-reposition are a follow-up (they need cursor-position toggling of
//! `set_ignore_cursor_events`).

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::commands::AppState;

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("overlay").is_some() {
        return Ok(());
    }
    let (size_mult, position) = {
        let st = app.state::<AppState>();
        let c = st.config.lock();
        (c.orb_overlay_size as f64, c.orb_position.clone())
    };
    let dim = (150.0 * size_mult).clamp(80.0, 480.0);

    let win = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("Echo Overlay")
        .inner_size(dim, dim)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .build()?;

    // Pure visual indicator for now — let clicks pass through to the app behind.
    let _ = win.set_ignore_cursor_events(true);
    position_window(&win, &position, dim);
    Ok(())
}

/// Apply the current config to the live overlay so changes in Settings take effect
/// immediately (no restart): create/close the window when `use_orb_overlay` toggles,
/// resize + reposition for size/position, and push the visual settings
/// (style/color/idle/auto-hide) to the canvas. Called from `set_config`.
pub fn apply_config(app: &AppHandle) {
    let (enabled, size_mult, position, style, color, idle_pulse, auto_hide) = {
        let st = app.state::<AppState>();
        let c = st.config.lock();
        (
            c.use_orb_overlay,
            c.orb_overlay_size as f64,
            c.orb_position.clone(),
            c.orb_overlay_style.clone(),
            c.orb_color_theme.clone(),
            c.orb_idle_pulse,
            c.orb_overlay_auto_hide,
        )
    };

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
    let _ = win.set_size(LogicalSize::new(dim, dim));
    position_window(&win, &position, dim);

    // Push the visual style to the canvas; the Orb listens for this and restyles
    // without a reload. (On a fresh create the canvas also reads get_config on mount.)
    let _ = app.emit(
        "echo://orb-config",
        serde_json::json!({
            "style": style,
            "color": color,
            "idlePulse": idle_pulse,
            "autoHide": auto_hide,
        }),
    );
}

fn position_window(win: &WebviewWindow, anchor: &str, dim: f64) {
    let monitor = match win.current_monitor() {
        Ok(Some(m)) => m,
        _ => return,
    };
    let scale = monitor.scale_factor();
    let msize = monitor.size().to_logical::<f64>(scale);
    let mpos = monitor.position().to_logical::<f64>(scale);

    // Drag-set custom position: "custom-<x>-<y>" (screen-relative logical px).
    if let Some(rest) = anchor.strip_prefix("custom-") {
        let mut it = rest.splitn(2, '-');
        if let (Some(x), Some(y)) = (it.next(), it.next()) {
            if let (Ok(x), Ok(y)) = (x.parse::<f64>(), y.parse::<f64>()) {
                let _ = win.set_position(LogicalPosition::new(x, y));
                return;
            }
        }
    }

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
    let _ = win.set_position(LogicalPosition::new(x, y));
}
