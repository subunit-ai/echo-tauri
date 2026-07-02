//! Paste-back / target injection (port of the heart of `target_lock.py`).
//!
//! Capture the focused window at record-start, then focus it again right before
//! pasting — so dictation lands in the user's app even if focus moved (e.g. the
//! in-app record button). For the global-hotkey flow the target already has
//! focus, so this is belt-and-suspenders there.
//!
//! Delivery: one full transcript at the end, delivered by `deliver()` either as an
//! **instant paste** (clipboard + Ctrl/Cmd+V, the default) or — when
//! `instant_live_typing` is on — **live-typed** in via Unicode keystrokes.
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

    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    /// `kVK_ANSI_V` — the 'v' key's virtual keycode on macOS (Carbon HIToolbox).
    const KVK_ANSI_V: u16 = 9;

    /// Synthesize a real ⌘V via CGEvent: ONE keyDown for 'v' that already carries the
    /// Command flag, then a keyUp. This is the macOS analogue of the native Windows paste
    /// chord. enigo's chord instead posts a separate `Meta` press and then the 'v' as a
    /// *Unicode* event — on macOS that 'v' often lands as the literal character (no Command
    /// flag on it) and/or races the modifier, which is the intermittent bare-"v" paste bug.
    /// Carrying the flag on the same event removes both failure modes. Main thread only
    /// (called from `macos_inject`).
    pub fn cmd_v() -> anyhow::Result<()> {
        let src = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
            .map_err(|_| anyhow::anyhow!("CGEventSource::new failed"))?;
        let down = CGEvent::new_keyboard_event(src.clone(), KVK_ANSI_V, true)
            .map_err(|_| anyhow::anyhow!("keyDown event creation failed"))?;
        down.set_flags(CGEventFlags::CGEventFlagCommand);
        down.post(CGEventTapLocation::HID);
        let up = CGEvent::new_keyboard_event(src, KVK_ANSI_V, false)
            .map_err(|_| anyhow::anyhow!("keyUp event creation failed"))?;
        up.set_flags(CGEventFlags::CGEventFlagCommand);
        up.post(CGEventTapLocation::HID);
        Ok(())
    }

    /// Type arbitrary Unicode text via CGEvent — the LIVE-typing path — with the
    /// event flags EXPLICITLY zeroed so a *physically-held* hotkey modifier can't
    /// ride the synthetic keystrokes.
    ///
    /// Why not `enigo.text()`? enigo builds its `CGEventSource` with
    /// `CombinedSessionState`, which folds the live hardware modifier state into
    /// every event it posts, and it never clears the flags. In hold-to-talk
    /// (`<ctrl>+<space>`) the user keeps Ctrl physically down for the whole take,
    /// so every live-typed character inherited the Control flag → became a Ctrl
    /// chord the focused app dropped (the "live typing types nothing" bug — fires,
    /// `enigo.text()` returns Ok, yet no text lands). A synthetic key-up can't lift
    /// a physically-held key, so releasing modifiers first never fixed it.
    /// Calling `set_flags(empty())` on each event AFTER creation overwrites the
    /// inherited bits, so the character arrives as plain text even while Ctrl is
    /// held — the exact mirror of how `cmd_v` ADDS the Command flag it needs.
    ///
    /// `CGEventKeyboardSetUnicodeString` truncates past ~20 UTF-16 units, so we
    /// chunk (same reasoning as enigo's `fast_text`). One keyDown event per chunk
    /// carries the string — no key-up is needed for string injection. Main thread
    /// only (called from `macos_inject`).
    pub fn type_unicode(text: &str) -> anyhow::Result<()> {
        let src = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
            .map_err(|_| anyhow::anyhow!("CGEventSource::new failed"))?;
        let chars: Vec<char> = text.chars().collect();
        for chunk in chars.chunks(20) {
            let s: String = chunk.iter().collect();
            let event = CGEvent::new_keyboard_event(src.clone(), 0, true)
                .map_err(|_| anyhow::anyhow!("keyboard event creation failed"))?;
            event.set_string(&s);
            // CRITICAL: strip the inherited (physically-held) modifier flags so a
            // still-held <ctrl> can't turn this into a Control chord and vanish.
            event.set_flags(CGEventFlags::empty());
            event.post(CGEventTapLocation::HID);
        }
        Ok(())
    }

    /// `kVK_Delete` — the Backspace key's virtual keycode on macOS.
    const KVK_DELETE: u16 = 51;

    /// Send `count` Backspaces via CGEvent with the flags zeroed — used by the
    /// live-typing finish-reconcile. Flag-zeroing matters here too: if a held
    /// `<ctrl>` rode the event it would become Ctrl+Backspace = DELETE WHOLE WORD,
    /// turning a few char-deletes into a wild multi-word purge. Main thread only.
    pub fn backspaces(count: usize) -> anyhow::Result<()> {
        let src = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
            .map_err(|_| anyhow::anyhow!("CGEventSource::new failed"))?;
        for _ in 0..count {
            let down = CGEvent::new_keyboard_event(src.clone(), KVK_DELETE, true)
                .map_err(|_| anyhow::anyhow!("backspace keyDown failed"))?;
            down.set_flags(CGEventFlags::empty());
            down.post(CGEventTapLocation::HID);
            let up = CGEvent::new_keyboard_event(src.clone(), KVK_DELETE, false)
                .map_err(|_| anyhow::anyhow!("backspace keyUp failed"))?;
            up.set_flags(CGEventFlags::empty());
            up.post(CGEventTapLocation::HID);
        }
        Ok(())
    }
}

