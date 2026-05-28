//! Paste-back / target injection (port of the heart of `target_lock.py`).
//!
//! Capture the focused window at record-start, then focus it again right before
//! pasting — so dictation lands in the user's app even if focus moved (e.g. the
//! in-app record button). For the global-hotkey flow the target already has
//! focus, so this is belt-and-suspenders there.
//!
//! Paths:
//!  * **paste** — clipboard (arboard) + platform paste chord (enigo Ctrl/Cmd+V).
//!  * **type_text** — modifier-free Unicode typing (enigo `.text`), the robust
//!    path on Win-ARM (synthetic Ctrl+V loses the modifier under x64 emulation);
//!    also for streaming dictation.

use crate::config::Config;

/// A captured target window. Platform-encoded in `id` (empty = none) so the
/// struct stays `Send` for the shared state without per-OS enum variants.
#[derive(Clone, Debug, Default)]
pub struct Target {
    pub id: String,
    /// Window title (for Auto-Mode style selection). Best-effort.
    pub title: String,
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
                    return Target { id, title };
                }
            }
        }
    }
    // Windows/macOS target capture is a follow-up (needs windows / core-graphics
    // crates + a build on those platforms). The hotkey flow doesn't steal focus,
    // so paste lands correctly there without it.
    Target::default()
}

fn focus(target: &Target) {
    if target.id.is_empty() {
        return;
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdotool")
            .args(["windowactivate", "--sync", &target.id])
            .status();
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
}

/// Deliver the transcript: always copy to clipboard (so a manual paste still
/// works); when `autopaste` is on, TYPE it in via modifier-free Unicode keystrokes
/// (focusing the captured target first when `target_lock` is on). TJ 2026-05-28:
/// real typing, not Ctrl+V — robust across apps that swallow paste + on Win-ARM.
pub fn deliver(text: &str, cfg: &Config, target: Option<&Target>) -> anyhow::Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    set_clipboard(text)?;
    if cfg.autopaste {
        if cfg.target_lock {
            if let Some(t) = target {
                focus(t);
            }
        }
        type_text(text)?;
    }
    Ok(())
}

pub fn set_clipboard(text: &str) -> anyhow::Result<()> {
    let mut cb = arboard::Clipboard::new().map_err(|e| anyhow::anyhow!("clipboard: {e}"))?;
    cb.set_text(text.to_string())
        .map_err(|e| anyhow::anyhow!("clipboard set: {e}"))?;
    Ok(())
}

#[allow(dead_code)] // kept for a possible paste-mode option; deliver() now types
fn paste() -> anyhow::Result<()> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};

    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|e| anyhow::anyhow!("enigo init: {e}"))?;

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
    Ok(())
}

/// Focus the captured target (when target_lock is on) and type a live-dictation
/// segment with modifier-free Unicode typing — appends without touching the
/// clipboard, so it can fire repeatedly while the user keeps speaking.
pub fn type_live(text: &str, cfg: &Config, target: Option<&Target>) -> anyhow::Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    if cfg.target_lock {
        if let Some(t) = target {
            focus(t);
        }
    }
    type_text(text)
}

/// Modifier-free Unicode typing (streaming + Win-ARM-safe path).
pub fn type_text(text: &str) -> anyhow::Result<()> {
    use enigo::{Enigo, Keyboard, Settings};
    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|e| anyhow::anyhow!("enigo init: {e}"))?;
    enigo
        .text(text)
        .map_err(|e| anyhow::anyhow!("type: {e}"))?;
    Ok(())
}
