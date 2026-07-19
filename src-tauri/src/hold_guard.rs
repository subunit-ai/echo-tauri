//! Universal last-resort backstop that guarantees a dictation session always
//! ends — so the OS microphone indicator can never stick "on" indefinitely.
//!
//! The fast, exact release is handled elsewhere per input path: single-token hold
//! hotkeys poll the real hardware key in [`crate::hold_key`] (macOS). This module
//! is the catch-all UNDER that: a purely time-based net that force-releases after
//! [`MAX_SECS`] no matter the cause or platform — a dropped key-up on the OS-plugin
//! combo path (which has no watchdog), a wedged toggle/button/tray start, or any
//! path on Windows/Linux where the hold-key tap doesn't exist. [`MAX_SECS`] is far
//! beyond any real dictation, so a live take is never cut; this only fires on a
//! session that is genuinely stuck.
//!
//! Per-session: armed in [`crate::commands::do_start`] with the session's epoch,
//! it exits the instant the session ends, a newer session supersedes it (epoch
//! bump), or it force-releases. It only exists while a take is in flight → zero
//! idle cost.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::commands::AppState;

/// Force-release ceiling. No real dictation runs this long, so it never cuts a
/// take — it only frees a genuinely wedged session.
const MAX_SECS: u64 = 300;
/// How often to check. Coarse on purpose: this is a safety net, not the fast path.
const POLL: Duration = Duration::from_millis(500);

/// Spawn the per-session backstop. `epoch` is this session's generation (from
/// `AppState::session_epoch`); the guard exits as soon as a newer session bumps it.
pub fn arm(app: &AppHandle, epoch: u64) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("echo-mic-backstop".into())
        .spawn(move || run(app, epoch));
}

fn run(app: AppHandle, epoch: u64) {
    let started = Instant::now();
    loop {
        std::thread::sleep(POLL);

        let alive = {
            let state = app.state::<AppState>();
            // Same session (not superseded) AND still recording.
            state.session_epoch.load(Ordering::SeqCst) == epoch
                && state.session_active.load(Ordering::SeqCst)
        };
        match decide(alive, started.elapsed().as_secs()) {
            Tick::Continue => continue,
            Tick::Exit => return, // ended cleanly or superseded — nothing to do
            Tick::Backstop => {
                log::warn!(
                    "mic-backstop: {MAX_SECS}s ceiling hit while still recording — \
                     force-releasing the mic (a release event was lost somewhere)"
                );
                crate::commands::do_cancel(&app);
                return;
            }
        }
    }
}

/// What a single backstop poll resolves to. Pure so every branch is deterministically
/// testable without a running app.
#[derive(Debug, PartialEq, Eq)]
enum Tick {
    Continue,
    Exit,
    Backstop,
}

fn decide(alive: bool, elapsed_secs: u64) -> Tick {
    if !alive {
        return Tick::Exit;
    }
    if elapsed_secs >= MAX_SECS {
        return Tick::Backstop;
    }
    Tick::Continue
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decide_exits_when_session_gone() {
        // A dead / superseded session is never force-cancelled, even past the ceiling.
        assert_eq!(decide(false, 0), Tick::Exit);
        assert_eq!(decide(false, MAX_SECS + 10), Tick::Exit);
    }

    #[test]
    fn decide_continues_while_within_ceiling() {
        assert_eq!(decide(true, 0), Tick::Continue);
        assert_eq!(decide(true, MAX_SECS - 1), Tick::Continue);
    }

    #[test]
    fn decide_backstops_a_wedged_session_at_the_ceiling() {
        assert_eq!(decide(true, MAX_SECS), Tick::Backstop);
        assert_eq!(decide(true, MAX_SECS + 999), Tick::Backstop);
    }
}
