//! Paste-back / target injection (port of the heart of `target_lock.py`).
//!
//! Two paths:
//!  * **paste** — set the clipboard (arboard) + synthesize the platform paste
//!    chord (enigo). Fast, preserves the user's layout.
//!  * **type_text** — modifier-free Unicode typing (enigo `.text`). This is the
//!    robust path on Win-ARM, where synthetic Ctrl+V loses the modifier through
//!    x64 emulation; also used for streaming dictation. enigo's `.text` maps to
//!    `KEYEVENTF_UNICODE` on Windows — exactly the `_win_type_unicode` approach.
//!
//! When triggered by the global hotkey, the user's target app is focused (the
//! Echo window is hidden/unfocused), so the paste lands in the right place.

use crate::config::Config;

/// Deliver the transcript: always copy to clipboard; paste if `autopaste`.
pub fn deliver(text: &str, cfg: &Config) -> anyhow::Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    set_clipboard(text)?;
    if cfg.autopaste {
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