/// A captured target window. Platform-encoded in `id` (empty = none) so the
/// struct stays `Send` for the shared state without per-OS enum variants.
#[derive(Clone, Debug, Default)]
pub struct Target {
    pub id: String,
    /// Window title (for Auto-Mode style selection). Best-effort.
    pub title: String,
    /// Owning application name (for Auto-Mode). Best-effort; more stable than
    /// the title — on macOS the title needs the Screen-Recording permission,
    /// the app name doesn't.
    pub app: String,
    /// Active browser tab URL (for Auto-Mode domain matching). Only populated
    /// on macOS when the focused app is a scriptable browser (Safari /
    /// Chromium family) — there the window title is unreadable without the
    /// Screen-Recording permission, so the URL is the precise signal that lets
    /// Auto-Mode tell Gmail from ChatGPT from Google Docs inside a browser.
    /// Empty elsewhere (Win/Linux already get the tab name in the title).
    pub url: String,
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

/// Windows: the executable basename (lowercased, without ".exe") of the process
/// that owns `hwnd` — the robust Auto-Mode app signal (`CURATED_APPS`). Best-effort:
/// returns "" if the process can't be opened/queried (the title still drives the
/// fallback). Uses `PROCESS_QUERY_LIMITED_INFORMATION`, which a normal-integrity
/// app can open against most foreground processes.
#[cfg(target_os = "windows")]
unsafe fn win_process_name(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
    if pid == 0 {
        return String::new();
    }
    let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
        return String::new();
    };
    let mut buf = [0u16; 260];
    let mut size = buf.len() as u32;
    let res =
        QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
    let _ = CloseHandle(handle);
    if res.is_err() || size == 0 {
        return String::new();
    }
    // Lowercase the whole path first, then take the basename and drop ".exe":
    // "C:\\Users\\x\\AppData\\…\\Code.exe" → "code".
    let full = String::from_utf16_lossy(&buf[..size as usize]).to_lowercase();
    let base = full.rsplit(['\\', '/']).next().unwrap_or(&full);
    base.strip_suffix(".exe").unwrap_or(base).to_string()
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
                    let run = |args: &[&str]| {
                        std::process::Command::new("xdotool")
                            .args(args)
                            .output()
                            .ok()
                            .filter(|o| o.status.success())
                            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                            .unwrap_or_default()
                    };
                    let title = run(&["getwindowname", &id]);
                    // WM_CLASS class name ≈ application ("Slack", "code", …).
                    let app = run(&["getwindowclassname", &id]);
                    log::debug!(
                        "capture: linux target id={id} app=\"{app}\" title=\"{}\"",
                        short_title(&title)
                    );
                    // Linux/X11 surfaces the tab name in the window title already.
                    return Target { id, title, app, url: String::new() };
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
                // App name = the foreground process's executable basename (e.g.
                // "code", "cursor", "windowsterminal", "powershell") — the ROBUST
                // Auto-Mode signal that macOS/Linux already have. Without it Windows
                // fell back to title-only matching, so the curated app rules
                // (terminals, editors, AI apps) never fired there. Browsers report
                // their own exe ("chrome"/"msedge"/…) which matches no app rule, so
                // the in-tab site keeps deciding via the window title.
                let app = win_process_name(hwnd);
                let id = (hwnd.0 as isize).to_string();
                log::debug!(
                    "capture: win target hwnd={id} app=\"{app}\" title=\"{}\"",
                    short_title(&title)
                );
                // Encode the HWND pointer as a decimal string so Target stays Send.
                // Windows surfaces the tab name in the window title already.
                return Target { id, title, app, url: String::new() };
            }
        }
        log::debug!("capture: no foreground window (win)");
    }
    #[cfg(target_os = "macos")]
    {
        // Frontmost app + window via the CGWindowList — no focus stealing, no
        // permission prompt. `kCGWindowOwnerName` (the app) is always readable;
        // `kCGWindowName` (the title) only with the Screen-Recording permission,
        // so Auto-Mode matching leans on the app name here. `id` stays empty:
        // the hotkey flow never steals focus on macOS, so there is nothing to
        // re-focus on paste.
        let (app, title) = macos_front_window();
        if !app.is_empty() || !title.is_empty() {
            // Browsers report their own app name ("Safari" / "Google Chrome" /
            // "Arc" …) which matches no curated app rule, and the title is
            // unreadable without Screen-Recording — so without the URL every
            // in-browser dictation (Gmail, ChatGPT, Docs, Slack-web) fell to
            // the default style. Probe the active tab URL via AppleScript so
            // Auto-Mode can match on the domain. Off the hot paste path (runs
            // at record-start) and hard-bounded to 1 s so a wedged browser
            // can't stall recording.
            let url = macos_browser_url(&app);
            log::debug!(
                "capture: macos target app=\"{app}\" title=\"{}\" url=\"{}\"",
                short_title(&title),
                short_title(&url)
            );
            return Target { id: String::new(), title, app, url };
        }
        log::debug!("capture: no front window (macos)");
    }
    Target::default()
}

