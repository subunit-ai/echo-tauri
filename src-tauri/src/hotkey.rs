//! Global hotkey (push-to-talk + toggle) via tauri-plugin-global-shortcut.
//!
//! The plugin's handler delivers Pressed/Released — hold mode records while held;
//! toggle mode flips on each press. Combo is parsed from `config.hotkey`
//! (`<ctrl>+<space>` style).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

use crate::commands::AppState;

// Debounce toggle presses — the OS can emit repeated Pressed (key auto-repeat),
// which would otherwise start+immediately-stop a recording.
static LAST_TOGGLE_MS: AtomicU64 = AtomicU64::new(0);
// Same debounce for the Prompt-Console hotkey (auto-repeat would open+close it).
static LAST_PROMPT_MS: AtomicU64 = AtomicU64::new(0);

// True while the first-run intro owns the keyboard: the OS registration would
// swallow the combo (DOM key events never see a registered global shortcut), so
// the intro's virtual keyboard / hold-to-dictate finale could never light it up —
// and a press would run the full pipeline incl. injection into the focused Echo
// window. register_from_config honours the flag, so a set_config-triggered
// re-register (hotkey scene patches config.hotkey) keeps the combo free.
// In-memory only: if the app dies mid-intro, the next launch registers normally.
static SUSPENDED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn hotkey_set_suspended(app: AppHandle, suspended: bool) {
    SUSPENDED.store(suspended, Ordering::SeqCst);
    log::info!("hotkey suspended={suspended}");
    if suspended {
        let _ = app.global_shortcut().unregister_all();
        crate::hold_key::stop();
    } else {
        reregister_from_config(&app);
    }
}

/// Is the OS Input-Monitoring grant (needed for single-key/-modifier hold
/// hotkeys) in place? The Settings picker uses this to show a "grant access"
/// hint when the user chooses a lone key that couldn't be armed.
#[tauri::command]
pub fn hotkey_hold_permission() -> bool {
    crate::hold_key::has_permission()
}

/// Prompt for Input Monitoring, then re-register so a pending single-key hotkey
/// arms as soon as the grant lands. Returns whether it's already granted.
#[tauri::command]
pub fn hotkey_request_hold_permission(app: AppHandle) -> bool {
    let granted = crate::hold_key::request_permission();
    reregister_from_config(&app);
    granted
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn register_from_config(app: &AppHandle) -> anyhow::Result<()> {
    let (combo, prompt_combo, hold_ms) = {
        let state = app.state::<AppState>();
        let c = state.config.lock();
        (
            c.hotkey.clone(),
            c.prompt_console_hotkey.clone(),
            c.hotkey_hold_ms,
        )
    };
    let _ = app.global_shortcut().unregister_all();
    crate::hold_key::stop();
    if SUSPENDED.load(Ordering::SeqCst) {
        return Ok(()); // intro owns the keyboard — stay unregistered
    }

    // Each hotkey is either a multi-key COMBO (OS plugin) or a single
    // key/modifier (listen-only event tap — the only way a lone Control/Option
    // works and keeps working normally). Route record + prompt independently.
    use crate::hold_key::{HoldAction, HoldTarget};
    let record_target = crate::hold_key::parse_target(&combo);
    let prompt_trimmed = prompt_combo.trim();
    let prompt_target = if prompt_trimmed.is_empty() {
        None
    } else {
        crate::hold_key::parse_target(&prompt_combo)
    };

    // Event-tap bindings for whichever hotkeys are single tokens.
    let mut bindings: Vec<(HoldTarget, HoldAction)> = Vec::new();
    if let Some(t) = record_target {
        bindings.push((t, HoldAction::Dictate));
    }
    if let Some(t) = prompt_target {
        if Some(t) == record_target {
            log::warn!("prompt-console hotkey equals record hotkey — skipping it");
        } else {
            bindings.push((t, HoldAction::Toggle));
        }
    }

    // Plugin-register the prompt hotkey when it's a COMBO (best-effort: a bad
    // prompt combo must never take the record hotkey down; skip if it dups record).
    if prompt_target.is_none() && !prompt_trimmed.is_empty() {
        match parse_shortcut(&prompt_combo) {
            Some(sc) if parse_shortcut(&combo) == Some(sc) => {
                log::warn!("prompt-console hotkey equals record hotkey — skipping it");
            }
            Some(sc) => {
                if let Err(e) = app.global_shortcut().register(sc) {
                    log::warn!("prompt-console hotkey register {prompt_combo}: {e}");
                }
            }
            None => log::warn!("could not parse prompt-console hotkey: {prompt_combo}"),
        }
    }

    // Arm the event tap for the single-token bindings (if any).
    if !bindings.is_empty() {
        match crate::hold_key::start(app, bindings, hold_ms) {
            Ok(()) if record_target.is_some() => return Ok(()), // record handled by tap
            Ok(()) => {} // only the prompt hotkey used the tap; record combo below
            Err(e) => {
                // Almost always: Input Monitoring not granted yet. Tell the UI so
                // it can prompt; the hotkey arms itself the moment access lands.
                log::warn!("hold hotkey(s) not armed: {e}");
                let _ = app.emit("hold-hotkey-needs-permission", combo.clone());
                if record_target.is_some() {
                    anyhow::bail!("hold hotkey needs Input Monitoring: {e}");
                }
                // record is a plugin combo → keep going and register it below.
            }
        }
    }

    // Record hotkey via the OS plugin (reached only when it's a combo).
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

pub fn on_event(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    let state = app.state::<AppState>();
    let (toggle, record_combo, prompt_combo) = {
        let c = state.config.lock();
        (
            c.recording_mode == "toggle",
            c.hotkey.clone(),
            c.prompt_console_hotkey.clone(),
        )
    };

    // Both global shortcuts arrive through this one handler — dispatch by combo.
    // The record hotkey wins on a duplicate config (mirrors register_from_config).
    if !prompt_combo.trim().is_empty() {
        let prompt_sc = parse_shortcut(&prompt_combo);
        if prompt_sc.is_some() && prompt_sc == Some(*shortcut) && parse_shortcut(&record_combo) != prompt_sc {
            if matches!(event.state(), ShortcutState::Pressed) {
                let now = now_ms();
                if now.saturating_sub(LAST_PROMPT_MS.load(Ordering::Relaxed)) < 300 {
                    return; // debounce auto-repeat
                }
                LAST_PROMPT_MS.store(now, Ordering::Relaxed);
                crate::prompt_console::toggle(app);
            }
            return;
        }
    }
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
