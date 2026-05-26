//! The floating orb overlay window: transparent, always-on-top, click-through.
//!
//! v1 is a pure visual indicator (cursor events ignored). Interactive satellites
//! + drag-to-reposition are a follow-up (they need cursor-position toggling of
//! `set_ignore_cursor_events`).

use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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