/// macOS: (app name, window title) of the frontmost normal window — the first
/// layer-0 entry in the front-to-back CGWindowList, skipping Echo's own
/// always-on-top windows by owner name (orb overlay / prompt console are on
/// higher layers anyway; the main window is layer 0, hence the name check).
#[cfg(target_os = "macos")]
fn macos_front_window() -> (String, String) {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly,
    };

    let Some(list) = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    ) else {
        return (String::new(), String::new());
    };
    for i in 0..list.len() {
        let Some(item) = list.get(i) else { continue };
        let dict: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(*item as *const _) };
        let str_of = |key: &'static str| -> String {
            dict.find(CFString::from_static_string(key))
                .and_then(|v| v.downcast::<CFString>())
                .map(|s| s.to_string())
                .unwrap_or_default()
        };
        let layer = dict
            .find(CFString::from_static_string("kCGWindowLayer"))
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_i64())
            .unwrap_or(-1);
        if layer != 0 {
            continue; // menu bar, dock, overlays — not a normal app window
        }
        let app = str_of("kCGWindowOwnerName");
        if app == "Echo" {
            continue; // never target ourselves (main window is layer 0)
        }
        return (app, str_of("kCGWindowName"));
    }
    (String::new(), String::new())
}

/// macOS: the active tab URL of a scriptable browser via AppleScript — or ""
/// if `app` is not a known browser, is not scriptable, or the probe times out.
/// Chromium-family browsers share the "active tab of front window" dictionary;
/// Safari uses "front document". The script is wrapped in `with timeout of 1
/// second` so a busy/unresponsive browser can't stall the (synchronous)
/// record-start path, and ANY error (no window open, not scriptable, Automation
/// permission denied) just yields "". First use triggers the one-time TCC
/// Automation prompt for that browser; until granted this returns "" and
/// Auto-Mode falls back to the app/title rules — never blocks.
#[cfg(target_os = "macos")]
fn macos_browser_url(app: &str) -> String {
    let a = app.to_lowercase();
    // `app` is used verbatim as the `tell application` target so per-channel
    // names ("Google Chrome Canary", "Brave Browser", "Microsoft Edge") work.
    let getter = if a.contains("safari") {
        "get URL of front document"
    } else if a.contains("chrome")
        || a.contains("chromium")
        || a.contains("arc")
        || a.contains("edge")
        || a.contains("brave")
        || a.contains("vivaldi")
        || a.contains("opera")
        || a.contains("dia")
    {
        "get URL of active tab of front window"
    } else {
        return String::new(); // Firefox & co. expose no URL AppleEvent
    };
    // Harden against AppleScript injection: `app` is the frontmost window's
    // owner name (kCGWindowOwnerName), which a locally-running app fully
    // controls and may contain arbitrary bytes. It is interpolated verbatim as
    // the `tell application "…"` target below, so a name carrying a quote or
    // newline could break out of the string literal and inject statements
    // (e.g. `do shell script`). Real browser owner names are plain text
    // ("Google Chrome Canary", "Brave Browser", …), so we bail on any
    // AppleScript-significant char rather than trying to escape it.
    if app.chars().any(|c| c == '"' || c == '\\' || c.is_control()) {
        return String::new();
    }
    // `with timeout` bounds the AppleEvent itself — a busy app errors out
    // instead of blocking. The browser is already frontmost (running), so the
    // `tell` never launches anything. We read stdout only on a clean exit.
    let script =
        format!("with timeout of 1 second\ntell application \"{app}\" to {getter}\nend timeout");
    match std::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
    {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
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
            // Flag-zeroed CGEvent typing (see mac::type_unicode) — immune to a
            // physically-held hotkey modifier, unlike enigo.text() which inherits it.
            if let Err(e) = mac::type_unicode(&text) {
                if allow_paste_fallback {
                    log::warn!("macos inject: typing failed ({e}) — Cmd+V fallback");
                    paste_cmd_v(&mut enigo);
                } else {
                    log::warn!("macos inject: typing failed ({e})");
                }
            }
        } else {
            paste_cmd_v(&mut enigo);
        }
        log::info!("macos inject: done on main thread");
    }) {
        log::error!("macos inject: run_on_main_thread failed: {e}");
    }
}

