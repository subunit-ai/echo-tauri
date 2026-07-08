//! Single-key / single-modifier "hold to dictate" via a listen-only CGEventTap
//! (macOS). This is the piece the OS global-shortcut plugin can't do: the plugin
//! only binds a modifier+key COMBO and *swallows* the key while registered — so a
//! lone Control or Option can never be a hotkey, and any single key it did bind
//! would stop typing everywhere. A listen-only tap only OBSERVES events, so the
//! key keeps working normally (Ctrl+C still copies) while we watch it in the
//! background.
//!
//! Semantics: press the configured lone key/modifier and hold it. If it stays
//! down — alone, no other key involved — past `hold_ms`, dictation starts;
//! releasing it stops + transcribes. A short tap does nothing, and pressing
//! another key while it's held (i.e. using it as a modifier in a chord like
//! Ctrl+C) disarms it, so chords never fire dictation.
//!
//! Only single-token hotkeys take this path; multi-key combos (`<ctrl>+<space>`)
//! stay on the OS plugin (see hotkey.rs). Non-macOS builds get no-op stubs and
//! `parse_target` returns None so everything falls back to the plugin.

/// A single-token hotkey resolved to something the key monitor can watch.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HoldTarget {
    /// A bare modifier held solo (Control / Option / Command / Shift / Fn).
    Modifier(ModKind),
    /// A single non-modifier key, by macOS virtual keycode.
    Key(u16),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ModKind {
    Ctrl,
    Alt,
    Cmd,
    Shift,
    Fn,
}

/// Resolve a hotkey string to a hold target IFF it is a single token (one bare
/// modifier, or one supported key). Multi-key combos → None (they use the OS
/// plugin). Shared by hotkey.rs (routing) and the frontend mirrors this in
/// `hotkeys.ts::holdTargetOf`.
pub fn parse_target(combo: &str) -> Option<HoldTarget> {
    let tokens: Vec<String> = combo
        .split('+')
        .map(|raw| {
            raw.trim()
                .trim_start_matches('<')
                .trim_end_matches('>')
                .trim()
                .to_lowercase()
        })
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.len() != 1 {
        return None;
    }
    let t = tokens[0].as_str();
    if let Some(m) = modifier_kind(t) {
        return Some(HoldTarget::Modifier(m));
    }
    key_code(t).map(HoldTarget::Key)
}

fn modifier_kind(t: &str) -> Option<ModKind> {
    Some(match t {
        "ctrl" | "control" => ModKind::Ctrl,
        "alt" | "option" => ModKind::Alt,
        "cmd" | "command" | "meta" | "super" | "win" | "windows" => ModKind::Cmd,
        "shift" => ModKind::Shift,
        "fn" | "function" | "globe" => ModKind::Fn,
        _ => return None,
    })
}

/// macOS virtual keycodes for the same key vocabulary the plugin parser accepts.
fn key_code(t: &str) -> Option<u16> {
    Some(match t {
        "space" => 0x31,
        "enter" | "return" => 0x24,
        "esc" | "escape" => 0x35,
        "tab" => 0x30,
        "backspace" => 0x33,
        "delete" | "del" => 0x75,
        "up" => 0x7E,
        "down" => 0x7D,
        "left" => 0x7B,
        "right" => 0x7C,
        "a" => 0x00,
        "b" => 0x0B,
        "c" => 0x08,
        "d" => 0x02,
        "e" => 0x0E,
        "f" => 0x03,
        "g" => 0x05,
        "h" => 0x04,
        "i" => 0x22,
        "j" => 0x26,
        "k" => 0x28,
        "l" => 0x25,
        "m" => 0x2E,
        "n" => 0x2D,
        "o" => 0x1F,
        "p" => 0x23,
        "q" => 0x0C,
        "r" => 0x0F,
        "s" => 0x01,
        "t" => 0x11,
        "u" => 0x20,
        "v" => 0x09,
        "w" => 0x0D,
        "x" => 0x07,
        "y" => 0x10,
        "z" => 0x06,
        "0" => 0x1D,
        "1" => 0x12,
        "2" => 0x13,
        "3" => 0x14,
        "4" => 0x15,
        "5" => 0x17,
        "6" => 0x16,
        "7" => 0x1A,
        "8" => 0x1C,
        "9" => 0x19,
        "f1" => 0x7A,
        "f2" => 0x78,
        "f3" => 0x63,
        "f4" => 0x76,
        "f5" => 0x60,
        "f6" => 0x61,
        "f7" => 0x62,
        "f8" => 0x64,
        "f9" => 0x65,
        "f10" => 0x6D,
        "f11" => 0x67,
        "f12" => 0x6F,
        "f13" => 0x69,
        "f14" => 0x6B,
        "f15" => 0x71,
        "f16" => 0x6A,
        "f17" => 0x40,
        "f18" => 0x4F,
        "f19" => 0x50,
        _ => return None,
    })
}

