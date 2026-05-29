//! Paste-back / target injection (port of the heart of `target_lock.py`).
//!
//! Capture the focused window at record-start, then focus it again right before
//! pasting — so dictation lands in the user's app even if focus moved (e.g. the
//! in-app record button). For the global-hotkey flow the target already has
//! focus, so this is belt-and-suspenders there.
//!
//! Two independent axes (mirrors the user's mental model):
//!  * **Streaming / live mode** (`live_type`): WhisperLive WS → `type_live()` types
//!    each segment in as you speak. ALWAYS live typing — no choice (it can't paste).
//!  * **Chunk / instant mode** (`live_type` off): one full transcript at the end,
//!    delivered by `deliver()` either as an **instant paste** (clipboard + Ctrl/Cmd+V,
//!    atomic, the default) or — when `instant_live_typing` is on — **live-typed** in
//!    via Unicode keystrokes. Independent of the streaming toggle.
//!
//! Both injection paths first `clear_modifiers()` — a still-held hotkey modifier
//! (e.g. Ctrl from `<ctrl>+<space>`) was the Win-ARM "random char spam" cause.
//!
//! Every step is logged (see `tauri_plugin_log` wiring in lib.rs) so a field log
//! pulled over the Bridge tells us exactly which path ran and where it failed.
//! We log COUNTS only via `text_stats()` — never the transcript content.

use crate::config::Config;
use std::time::Instant;

/// A captured target window. Platform-encoded in `id` (empty = none) so the
/// struct stays `Send` for the shared state without per-OS enum variants.
#[derive(Clone, Debug, Default)]
pub struct Target {
    pub id: String,
    /// Window title (for Auto-Mode style selection). Best-effort.
    pub title: String,
}

/// Privacy-safe one-liner about the text we're about to inject — COUNTS ONLY,
/// never the content (these logs can be pulled off a user's machine to debug).
fn text_stats(text: &str) -> String {
    let chars = text.chars().count();
    let non_ascii = text.chars().filter(|c| !c.is_ascii()).count();
    let newlines = text.chars().filter(|&c| c == '\n').count();
    format!(
        "chars={chars} bytes={} non_ascii={non_ascii} newlines={newlines}",
        text.len()
    )
}

/// Truncate a window title for logging (titles can carry document names).
fn short_title(title: &str) -> String {
    let t: String = title.chars().take(80).collect();
    if title.chars().count() > 80 {
        format!("{t}…")
    } else {
        t
    }
}

/// Capture the currently focused window so we can paste back into it later.
pub fn capture_active_window() -> Target {
    #[cfg(target_os = "linux")]
    {
        if let Ok(out) = std::process::Command::new("xdotool")
            .arg("getactivewindow")
            .output()
        {
            if out.status.success() {
                let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !id.is_empty() {
                    let title = std::process::Command::new("xdotool")
                        .args(["getwindowname", &id])
                        .output()
                        .ok()
                        .filter(|o| o.status.success())
                        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                        .unwrap_or_default();
                    log::debug!("capture: linux target id={id} title=\"{}\"", short_title(&title));
                    return Target { id, title };
                }
            }
        }
        log::debug!("capture: no active window (linux)");
    }
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
        unsafe {
            let hwnd = GetForegroundWindow();
            if !hwnd.0.is_null() {
                let mut buf = [0u16; 512];
                let len = GetWindowTextW(hwnd, &mut buf);
                let title = if len > 0 {
                    String::from_utf16_lossy(&buf[..len as usize])
                } else {
                    String::new()
                };
                let id = (hwnd.0 as isize).to_string();
                log::debug!("capture: win target hwnd={id} title=\"{}\"", short_title(&title));
                // Encode the HWND pointer as a decimal string so Target stays Send.
                return Target { id, title };
            }
        }
        log::debug!("capture: no foreground window (win)");
    }
    // macOS target capture is a follow-up (needs core-graphics / AX). The hotkey
    // flow doesn't steal focus, so paste lands correctly there without it.
    Target::default()
}

fn focus(target: &Target) {
    if target.id.is_empty() {
        log::debug!("focus: no target id, skip");
        return;
    }
    #[cfg(target_os = "linux")]
    {
        let ok = std::process::Command::new("xdotool")
            .args(["windowactivate", "--sync", &target.id])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        log::debug!("focus: linux windowactivate id={} ok={ok}", target.id);
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
        if let Ok(raw) = target.id.parse::<isize>() {
            let hwnd = HWND(raw as *mut core::ffi::c_void);
            let ok = unsafe { SetForegroundWindow(hwnd) };
            log::debug!("focus: win SetForegroundWindow hwnd={} ok={}", target.id, ok.as_bool());
            std::thread::sleep(std::time::Duration::from_millis(40));
        } else {
            log::warn!("focus: unparseable target id={}", target.id);
        }
    }
}

