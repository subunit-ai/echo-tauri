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
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::commands::AppState;

// Transparent space around the orb square for the satellite islands, in logical
// px. KEEP IN SYNC with the same constants in src/overlay/Orb.tsx — the React
// side lays the canvas + islands out against these exact insets. The side/top
// gutters are wide enough that an expanded panel blooms BEYOND its chip (further
// from the orb) instead of on top of it, with the chip staying put.
pub const GUTTER_X: f64 = 224.0;
pub const GUTTER_TOP: f64 = 190.0;
pub const GUTTER_BOTTOM: f64 = 64.0;

/// One interactive rectangle of the overlay (logical px, window-local), as
/// reported by the webview: the orb, a visible chip, or the open panel. The
/// hit-test loop makes the window mouse-opaque only over the union of these, so
/// the transparent gaps between them pass clicks through to the app behind.
/// `panel` labels which satellite the rect belongs to (mode/language/cleanup) so
/// the loop can tell the webview which panel to OPEN — driven by the global
/// cursor poll, NOT by webview DOM hover (a non-key macOS window gets no
/// mouseMoved, so the islands were dead until you clicked the orb to focus it).
#[derive(Clone, serde::Deserialize)]
pub struct HotRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// "mode" | "language" | "cleanup" for a satellite's chip / open panel zone;
    /// None for the orb, the console chip, and plain hit-only rects.
    #[serde(default)]
    pub panel: Option<String>,
}

impl HotRect {
    fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }
    /// Grow the rect by `p` on every side (the engage slack — see the loop).
    fn inflated(&self, p: f64) -> HotRect {
        HotRect {
            x: self.x - p,
            y: self.y - p,
            w: self.w + 2.0 * p,
            h: self.h + 2.0 * p,
            panel: None,
        }
    }
}

/// The overlay webview reports its interactive rectangles here whenever they
/// change (hover toggles, a panel opens/closes, the orb is resized). The
/// hit-test loop reads them to decide where the window catches the mouse.
#[tauri::command]
pub fn overlay_set_hot_rects(state: tauri::State<'_, AppState>, rects: Vec<HotRect>) {
    *state.overlay_hot_rects.lock() = rects;
}

/// Overlay window size for a given orb diameter (logical px).
fn window_size(dim: f64) -> (f64, f64) {
    (dim + 2.0 * GUTTER_X, dim + GUTTER_TOP + GUTTER_BOTTOM)
}

/// Centre of the orb/pill in LOGICAL screen coordinates plus the orb square's
/// diameter — the anchor the prompt terminal's genie animation flows out of /
/// vanishes into (the diameter sizes the funnel mouth: the pill capsule is
/// dim·0.98 wide, see orbRender "pill"). None while the overlay isn't up or
/// visible (orb disabled / hidden) — callers fall back to a plain scale-fade.
///
/// Verified against ground truth 2026-07-08 (CGWindowList: overlay at
/// 484,601 528×334 → anchor 748,831 = the drawn pill centre on screen).
pub fn orb_anchor(app: &AppHandle) -> Option<(f64, f64, f64)> {
    let win = app.get_webview_window("overlay")?;
    if !win.is_visible().unwrap_or(false) {
        return None;
    }
    let sf = win.scale_factor().unwrap_or(1.0);
    let pos = win.outer_position().ok()?;
    let size = win.inner_size().ok()?;
    let x = pos.x as f64 / sf;
    let y = pos.y as f64 / sf;
    let w = size.width as f64 / sf;
    // The orb square sits between the gutters; its centre is the pill centre
    // for every overlay style (the pill renders centred inside the square).
    let dim = (w - 2.0 * GUTTER_X).max(1.0);
    Some((x + w / 2.0, y + GUTTER_TOP + dim / 2.0, dim))
}

/// Orb diameter (logical px) for a configured size multiplier — the ONE place
/// this formula lives; config migration and the drag-save derive centres from it.
pub fn orb_dim(size_mult: f64) -> f64 {
    (150.0 * size_mult).clamp(80.0, 480.0)
}