#[cfg(target_os = "macos")]
pub use macos::{has_permission, request_permission, start, stop};

#[cfg(not(target_os = "macos"))]
mod stub {
    use super::HoldTarget;
    use tauri::AppHandle;
    /// Non-macOS: the event tap doesn't exist; callers fall back to the plugin.
    pub fn start(_app: &AppHandle, _t: HoldTarget, _hold_ms: u32) -> Result<(), String> {
        Err("hold-key monitor is macOS-only".into())
    }
    pub fn stop() {}
    pub fn has_permission() -> bool {
        false
    }
    pub fn request_permission() -> bool {
        false
    }
}
#[cfg(not(target_os = "macos"))]
pub use stub::{has_permission, request_permission, start, stop};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lone_modifier_takes_the_hold_path() {
        // The whole point: a bare Control/Option — impossible as an OS combo — is
        // now a valid (hold) hotkey.
        assert_eq!(parse_target("<ctrl>"), Some(HoldTarget::Modifier(ModKind::Ctrl)));
        assert_eq!(parse_target("ctrl"), Some(HoldTarget::Modifier(ModKind::Ctrl)));
        assert_eq!(parse_target("<alt>"), Some(HoldTarget::Modifier(ModKind::Alt)));
        assert_eq!(parse_target("option"), Some(HoldTarget::Modifier(ModKind::Alt)));
        assert_eq!(parse_target("<cmd>"), Some(HoldTarget::Modifier(ModKind::Cmd)));
        assert_eq!(parse_target("<shift>"), Some(HoldTarget::Modifier(ModKind::Shift)));
        assert_eq!(parse_target("fn"), Some(HoldTarget::Modifier(ModKind::Fn)));
    }

    #[test]
    fn lone_key_takes_the_hold_path() {
        assert_eq!(parse_target("<f6>"), Some(HoldTarget::Key(0x61)));
        assert_eq!(parse_target("<space>"), Some(HoldTarget::Key(0x31)));
        assert_eq!(parse_target("a"), Some(HoldTarget::Key(0x00)));
        assert_eq!(parse_target("<f13>"), Some(HoldTarget::Key(0x69)));
    }

    #[test]
    fn combos_stay_on_the_os_plugin() {
        assert_eq!(parse_target("<ctrl>+<space>"), None);
        assert_eq!(parse_target("<cmd>+<shift>+p"), None);
        assert_eq!(parse_target(""), None);
        assert_eq!(parse_target("   "), None);
    }

    #[test]
    fn unknown_single_token_is_rejected() {
        assert_eq!(parse_target("<f25>"), None);
        assert_eq!(parse_target("<foobar>"), None);
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{HoldTarget, ModKind};
    use std::os::raw::c_void;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use core_foundation::base::TCFType;
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions,
        CGEventTapPlacement, CGEventTapProxy, CGEventType, EventField,
    };
    use tauri::AppHandle;

    // Input-Monitoring (TCC) gates event taps. These CoreGraphics calls (10.15+)
    // check and request that grant; a listen-only tap simply fails to create
    // without it.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapEnable(tap: *const c_void, enable: bool);
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
    }

    pub fn has_permission() -> bool {
        unsafe { CGPreflightListenEventAccess() }
    }

    /// Prompt for Input Monitoring (shows the system dialog / opens the pane the
    /// first time). Returns whether it's already granted.
    pub fn request_permission() -> bool {
        unsafe { CGRequestListenEventAccess() }
    }

    // Device-independent modifier flag for a target modifier.
    fn flag_of(kind: ModKind) -> CGEventFlags {
        match kind {
            ModKind::Ctrl => CGEventFlags::CGEventFlagControl,
            ModKind::Alt => CGEventFlags::CGEventFlagAlternate,
            ModKind::Cmd => CGEventFlags::CGEventFlagCommand,
            ModKind::Shift => CGEventFlags::CGEventFlagShift,
            ModKind::Fn => CGEventFlags::CGEventFlagSecondaryFn,
        }
    }

    // All the modifier bits we care about, so "held solo" can check for any OTHER
    // modifier sneaking in (which would make it a chord, not a dictation hold).
    fn all_mod_flags() -> CGEventFlags {
        CGEventFlags::CGEventFlagControl
            | CGEventFlags::CGEventFlagAlternate
            | CGEventFlags::CGEventFlagCommand
            | CGEventFlags::CGEventFlagShift
            | CGEventFlags::CGEventFlagSecondaryFn
    }

    struct HoldState {
        app: AppHandle,
        target: HoldTarget,
        hold_ms: u32,
        // Bumped on every arm/disarm so a stale hold-timer knows not to fire.
        arm_gen: AtomicU64,
        armed: AtomicBool,
        dictating: AtomicBool,
        // CFMachPortRef of the tap, for re-enabling after a TapDisabled event.
        tap_port: AtomicUsize,
    }

    impl HoldState {
        /// Start the hold timer: after `hold_ms`, if this arm is still the current
        /// one and nothing disarmed it, dictation begins.
        fn arm(self: &Arc<Self>) {
            if self.dictating.load(Ordering::SeqCst) {
                return;
            }
            let generation = self.arm_gen.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
            self.armed.store(true, Ordering::SeqCst);
            let st = self.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(st.hold_ms as u64));
                if st.arm_gen.load(Ordering::SeqCst) == generation
                    && st.armed.load(Ordering::SeqCst)
                    && !st.dictating.load(Ordering::SeqCst)
                {
                    st.dictating.store(true, Ordering::SeqCst);
                    st.armed.store(false, Ordering::SeqCst);
                    crate::commands::do_start(&st.app);
                }
            });
        }

        /// Cancel a pending arm (short tap released, or a chord started).
        fn disarm(&self) {
            self.armed.store(false, Ordering::SeqCst);
            self.arm_gen.fetch_add(1, Ordering::SeqCst);
        }

        /// The hotkey was released: stop + transcribe if we were dictating.
        fn release(&self) {
            let was_dictating = self.dictating.swap(false, Ordering::SeqCst);
            self.armed.store(false, Ordering::SeqCst);
            self.arm_gen.fetch_add(1, Ordering::SeqCst);
            if was_dictating {
                let app = self.app.clone();
                std::thread::spawn(move || {
                    let _ = crate::commands::do_transcribe(&app);
                });
            }
        }
    }

    // The tap handler. `event_type`/`event` describe one low-level event; we
    // never mutate or drop it (listen-only), just read state and steer the
    // dictation lifecycle.
    fn handle(state: &Arc<HoldState>, event_type: CGEventType, event: &CGEvent) {
        // Re-arm the tap if the OS disabled it (slow handler / user input storm).
        match event_type {
            CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
                let port = state.tap_port.load(Ordering::SeqCst);
                if port != 0 {
                    unsafe { CGEventTapEnable(port as *const c_void, true) };
                }
                return;
            }
            _ => {}
        }

        match state.target {
            HoldTarget::Modifier(kind) => {
                let target_flag = flag_of(kind);
                match event_type {
                    CGEventType::FlagsChanged => {
                        let flags = event.get_flags();
                        let target_down = flags.contains(target_flag);
                        let others_down =
                            !(flags & all_mod_flags() & !target_flag).is_empty();
                        if target_down && !others_down {
                            // Lone target modifier just went down → arm.
                            state.arm();
                        } else if !target_down {
                            // Target released.
                            state.release();
                        } else {
                            // Target down but another modifier joined → chord.
                            state.disarm();
                        }
                    }
                    // A real key pressed while the modifier is held = a chord
                    // (Ctrl+C, ⌥←, …). Never dictation — cancel the pending arm.
                    CGEventType::KeyDown => {
                        if !state.dictating.load(Ordering::SeqCst) {
                            state.disarm();
                        }
                    }
                    _ => {}
                }
            }
            HoldTarget::Key(code) => {
                let keycode =
                    event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u16;
                if keycode != code {
                    return;
                }
                match event_type {
                    CGEventType::KeyDown => {
                        let autorepeat =
                            event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT);
                        if autorepeat == 0 {
                            state.arm();
                        }
                    }
                    CGEventType::KeyUp => state.release(),
                    _ => {}
                }
            }
        }
    }

    // CFRunLoop / the tap live on a dedicated thread; this ferries the loop ref
    // out so `stop()` can CFRunLoopStop it from another thread (which is safe).
    struct RunLoopHandle(CFRunLoop);
    unsafe impl Send for RunLoopHandle {}

    struct Running {
        runloop: RunLoopHandle,
        join: std::thread::JoinHandle<()>,
    }

    static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

    /// (Re)start the key monitor for `target`. Tears down any previous tap first.
    /// Returns Err (and changes nothing that would leave a half-live tap) if the
    /// tap can't be created — almost always missing Input-Monitoring permission.
    pub fn start(app: &AppHandle, target: HoldTarget, hold_ms: u32) -> Result<(), String> {
        stop();

        let state = Arc::new(HoldState {
            app: app.clone(),
            target,
            hold_ms: hold_ms.max(1),
            arm_gen: AtomicU64::new(0),
            armed: AtomicBool::new(false),
            dictating: AtomicBool::new(false),
            tap_port: AtomicUsize::new(0),
        });

        let events = match target {
            HoldTarget::Modifier(_) => {
                vec![CGEventType::FlagsChanged, CGEventType::KeyDown]
            }
            HoldTarget::Key(_) => vec![CGEventType::KeyDown, CGEventType::KeyUp],
        };

        // Hand the freshly-built run loop (or a failure) back to this thread.
        let (tx, rx) = std::sync::mpsc::channel::<Result<RunLoopHandle, String>>();
        let state_thread = state.clone();
        let join = std::thread::Builder::new()
            .name("echo-hold-key".into())
            .spawn(move || {
                let state_cb = state_thread.clone();
                let tap = CGEventTap::new(
                    CGEventTapLocation::HID,
                    CGEventTapPlacement::HeadInsertEventTap,
                    CGEventTapOptions::ListenOnly,
                    events,
                    move |_proxy: CGEventTapProxy, etype: CGEventType, ev: &CGEvent| {
                        handle(&state_cb, etype, ev);
                        None
                    },
                );
                let tap = match tap {
                    Ok(t) => t,
                    Err(_) => {
                        let _ = tx.send(Err(
                            "could not create event tap (grant Input Monitoring to Echo)".into(),
                        ));
                        return;
                    }
                };
                let source = match tap.mach_port.create_runloop_source(0) {
                    Ok(s) => s,
                    Err(_) => {
                        let _ = tx.send(Err("could not create run-loop source".into()));
                        return;
                    }
                };
                state_thread
                    .tap_port
                    .store(tap.mach_port.as_concrete_TypeRef() as usize, Ordering::SeqCst);

                let runloop = CFRunLoop::get_current();
                unsafe { runloop.add_source(&source, kCFRunLoopCommonModes) };
                tap.enable();
                // Success: publish the loop so stop() can break it, then block.
                if tx.send(Ok(RunLoopHandle(runloop))).is_err() {
                    return; // manager gave up
                }
                CFRunLoop::run_current();
                // Loop stopped → drop tap/source, thread ends.
            })
            .map_err(|e| format!("spawn hold-key thread: {e}"))?;

        match rx.recv() {
            Ok(Ok(runloop)) => {
                *RUNNING.lock().unwrap() = Some(Running { runloop, join });
                log::info!("hold-key monitor active: {target:?} hold={hold_ms}ms");
                Ok(())
            }
            Ok(Err(e)) => {
                let _ = join.join();
                Err(e)
            }
            Err(_) => {
                let _ = join.join();
                Err("hold-key thread exited before signalling".into())
            }
        }
    }

    /// Stop the monitor (breaks the run loop, joins the thread). No-op if idle.
    pub fn stop() {
        let running = RUNNING.lock().unwrap().take();
        if let Some(r) = running {
            r.runloop.0.stop();
            let _ = r.join.join();
            log::info!("hold-key monitor stopped");
        }
    }
}
