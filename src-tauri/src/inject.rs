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
//!    the default) or — when `instant_live_typing` is on — **live-typed** in via
//!    Unicode keystrokes. Independent of the streaming toggle.
//!
//! ## Windows: native SendInput on the paste chord (no enigo there)
//! enigo 0.2's `key(Key::Unicode('v'), Click)` emits the Ctrl+V chord as THREE
//! separate, non-atomic `SendInput` calls (Ctrl as a virtual-key, 'v' as a
//! *scancode*, then Ctrl release). On Win-ARM the gap between those calls raced
//! the target window's async input handling: the `v` arrived before `Ctrl` was
//! registered (→ a bare **"v"**) or the queue got processed twice (→ a **double
//! paste**). Erik hit both. We replace it on Windows with ONE atomic `SendInput`
//! batch of real virtual-keys `[Ctrl↓, V↓, V↑, Ctrl↑]` — exactly what a physical
//! keyboard enqueues, with no inter-call gap to race. Unicode *typing* (the
//! streaming path Erik confirmed clean) still rides enigo's `text()` — we don't
//! rewrite what already works, only the chord that demonstrably didn't.
//!
//! Both injection paths first `clear_modifiers()` — a still-held hotkey modifier
//! (e.g. Ctrl from `<ctrl>+<space>`) corrupts Unicode typing AND a synthetic chord.
//!
//! Every step is logged (see `tauri_plugin_log` wiring in lib.rs) so a field log
//! pulled over the Bridge tells us exactly which path ran and where it failed.
//! We log COUNTS only via `text_stats()` — never the transcript content.

use crate::config::Config;
use std::time::Instant;

#[cfg(target_os = "macos")]
use once_cell::sync::OnceCell;

// macOS: synthetic keyboard input (enigo → CoreGraphics/AppKit) is NOT thread-safe
// and MUST run on the main thread — calling it from a Tauri worker thread (where the
// transcribe command runs) hard-crashes the app (EXC_BAD_ACCESS deep in AppKit). We
// stash the AppHandle so the paste path can marshal itself onto the main run loop via
// `run_on_main_thread`. See `macos_inject`. (No-op storage on other platforms.)
#[cfg(target_os = "macos")]
static APP_HANDLE: OnceCell<tauri::AppHandle> = OnceCell::new();

/// Remember the AppHandle for the macOS main-thread paste marshalling (no-op elsewhere).
pub fn set_app_handle(_app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = APP_HANDLE.set(_app);
    }
}

/// macOS: trigger the Accessibility (System Settings → Privacy → Accessibility) prompt
/// once at startup. Synthetic Cmd+V via CGEventPost is gated by this TCC permission —
/// without it the paste is a SILENT no-op (text lands on the clipboard but never pastes).
/// Unlike the microphone, macOS never auto-prompts for it on first use, so we must ask.
/// No-op + no prompt when already trusted, and a no-op on other platforms.
pub fn prime_accessibility() {
    #[cfg(target_os = "macos")]
    {
        let trusted = mac::is_trusted(true);
        log::info!("macos accessibility: trusted={trusted} (prompted if false)");
    }
}

/// macOS Accessibility (AX) trust check + optional system prompt. The symbols live in
/// the ApplicationServices umbrella framework (HIServices); we bind them directly so we
/// don't depend on a crate exposing them. `kAXTrustedCheckOptionPrompt`=true shows the
/// standard "enable in System Settings" dialog when the process isn't yet trusted.
#[cfg(target_os = "macos")]
mod mac {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    /// Returns true if this process is trusted for Accessibility. When `prompt` is true
    /// and it is NOT trusted, macOS shows the standard prompt (once per app launch).
    pub fn is_trusted(prompt: bool) -> bool {
        unsafe {
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
            let val = if prompt {
                CFBoolean::true_value()
            } else {
                CFBoolean::false_value()
            };
            let opts = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), val.as_CFType())]);
            AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef()) != 0
        }
    }
}

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
#[cfg_attr(target_os = "macos", allow(dead_code))] // macOS capture is a follow-up
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
/// the original Win-ARM "random character spam" cause. Releasing a key that isn't
/// down is a harmless no-op. Native SendInput on Windows; enigo elsewhere.
fn clear_modifiers() {
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = win::clear_modifiers() {
            log::debug!("clear_modifiers (win): {e}");
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        match Enigo::new(&Settings::default()) {
            Ok(mut enigo) => {
                for k in [Key::Control, Key::Shift, Key::Alt, Key::Meta] {
                    if let Err(e) = enigo.key(k, Direction::Release) {
                        log::debug!("clear_modifiers: release {k:?} err: {e}");
                    }
                }
            }
            Err(e) => log::debug!("clear_modifiers: enigo init err: {e}"),
        }
    }
}