/// Start the cursor hit-test loop (idempotent via `hit_test_active`). While the
/// orb is shown it polls the global cursor and maintains TWO independent things:
///
/// * **capture** (`set_ignore_cursor_events`): the window catches the mouse ONLY
///   when the cursor is over a real interactive rectangle — the orb square, or a
///   chip / open panel the webview reported via `overlay_set_hot_rects`. Over the
///   transparent GAPS between them the window is click-through, so clicks reach
///   the app behind (the gutters no longer block anything). No grace period —
///   gaps go through at once.
/// * **engage** (`echo://orb-hover`): whether the satellite chips are shown. This
///   is sticky — true within a generous pad around the cluster, and it lingers a
///   short grace after the cursor leaves so traversing the gaps (or the frame
///   before the webview re-reports its rects) never flickers the menu. The
///   webview gets no mouse events while click-through, so it relies on this
///   signal — it can't track hover itself.
///
/// The orb square is always treated as hot/engageable (computed from the window
/// size) so first-hover works even before the webview has reported anything.
/// Exits (and restores click-through) when the orb is hidden or the window closes.
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
        // Poll fast — this only reads the cursor + does a few point-in-rect tests,
        // so 16 ms keeps both the hover-open and the click-through toggle instant.
        let mut tick = tokio::time::interval(Duration::from_millis(16));
        let mut last_ignore: Option<bool> = None;
        let mut engaged = false;
        let mut left_at: Option<Instant> = None;
        // Which satellite the cursor is over right now (mode/language/cleanup) —
        // emitted so the webview OPENS that panel without needing DOM hover (a
        // non-key window gets no mouseMoved, so the islands were unreachable until
        // you clicked the orb to focus the window). None = over the orb / a gap.
        let mut last_over: Option<String> = None;
        // Click-trigger island state (TJ, two fixes in one):
        //  • `active` — islands are only shown after a REAL click on the orb, and
        //    a further plain click toggles them away again. Focus alone is not
        //    enough: when the hotkey starts a take while Echo is the active app,
        //    macOS hands the freshly shown overlay key status and the old
        //    focus-driven engage popped the islands uninvited.
        //  • `press` holds the GLOBAL cursor at mouse-down on the orb (drag
        //    detection must be global — dragging moves the window WITH the
        //    cursor); `focused_at` separates the activation click from toggle
        //    clicks; `last_orb_press` marks focus changes that came from the orb.
        let mut btn_prev = false;
        let mut press: Option<(f64, f64)> = None;
        let mut active = false;
        let mut focused_at: Option<Instant> = None;
        let mut last_orb_press: Option<Instant> = None;
        // Engage slack around every interactive rect, so crossing the air between
        // the orb and a chip keeps the menu up.
        const PAD: f64 = 36.0;
        // Keep the menu up this long after the cursor leaves the cluster.
        const GRACE: Duration = Duration::from_millis(150);
        loop {
            tick.tick().await;
            let st = app.state::<AppState>();
            let (orb_on, click_mode, hide_when_idle) = {
                let c = st.config.lock();
                (c.use_orb_overlay, c.orb_trigger == "click", c.orb_idle_mode == "hide")
            };
            let recording = st.recorder.is_recording();
            let win = app.get_webview_window("overlay");
            if !orb_on || win.is_none() {
                if let Some(w) = &win {
                    let _ = w.set_ignore_cursor_events(true); // leave it click-through
                }
                break;
            }
            let win = win.unwrap();
            // Inert (fully click-through, never engage) whenever the orb is meant
            // to be GONE: the window is actually hidden, OR idle-"hide" mode while
            // not recording. The canvas already renders nothing in hide+idle, but
            // the window can still be visible+clickable before the first state
            // transition hides it — so clicking the orb's blank spot would still
            // pop the islands. Gate on the config+recording state directly so the
            // orb only EXISTS once the hotkey starts a take (TJ: "darf nicht
            // existent sein wenn man nicht die Tastenkombi drückt"). (#32)
            if !win.is_visible().unwrap_or(true) || (hide_when_idle && !recording) {
                if last_ignore != Some(true) {
                    let _ = win.set_ignore_cursor_events(true);
                    last_ignore = Some(true);
                }
                if engaged || last_over.is_some() {
                    engaged = false;
                    last_over = None;
                    let _ = app.emit("echo://orb-hover", serde_json::json!({ "hover": false }));
                }
                continue;
            }
            let (capture, inside_engage, over, cursor) = match (
                app.cursor_position(),
                win.outer_position(),
                win.outer_size(),
                win.scale_factor(),
            ) {
                (Ok(cur), Ok(pos), Ok(size), Ok(scale)) => {
                    // Cursor in window-local LOGICAL px — same space as the rects
                    // the webview reports (getBoundingClientRect-equivalent).
                    let lx = (cur.x - pos.x as f64) / scale;
                    let ly = (cur.y - pos.y as f64) / scale;
                    let wl = size.width as f64 / scale;
                    let dim = (wl - 2.0 * GUTTER_X).max(1.0);
                    // The orb square is always hot (engage + drag), even before the
                    // webview reports — guarantees first-hover engages.
                    let orb = HotRect {
                        x: GUTTER_X,
                        y: GUTTER_TOP,
                        w: dim,
                        h: dim,
                        panel: None,
                    };
                    let rects = app.state::<AppState>().overlay_hot_rects.lock().clone();
                    let in_orb = orb.contains(lx, ly);
                    let cap = in_orb || rects.iter().any(|r| r.contains(lx, ly));
                    let eng = orb.inflated(PAD).contains(lx, ly)
                        || rects.iter().any(|r| r.inflated(PAD).contains(lx, ly));
                    // Which satellite zone (chip or its merged panel rect) the cursor
                    // sits in — drives the open panel from the global poll.
                    let over = rects
                        .iter()
                        .find(|r| r.panel.is_some() && r.contains(lx, ly))
                        .and_then(|r| r.panel.clone());
                    // Cursor for the click-toggle: in-orb flag + GLOBAL position
                    // (drag detection must be global — a window drag moves the
                    // window WITH the cursor, so local coords barely change).
                    (cap, eng, over, Some((in_orb, cur.x, cur.y)))
                }
                _ => (false, false, None, None),
            };
            // Engage source depends on the trigger mode:
            //  • click: the islands show while the overlay window is focused AND
            //    `active` — set by a real click on the orb (focus gained any other
            //    way, e.g. the hotkey showing the window while Echo is the active
            //    app, does NOT count), toggled off/on by further plain clicks,
            //    cleared when focus is lost.
            //  • hover: sticky cursor-in-cluster with a short grace.
            // `capture` is always immediate so the orb stays clickable and gaps
            // stay click-through in both modes.
            let want = if click_mode {
                left_at = None;
                let focused = win.is_focused().unwrap_or(false);
                let btn = left_button_down();
                let pressed_edge = btn && !btn_prev;
                let released_edge = !btn && btn_prev;
                btn_prev = btn;
                if pressed_edge {
                    if let Some((true, gx, gy)) = cursor {
                        last_orb_press = Some(Instant::now());
                        // Arm a toggle click only when focus is already old — the
                        // ACTIVATION click (focus arrives with this very press) is
                        // handled by the focus edge below, not as a toggle.
                        press = match focused_at {
                            Some(t) if t.elapsed() > Duration::from_millis(250) => {
                                Some((gx, gy))
                            }
                            _ => None,
                        };
                    } else {
                        press = None;
                    }
                }
                if focused {
                    if focused_at.is_none() {
                        focused_at = Some(Instant::now());
                        // Focus edge: islands open only when this focus came from
                        // a fresh click on the orb itself.
                        active = matches!(last_orb_press, Some(t) if t.elapsed() < Duration::from_millis(400));
                    }
                } else {
                    focused_at = None;
                    active = false;
                    press = None;
                }
                if released_edge {
                    if let (Some((px, py)), Some((true, gx, gy))) = (press, cursor) {
                        // A plain CLICK (released near the press, still on the
                        // orb) — not a window drag — toggles the islands.
                        if (gx - px).abs() < 6.0 && (gy - py).abs() < 6.0 {
                            active = !active;
                        }
                    }
                    press = None;
                }
                focused && active
            } else if inside_engage {
                left_at = None;
                true
            } else {
                if engaged && left_at.is_none() {
                    left_at = Some(Instant::now());
                }
                matches!(left_at, Some(t) if t.elapsed() < GRACE)
            };
            // `over` only matters while engaged; emit when EITHER hover or the
            // hovered satellite changes (the webview opens that panel).
            let over = if want { over } else { None };
            if want != engaged || over != last_over {
                engaged = want;
                last_over = over.clone();
                let _ = app.emit(
                    "echo://orb-hover",
                    serde_json::json!({ "hover": engaged, "over": over }),
                );
            }
            let ignore = !capture;
            if last_ignore != Some(ignore) {
                let _ = win.set_ignore_cursor_events(ignore);
                last_ignore = Some(ignore);
            }
        }
        if engaged {
            // The loop can exit mid-engage (orb toggled off) — hide the chips.
            let _ = app.emit("echo://orb-hover", serde_json::json!({ "hover": false }));
        }
        app.state::<AppState>()
            .hit_test_active
            .store(false, Ordering::SeqCst);
    });
}

