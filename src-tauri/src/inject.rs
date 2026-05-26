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
                    return Target { id };
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

/// Deliver the transcript: always copy to clipboard; paste if `autopaste`
/// (focusing the captured target first when `target_lock` is on).
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
        paste()?;
    }
    Ok(())
}

pub fn set_clipboard(text: &str) -> anyhow::Result<()> {
    let mut cb = arboard::Clipboard::new().map_err(|e| anyhow::anyhow!("clipboard: {e}"))?;
    cb.set_text(text.to_string())
        .map_err(|e| anyhow::anyhow!("clipboard set: {e}"))?;
    Ok(())
}

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

/// Modifier-free Unicode typing (streaming + Win-ARM-safe path).
#[allow(dead_code)] // wired by streaming dictation (M2)
pub fn type_text(text: &str) -> anyhow::Result<()> {
    use enigo::{Enigo, Keyboard, Settings};
    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|e| anyhow::anyhow!("enigo init: {e}"))?;
    enigo
        .text(text)
        .map_err(|e| anyhow::anyhow!("type: {e}"))?;
    Ok(())
}