/// Deliver the transcript: always copy to clipboard (so a manual paste still works);
/// when `autopaste` is on, inject it — either an instant paste (Ctrl/Cmd+V, the
/// default) or live-typed Unicode (`instant_live_typing`), focusing the captured
/// target first when `target_lock` is on.
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

    // macOS: marshal the whole injection onto the main thread (synthetic input crashes
    // off-thread) and let it gate on Accessibility there. The clipboard is already set,
    // so a denied permission still leaves a working manual paste. Fire-and-forget — the
    // main-thread closure logs its own outcome; we don't block "Done" on it.
    #[cfg(target_os = "macos")]
    {
        macos_inject(text.to_string(), cfg.instant_live_typing, cfg.target_lock, target.cloned(), true);
        log::info!("deliver: macOS inject dispatched to main thread (+{:?})", t0.elapsed());
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        if cfg.target_lock {
            match target {
                Some(t) => focus(t),
                None => log::debug!("deliver: target_lock on but no captured target"),
            }
        }

        if cfg.instant_live_typing {
            // Live-typing can fail on some setups (typed nothing). The text is already
            // on the clipboard, so fall back to the proven instant paste rather than
            // silently dropping it — the user always gets their dictation.
            if let Err(e) = type_text(text) {
                log::warn!("deliver: live-typing failed ({e}) — falling back to instant paste");
                paste()?;
                log::info!("deliver: done via instant-paste (fallback) (+{:?})", t0.elapsed());
                return Ok(());
            }
        } else {
            paste()?;
        }
        log::info!("deliver: done via {method} (+{:?})", t0.elapsed());
        Ok(())
    }
}

/// macOS-only: run the synthetic injection on the main thread (enigo is not thread-safe
/// on macOS — off-thread use is the "crashes after every transcription" bug). Gates on
/// Accessibility first (silent no-op without it → bail to clipboard-only + tell the UI).
/// `prefer_typing` types the text via Unicode keystrokes; otherwise (and as a typing
/// fallback when `allow_paste_fallback`) it sends a Cmd+V chord against the clipboard.
#[cfg(target_os = "macos")]
fn macos_inject(
    text: String,
    prefer_typing: bool,
    target_lock: bool,
    target: Option<Target>,
    allow_paste_fallback: bool,
) {
    use tauri::Emitter;
    let Some(app) = APP_HANDLE.get() else {
        log::error!("macos inject: app handle not set — cannot reach main thread");
        return;
    };
    let app2 = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        // CGEventPost is gated by the Accessibility (AX) TCC permission. Prompt once if
        // missing; without it the paste silently does nothing, so bail to clipboard-only
        // and signal the UI so it can nudge the user to grant it.
        if !mac::is_trusted(true) {
            log::warn!("macos inject: no Accessibility permission — clipboard only (user prompted)");
            let _ = app2.emit("echo://needs-accessibility", ());
            return;
        }
        if target_lock {
            if let Some(t) = &target {
                focus(t);
            }
        }
        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(e) => e,
            Err(e) => {
                log::error!("macos inject: enigo init: {e}");
                return;
            }
        };
        // Release any still-held hotkey modifier so it can't corrupt typing / the chord.
        for k in [Key::Control, Key::Shift, Key::Alt, Key::Meta] {
            let _ = enigo.key(k, Direction::Release);
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        if prefer_typing {
            if let Err(e) = enigo.text(&text) {
                if allow_paste_fallback {
                    log::warn!("macos inject: typing failed ({e}) — Cmd+V fallback");
                    let _ = mac_cmd_v(&mut enigo);
                } else {
                    log::warn!("macos inject: typing failed ({e})");
                }
            }
        } else if let Err(e) = mac_cmd_v(&mut enigo) {
            log::warn!("macos inject: Cmd+V failed ({e})");
        }
        log::info!("macos inject: done on main thread");
    }) {
        log::error!("macos inject: run_on_main_thread failed: {e}");
    }
}