/// Pin the overlay to the frontmost layer on macOS: raise the NSWindow level
/// above floating + the Dock and let it join every Space / sit over other apps'
/// fullscreen, so the orb is ALWAYS visible. Tauri's `always_on_top` only reaches
/// the floating level (3), which other floating/fullscreen windows can still
/// cover. No-op elsewhere (their `always_on_top` already suffices).
#[cfg(target_os = "macos")]
fn pin_topmost(win: &WebviewWindow) {
    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};
    let Ok(ptr) = win.ns_window() else {
        return;
    };
    let ns = ptr as *mut Object;
    // NSStatusWindowLevel (25): above normal windows + the Dock (20), below the
    // intrusive menu/screensaver levels. canJoinAllSpaces(1<<0) | stationary(1<<4)
    // | fullScreenAuxiliary(1<<8) → present on every Space and over fullscreen.
    let level: i64 = 25;
    let behavior: u64 = (1 << 0) | (1 << 4) | (1 << 8);
    unsafe {
        let _: () = msg_send![ns, setLevel: level];
        let _: () = msg_send![ns, setCollectionBehavior: behavior];
    }
}
#[cfg(not(target_os = "macos"))]
fn pin_topmost(_win: &WebviewWindow) {}

/// Whether the LEFT mouse button is currently held — polled by the hit-test
/// loop to catch a plain click on the orb in click-trigger mode. The webview
/// can't see that click reliably (the orb canvas is a drag region and a
/// non-key window gets no mouse events at all), so the loop watches the
/// global button state instead. macOS: NSEvent's pressed-buttons bitmask
/// (class method, safe off the main thread). Windows: async key state.
/// Elsewhere: unavailable → the dismiss-toggle is simply inert.
#[cfg(target_os = "macos")]
fn left_button_down() -> bool {
    use objc::{class, msg_send, sel, sel_impl};
    let btns: usize = unsafe { msg_send![class!(NSEvent), pressedMouseButtons] };
    btns & 1 != 0
}
#[cfg(target_os = "windows")]
fn left_button_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    ((unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) }) as u16 & 0x8000) != 0
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn left_button_down() -> bool {
    false
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
    let dim = orb_dim(size_mult);
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

    // Fresh window → drop any stale hit-rects from a previous overlay instance;
    // the webview re-reports them on mount.
    app.state::<AppState>().overlay_hot_rects.lock().clear();

    // Start click-through; the hit-test loop (orb mode) enables interactivity only
    // while the cursor is over the orb. Bubble mode stays click-through throughout.
    let _ = win.set_ignore_cursor_events(true);
    position_window(&win, &position, dim);
    pin_topmost(&win); // always the frontmost layer (macOS NSWindow level)
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
    let (orb_mode, show_bubble, size_mult, position, style, color_idle, color_working, color_done, color_error, idle_pulse, idle_mode, speed, appear, pill_color_mode, pill_reaction, quick) = {
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
            c.orb_color_error.clone(),
            c.orb_idle_pulse,
            c.orb_idle_mode.clone(),
            c.orb_speed,
            c.orb_appear_anim.clone(),
            c.orb_pill_color_mode.clone(),
            c.orb_pill_reaction.clone(),
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
    let dim = orb_dim(size_mult);
    let (w, h) = window_size(dim);
    let _ = win.set_size(LogicalSize::new(w, h));
    // Orb = dynamic cursor hit-test (idempotent), bubble = always click-through.
    if orb_mode {
        ensure_hit_test(app);
    } else {
        let _ = win.set_ignore_cursor_events(true);
    }
    position_window(&win, &position, dim);
    pin_topmost(&win); // re-assert the frontmost level after any config change

    // #32: reflect the idle-"hide" choice now — a hidden window is physically
    // gone (no hover flyout over its old spot), not just a blank canvas. Don't
    // hide mid-session; emit_state flips visibility as the engine state changes.
    if orb_mode {
        let recording = app.state::<AppState>().recorder.is_recording();
        if idle_mode == "hide" && !recording {
            let _ = win.hide();
        } else {
            let _ = win.show();
        }
    }

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
            "colorError": color_error,
            "idlePulse": idle_pulse,
            "idleMode": idle_mode,
            "speed": speed,
            "appear": appear,
            "pillColorMode": pill_color_mode,
            "pillReaction": pill_reaction,
            "quick": quick,
        }),
    );

    // Live-push the Prompt Terminal appearance (blur on/off, dark/light, and
    // the pill accent color) so Settings toggles restyle the open terminal
    // without reopening. The terminal window also reads these on mount.
    let (blur, theme, pill_accent) = {
        let st = app.state::<AppState>();
        let c = st.config.lock();
        (
            c.prompt_terminal_blur,
            c.prompt_terminal_theme.clone(),
            c.orb_color_idle.clone(),
        )
    };
    // The terminal webview owns the frost + calls prompt_set_effects, so it
    // applies the material change itself on receiving this (attach/strip
    // vibrancy, raise/melt the frost).
    let _ = app.emit_to(
        crate::prompt_console::LABEL,
        "echo://prompt-config",
        serde_json::json!({ "blur": blur, "theme": theme, "pillColor": pill_accent }),
    );
}