/// Paste via the native CGEvent ⌘V (reliable — carries the Command flag on the 'v' event),
/// falling back to enigo's chord only if the native path errors. Main thread only.
#[cfg(target_os = "macos")]
fn paste_cmd_v(enigo: &mut enigo::Enigo) {
    if let Err(e) = mac::cmd_v() {
        log::warn!("macos inject: native Cmd+V failed ({e}) — enigo chord fallback");
        if let Err(e2) = mac_cmd_v(enigo) {
            log::warn!("macos inject: enigo Cmd+V fallback also failed ({e2})");
        }
    }
}

/// macOS Cmd+V chord via enigo — last-resort fallback for [`paste_cmd_v`]. MUST be called on
/// the main thread (see `macos_inject`).
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

/// Paste text that's already on the clipboard into whatever window has focus —
/// the Prompt Console's "Einfügen" (no target capture, no live typing; the
/// console hides itself first so the underlying app is frontmost again).
pub fn paste_clipboard_into_focused(text: &str) {
    #[cfg(target_os = "macos")]
    {
        // Same main-thread marshalling + Accessibility gate as the normal flow.
        macos_inject(text.to_string(), false, false, None, true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        if let Err(e) = paste() {
            log::warn!("prompt insert: paste failed ({e}) — clipboard only");
        }
    }
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

/// Modifier-free Unicode typing (the instant "live-type" option).
///
/// Windows uses a native `SendInput` batch of `KEYEVENTF_UNICODE` events — the
/// SAME reasoning that drove the native paste chord: enigo's `text()` rides
/// `SendInput` too, but it proved flaky for *typing* on some Windows machines
/// (Erik's ARM tablet was clean, but x86_64 boxes hit "types nothing"), so we
/// emit the codepoints ourselves exactly as a keyboard/IME would. Other
/// platforms keep enigo's `text()` (unchanged — don't rewrite what works).
/// Modifiers are cleared first so a still-held hotkey modifier can't corrupt it.
#[cfg_attr(target_os = "macos", allow(dead_code))] // macOS lives/delivers via macos_inject + mac::type_unicode
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

/// Live-streaming dictation: type a text DELTA at the caret (append). Clears any
/// held hotkey modifier first. macOS marshals onto the main thread (synthetic
/// input isn't thread-safe there). Best-effort — a missed delta is fixed by the
/// finish-time reconciliation. NO clipboard fallback: a delta must never paste
/// the whole clipboard on top of the live text.
pub fn inject_text_delta(text: &str) {
    if text.is_empty() {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        macos_type_live(text.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Err(e) = type_text(text) {
            log::debug!("inject_text_delta: type failed: {e}");
        }
    }
}

/// macOS-only LEAN live-typing path: marshal to the main thread (synthetic input
/// isn't thread-safe there) and type via `mac::type_unicode`. Deliberately omits
/// the modifier-release + 20 ms settle + `Enigo::new` that `macos_inject` does:
/// `type_unicode` zeroes the event flags per character, so a held modifier is
/// already neutralised — and on the LIVE hot path (one call per stable word) those
/// extras serialised on the main thread and made the typed text lag visibly behind
/// the on-screen caption. AX is checked without a prompt (already primed at start).
#[cfg(target_os = "macos")]
fn macos_type_live(text: String) {
    let Some(app) = APP_HANDLE.get() else {
        log::error!("live type: app handle not set — cannot reach main thread");
        return;
    };
    let n = text.chars().count();
    let dispatched = Instant::now();
    // Diagnostic (ECHO_LIVE_DEBUG): split the local typing latency into the
    // main-thread QUEUE wait (time the keystroke sat behind caption/orb rendering)
    // vs the actual TYPE time. A large queue → typing trails the caption because it
    // competes with the UI on the main thread (→ candidate to move off-thread).
    let measure = std::env::var_os("ECHO_LIVE_DEBUG").is_some();
    if let Err(e) = app.run_on_main_thread(move || {
        let queue_ms = dispatched.elapsed().as_millis();
        if !mac::is_trusted(false) {
            return; // no AX permission → silent (clipboard/manual paste still works)
        }
        let t = Instant::now();
        if let Err(e) = mac::type_unicode(&text) {
            log::debug!("live type: {e}");
        }
        if measure {
            log::info!("live inject: queue={queue_ms}ms type={}ms chars={n}", t.elapsed().as_millis());
        }
    }) {
        log::debug!("live type: run_on_main_thread failed: {e}");
    }
}

/// Live-streaming reconciliation: delete `count` characters at the caret via
/// backspaces — used when the streamed final revises text we already live-typed.
/// Rare (LocalAgreement only commits stable text). macOS marshals to the main thread.
pub fn inject_backspaces(count: usize) {
    if count == 0 {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        macos_backspaces(count);
    }
    #[cfg(not(target_os = "macos"))]
    {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        clear_modifiers();
        std::thread::sleep(std::time::Duration::from_millis(10));
        if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
            for _ in 0..count {
                let _ = enigo.key(Key::Backspace, Direction::Click);
            }
        }
    }
}

/// macOS-only: send `count` backspaces on the main thread (synthetic input is
/// not thread-safe off it). Gated on Accessibility; clears modifiers first.
#[cfg(target_os = "macos")]
fn macos_backspaces(count: usize) {
    let Some(app) = APP_HANDLE.get() else {
        log::error!("macos backspaces: app handle not set");
        return;
    };
    if let Err(e) = app.run_on_main_thread(move || {
        if !mac::is_trusted(false) {
            return;
        }
        // Flag-zeroed Backspace events (mac::backspaces): immune to a held <ctrl>,
        // which would otherwise make each one a Ctrl+Backspace word-delete.
        if let Err(e) = mac::backspaces(count) {
            log::debug!("macos backspaces: {e}");
        }
    }) {
        log::debug!("macos backspaces: run_on_main_thread failed: {e}");
    }
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

#[cfg(all(test, target_os = "macos"))]
mod tests_macos {
    /// Live smoke against the real CGWindowList — asserts nothing about content
    /// (depends on the desktop), only that the call works and returns cleanly.
    /// Run locally with `cargo test front_window -- --nocapture` to see the
    /// captured frontmost app/title.
    #[test]
    fn front_window_smoke() {
        let (app, title) = super::macos_front_window();
        println!("MACOS_CAPTURE app=\"{app}\" title=\"{title}\"");
    }
}
