//! Global hotkey (push-to-talk + toggle) via tauri-plugin-global-shortcut.
//!
//! The plugin's handler delivers Pressed/Released — hold mode records while held;
//! toggle mode flips on each press. Combo is parsed from `config.hotkey`
//! (`<ctrl>+<space>` style).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

use crate::commands::AppState;

// Debounce toggle presses — the OS can emit repeated Pressed (key auto-repeat),
// which would otherwise start+immediately-stop a recording.
static LAST_TOGGLE_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn register_from_config(app: &AppHandle) -> anyhow::Result<()> {
    let combo = app.state::<AppState>().config.lock().hotkey.clone();
    let _ = app.global_shortcut().unregister_all();
    match parse_shortcut(&combo) {
        Some(sc) => app
            .global_shortcut()
            .register(sc)
            .map_err(|e| anyhow::anyhow!("register {combo}: {e}")),
        None => anyhow::bail!("could not parse hotkey: {combo}"),
    }
}

pub fn reregister_from_config(app: &AppHandle) {
    if let Err(e) = register_from_config(app) {
        log::warn!("hotkey reregister failed: {e}");
    }
}

pub fn on_event(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    let state = app.state::<AppState>();
    let toggle = state.config.lock().recording_mode == "toggle";
    match event.state() {
        ShortcutState::Pressed => {
            if toggle {
                let now = now_ms();
                if now.saturating_sub(LAST_TOGGLE_MS.load(Ordering::Relaxed)) < 250 {
                    return; // debounce auto-repeat
                }
                LAST_TOGGLE_MS.store(now, Ordering::Relaxed);
                if state.recorder.is_recording() {
                    spawn_transcribe(app);
                } else {
                    crate::commands::do_start(app);
                }
            } else {
                // hold: record while held (recorder.start is idempotent if already active)
                crate::commands::do_start(app);
            }
        }
        ShortcutState::Released => {
            if !toggle {
                spawn_transcribe(app);
            }
        }
    }
}

/// Transcription blocks on the network, so run it off the hotkey thread.
fn spawn_transcribe(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = crate::commands::do_transcribe(&app);
    });
}

/// Parse a `<ctrl>+<shift>+<space>`-style combo into a Shortcut.
fn parse_shortcut(combo: &str) -> Option<Shortcut> {
    let mut mods = Modifiers::empty();
    let mut code: Option<Code> = None;
    for raw in combo.split('+') {
        let t = raw
            .trim()
            .trim_start_matches('<')
            .trim_end_matches('>')
            .trim()
            .to_lowercase();
        if t.is_empty() {
            continue;
        }
        match t.as_str() {
            "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" => mods |= Modifiers::CONTROL,
            "shift" => mods |= Modifiers::SHIFT,
            "alt" | "option" => mods |= Modifiers::ALT,
            "cmd" | "command" | "meta" => mods |= Modifiers::META,
            "super" | "win" | "windows" => mods |= Modifiers::SUPER,
            other => {
                code = code_from(other);
                code?; // bail on unknown key token
            }
        }
    }
    code.map(|c| Shortcut::new(Some(mods), c))
}

fn code_from(tok: &str) -> Option<Code> {
    Some(match tok {
        "space" => Code::Space,
        "enter" | "return" => Code::Enter,
        "esc" | "escape" => Code::Escape,
        "tab" => Code::Tab,
        "backspace" => Code::Backspace,
        "delete" | "del" => Code::Delete,
        "up" => Code::ArrowUp,
        "down" => Code::ArrowDown,
        "left" => Code::ArrowLeft,
        "right" => Code::ArrowRight,
        "a" => Code::KeyA,
        "b" => Code::KeyB,
        "c" => Code::KeyC,
        "d" => Code::KeyD,
        "e" => Code::KeyE,
        "f" => Code::KeyF,
        "g" => Code::KeyG,
        "h" => Code::KeyH,
        "i" => Code::KeyI,
        "j" => Code::KeyJ,
        "k" => Code::KeyK,
        "l" => Code::KeyL,
        "m" => Code::KeyM,
        "n" => Code::KeyN,
        "o" => Code::KeyO,
        "p" => Code::KeyP,
        "q" => Code::KeyQ,
        "r" => Code::KeyR,
        "s" => Code::KeyS,
        "t" => Code::KeyT,
        "u" => Code::KeyU,
        "v" => Code::KeyV,
        "w" => Code::KeyW,
        "x" => Code::KeyX,
        "y" => Code::KeyY,
        "z" => Code::KeyZ,
        "0" => Code::Digit0,
        "1" => Code::Digit1,
        "2" => Code::Digit2,
        "3" => Code::Digit3,
        "4" => Code::Digit4,
        "5" => Code::Digit5,
        "6" => Code::Digit6,
        "7" => Code::Digit7,
        "8" => Code::Digit8,
        "9" => Code::Digit9,
        "f1" => Code::F1,
        "f2" => Code::F2,
        "f3" => Code::F3,
        "f4" => Code::F4,
        "f5" => Code::F5,
        "f6" => Code::F6,
        "f7" => Code::F7,
        "f8" => Code::F8,
        "f9" => Code::F9,
        "f10" => Code::F10,
        "f11" => Code::F11,
        "f12" => Code::F12,
        _ => return None,
    })
}