/// Parse the "<x>-<y>" tail of a saved position. x can itself be negative
/// (monitor left of primary → "…--12-300"), so a fixed split on the first '-'
/// mis-parses; try every '-' as the separator until both halves parse.
pub fn parse_pos_pair(rest: &str) -> Option<(f64, f64)> {
    rest.match_indices('-').find_map(|(i, _)| {
        if i == 0 {
            return None; // leading '-' is x's sign, not the separator
        }
        match (rest[..i].parse::<f64>(), rest[i + 1..].parse::<f64>()) {
            (Ok(x), Ok(y)) => Some((x, y)),
            _ => None,
        }
    })
}

/// Place the overlay so the ORB (not the window) sits at the anchor. Drag-set
/// positions are stored as "center-<x>-<y>" — the orb's CENTRE in logical
/// screen px — so a size change scales the orb in place around that point
/// instead of letting it wander (TJ: "es muss an der Stelle bleiben").
/// Legacy "custom-<x>-<y>" values (orb top-left; pre-0.5.4 saves, normally
/// converted by Config::migrate) still place correctly. The final window
/// position is clamped fully on-screen so the islands always have room.
fn position_window(win: &WebviewWindow, anchor: &str, dim: f64) {
    let monitor = match win.current_monitor() {
        Ok(Some(m)) => m,
        _ => return,
    };
    let scale = monitor.scale_factor();
    let msize = monitor.size().to_logical::<f64>(scale);
    let mpos = monitor.position().to_logical::<f64>(scale);
    let (w, h) = window_size(dim);

    let custom = anchor
        .strip_prefix("center-")
        .and_then(parse_pos_pair)
        .map(|(cx, cy)| (cx - dim / 2.0, cy - dim / 2.0))
        .or_else(|| anchor.strip_prefix("custom-").and_then(parse_pos_pair));

    let (orb_x, orb_y) = custom.unwrap_or_else(|| {
        let margin = 40.0;
        // Clear the taskbar/dock. 64 sat INSIDE the default macOS Dock edge
        // (TJ, v0.5.95), but 96 floated way too high (TJ, v0.5.97) — he wants
        // the pill just BARELY above the Dock: original 64 + ~10.
        let bottom_margin = 74.0;
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
    // Tell the orb this move is OURS (anchor placement), not a user drag — its
    // onMoved handler would otherwise debounce-save the new spot as "center-…",
    // silently overwriting a freshly-picked named anchor like "bottom-center"
    // (the dropdown choice never stuck).
    let _ = win.emit("echo://orb-anchored", ());
    let _ = win.set_position(LogicalPosition::new(x, y));
}