/// Release any modifier that might still be held (e.g. Ctrl from `<ctrl>+<space>`).
/// A lingering modifier turns Unicode typing AND a synthetic Ctrl+V into garbage —
/// the #1 cause of the Win-ARM "random character spam" Erik reported. Releasing a
/// key that isn't down is a harmless no-op.
fn clear_modifiers(enigo: &mut enigo::Enigo) {
    use enigo::{Direction, Key, Keyboard};
    for k in [Key::Control, Key::Shift, Key::Alt, Key::Meta] {
        if let Err(e) = enigo.key(k, Direction::Release) {
            log::debug!("clear_modifiers: release {k:?} err: {e}");
        }
    }
}

/// Deliver the transcript: always copy to clipboard (so a manual paste still works);
/// when `autopaste` is on, inject via the configured `paste_strategy` (focusing the
/// captured target first when `target_lock` is on).
pub fn deliver(text: &str, cfg: &Config, target: Option<&Target>) -> anyhow::Result<()> {
    if text.trim().is_empty() {
        log::debug!("deliver: empty text, skip");
        return Ok(());
    }
    let t0 = Instant::now();
    let method = if cfg.instant_live_typing { "live-type" } else { "instant-paste" };
    log::info!(
        "deliver: method={method} autopaste={} target_lock={} {}",
        cfg.autopaste,
        cfg.target_lock,
        text_stats(text)
    );

    set_clipboard(text)?;
    log::debug!("deliver: clipboard set (+{:?})", t0.elapsed());

    if !cfg.autopaste {
        log::info!("deliver: autopaste off — clipboard only (+{:?})", t0.elapsed());
        return Ok(());
    }

    if cfg.target_lock {
        match target {
            Some(t) => focus(t),
            None => log::debug!("deliver: target_lock on but no captured target"),
        }
    }

    if cfg.instant_live_typing {
        type_text(text)?;
    } else {
        paste()?;
    }
    log::info!("deliver: done via {method} (+{:?})", t0.elapsed());
    Ok(())
}

pub fn set_clipboard(text: &str) -> anyhow::Result<()> {
    let mut cb = arboard::Clipboard::new().map_err(|e| {
        log::error!("clipboard: open failed: {e}");
        anyhow::anyhow!("clipboard: {e}")
    })?;
    cb.set_text(text.to_string()).map_err(|e| {
        log::error!("clipboard: set failed: {e}");
        anyhow::anyhow!("clipboard set: {e}")
    })?;
    Ok(())
}

/// Clipboard + platform paste chord (Ctrl/Cmd+V). Atomic — no per-char spam.
fn paste() -> anyhow::Result<()> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};

    let t0 = Instant::now();
    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|e| anyhow::anyhow!("enigo init: {e}"))?;

    clear_modifiers(&mut enigo);
    std::thread::sleep(std::time::Duration::from_millis(20));

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| anyhow::anyhow!("paste press: {e}"))?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| anyhow::anyhow!("paste v: {e}"))?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| anyhow::anyhow!("paste release: {e}"))?;
    log::info!("paste: chord sent (+{:?})", t0.elapsed());
    Ok(())
}

/// Focus the captured target (when target_lock is on) and type a live-dictation
/// segment with modifier-free Unicode typing — appends without touching the
/// clipboard, so it can fire repeatedly while the user keeps speaking.
pub fn type_live(text: &str, cfg: &Config, target: Option<&Target>) -> anyhow::Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    log::debug!("type_live: {} target_lock={}", text_stats(text), cfg.target_lock);
    if cfg.target_lock {
        if let Some(t) = target {
            focus(t);
        }
    }
    type_text(text)
}

/// Modifier-free Unicode typing (streaming + the "type" strategy).
pub fn type_text(text: &str) -> anyhow::Result<()> {
    use enigo::{Enigo, Keyboard, Settings};
    let t0 = Instant::now();
    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|e| anyhow::anyhow!("enigo init: {e}"))?;
    clear_modifiers(&mut enigo);
    std::thread::sleep(std::time::Duration::from_millis(20));
    log::debug!("type_text: typing {} via Unicode", text_stats(text));
    enigo
        .text(text)
        .map_err(|e| anyhow::anyhow!("type: {e}"))?;
    log::info!("type_text: done (+{:?})", t0.elapsed());
    Ok(())
}