/// macOS Cmd+V chord via enigo. MUST be called on the main thread (see `macos_inject`).
#[cfg(target_os = "macos")]
fn mac_cmd_v(enigo: &mut enigo::Enigo) -> anyhow::Result<()> {
    use enigo::{Direction, Key, Keyboard};
    enigo
        .key(Key::Meta, Direction::Press)
        .map_err(|e| anyhow::anyhow!("cmd press: {e}"))?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| anyhow::anyhow!("v: {e}"))?;
    enigo
        .key(Key::Meta, Direction::Release)
        .map_err(|e| anyhow::anyhow!("cmd release: {e}"))?;
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
/// Windows uses a native single-batch `SendInput` (see [`win::paste`]); other
/// platforms use enigo's chord.
#[cfg_attr(target_os = "macos", allow(dead_code))] // macOS pastes via macos_inject (main thread)
fn paste() -> anyhow::Result<()> {
    let t0 = Instant::now();
    #[cfg(target_os = "windows")]
    {
        win::paste()?;
        log::info!("paste: native chord sent (+{:?})", t0.elapsed());
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        clear_modifiers();
        std::thread::sleep(std::time::Duration::from_millis(20));
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
        log::info!("paste: chord sent (+{:?})", t0.elapsed());
        Ok(())
    }
}

/// Focus the captured target (when target_lock is on) and type a live-dictation
/// segment with modifier-free Unicode typing — appends without touching the
/// clipboard, so it can fire repeatedly while the user keeps speaking.
pub fn type_live(text: &str, cfg: &Config, target: Option<&Target>) -> anyhow::Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    log::debug!("type_live: {} target_lock={}", text_stats(text), cfg.target_lock);
    // macOS: type on the main thread (enigo is not thread-safe here). No Cmd+V fallback —
    // streaming appends without touching the clipboard, so a paste would insert stale text.
    #[cfg(target_os = "macos")]
    {
        macos_inject(text.to_string(), true, cfg.target_lock, target.cloned(), false);
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        if cfg.target_lock {
            if let Some(t) = target {
                focus(t);
            }
        }
        type_text(text)
    }
}

/// Modifier-free Unicode typing (streaming + the instant "live-type" option).
///
/// Windows uses a native `SendInput` batch of `KEYEVENTF_UNICODE` events — the
/// SAME reasoning that drove the native paste chord: enigo's `text()` rides
/// `SendInput` too, but it proved flaky for *typing* on some Windows machines
/// (Erik's ARM tablet was clean, but x86_64 boxes hit "types nothing"), so we
/// emit the codepoints ourselves exactly as a keyboard/IME would. Other
/// platforms keep enigo's `text()` (unchanged — don't rewrite what works).
/// Modifiers are cleared first so a still-held hotkey modifier can't corrupt it.
pub fn type_text(text: &str) -> anyhow::Result<()> {
    let t0 = Instant::now();
    clear_modifiers();
    std::thread::sleep(std::time::Duration::from_millis(20));
    log::debug!("type_text: typing {} via Unicode", text_stats(text));
    #[cfg(target_os = "windows")]
    {
        win::type_unicode(text)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        use enigo::{Enigo, Keyboard, Settings};
        let mut enigo =
            Enigo::new(&Settings::default()).map_err(|e| anyhow::anyhow!("enigo init: {e}"))?;
        enigo
            .text(text)
            .map_err(|e| anyhow::anyhow!("type: {e}"))?;
    }
    log::info!("type_text: done (+{:?})", t0.elapsed());
    Ok(())
}

/// Native Windows synthetic keyboard input — replaces enigo on the paste chord.
/// Each logical action is one `SendInput` call, so the OS enqueues its events
/// atomically and the target window never sees a half-formed chord.
#[cfg(target_os = "windows")]
mod win {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
        VK_V,
    };

    /// Build one keyboard `INPUT` for a virtual-key press (`up=false`) or release.
    fn vk(key: VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// Inject a batch of inputs in a single atomic `SendInput` call.
    fn send(inputs: &[INPUT]) -> anyhow::Result<()> {
        let n = unsafe { SendInput(inputs, core::mem::size_of::<INPUT>() as i32) };
        if n as usize != inputs.len() {
            anyhow::bail!("SendInput injected {n}/{} events", inputs.len());
        }
        Ok(())
    }

    /// Release Ctrl/Shift/Alt/Win in case a hotkey modifier is still held.
    pub fn clear_modifiers() -> anyhow::Result<()> {
        let ups = [
            vk(VK_CONTROL, true),
            vk(VK_SHIFT, true),
            vk(VK_MENU, true),
            vk(VK_LWIN, true),
            vk(VK_RWIN, true),
        ];
        send(&ups)
    }

    /// Atomic Ctrl+V — `[Ctrl↓, V↓, V↑, Ctrl↑]` in one `SendInput` call.
    pub fn paste() -> anyhow::Result<()> {
        clear_modifiers()?;
        std::thread::sleep(std::time::Duration::from_millis(20));
        let chord = [
            vk(VK_CONTROL, false),
            vk(VK_V, false),
            vk(VK_V, true),
            vk(VK_CONTROL, true),
        ];
        send(&chord)
    }

    /// One keyboard `INPUT` carrying a UTF-16 code unit as a Unicode keystroke
    /// (`wVk=0`, `wScan=unit`, `KEYEVENTF_UNICODE`). `up` toggles the key-release.
    fn unicode(unit: u16, up: bool) -> INPUT {
        let mut flags = KEYEVENTF_UNICODE;
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// Type `text` as native Unicode keystrokes. Each UTF-16 code unit becomes a
    /// down+up pair (codepoints above the BMP ride their surrogate pair, which is
    /// exactly how Windows expects them). Sent in chunks so one batch can't
    /// overflow the target window's input queue; `send` verifies the OS accepted
    /// every event so a partial/blocked injection surfaces as an error (→ the
    /// caller falls back to an instant paste).
    pub fn type_unicode(text: &str) -> anyhow::Result<()> {
        let mut inputs: Vec<INPUT> = Vec::with_capacity(text.len() * 2);
        for unit in text.encode_utf16() {
            inputs.push(unicode(unit, false));
            inputs.push(unicode(unit, true));
        }
        if inputs.is_empty() {
            return Ok(());
        }
        // ONE SendInput so typing is all-or-nothing for the caller: a chunked send
        // could land the first N chars then fail, and deliver()'s clipboard paste
        // fallback would duplicate them on top. If the OS accepts only PART of the
        // batch (a mid-injection block — focus change / UIPI), erase whatever landed
        // via backspaces so the fallback paste can't double-insert, then report the
        // failure. KEYEVENTF_UNICODE never latches key state, so nothing stays held.
        let n = unsafe { SendInput(&inputs, core::mem::size_of::<INPUT>() as i32) } as usize;
        if n == inputs.len() {
            return Ok(());
        }
        // n events landed = n/2 code units (each char is a down+up pair). Backspace
        // them so the target returns to its pre-typing state before the caller pastes.
        // (A non-BMP codepoint is two code units → one glyph, so the count can be off
        // by one at a mid-surrogate break; transcripts are effectively all BMP and this
        // is already a rare error path, so best-effort backspacing is fine.)
        let typed_units = n / 2;
        if typed_units > 0 {
            let mut undo: Vec<INPUT> = Vec::with_capacity(typed_units * 2);
            for _ in 0..typed_units {
                undo.push(vk(VK_BACK, false));
                undo.push(vk(VK_BACK, true));
            }
            let _ = unsafe { SendInput(&undo, core::mem::size_of::<INPUT>() as i32) };
        }
        anyhow::bail!("SendInput injected {n}/{} events (partial — erased)", inputs.len());
    }
}
