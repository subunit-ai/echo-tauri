//! Auto-meeting detection (increment 1: the trigger).
//!
//! Goal (TJ 2026-06-05): when a Teams / Zoom / Google-Meet meeting starts on the
//! device, Echo should notice and *briefly ask* whether to record it (never silent).
//! App priority order: Teams → Zoom → Meet.
//!
//! v1 signal = the FOREGROUND window title. When a user joins a call that window is
//! in front, and the title carries a distinctive marker (e.g. "Zoom Meeting"). We
//! reuse the exact GetForegroundWindow + GetWindowTextW pattern from `inject.rs`
//! (already-enabled `WindowsAndMessaging` feature) so this compiles on Win-ARM without
//! new COM/feature surface. Because detection only *prompts* (the user confirms), the
//! occasional false positive / miss is acceptable. A later increment can upgrade to the
//! precise "mic-in-use" signal via Core Audio (IAudioSessionManager2).
//!
//! On a rising edge (no-meeting → meeting) we emit `echo://meeting-detected` with the
//! app name; the frontend shows the prompt. A per-app cooldown prevents re-prompt churn
//! when the call window loses/regains focus. NOTE: this only DETECTS + prompts — the
//! actual dual-audio (mic + system loopback) capture is the next increment.

#![allow(dead_code)]

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

pub const EVT_MEETING_DETECTED: &str = "echo://meeting-detected";

/// Don't re-prompt for the same app within this window (focus can flip mid-call).
const COOLDOWN_SECS: u64 = 600;
const POLL_EVERY: Duration = Duration::from_secs(3);

#[derive(Clone, serde::Serialize)]
pub struct MeetingDetectedPayload {
    /// "Teams" | "Zoom" | "Meet"
    pub app: String,
}

/// Match a foreground-window title against the known meeting apps, in TJ's priority
/// order (Teams → Zoom → Meet). Case-insensitive. Returns the app label or None.
/// Patterns are deliberately simple + easy to tune from Erik's real-world titles.
fn match_meeting_app(title: &str) -> Option<&'static str> {
    let t = title.to_lowercase();
    // Teams: the call/meeting window. The bare main window is also "microsoft teams",
    // so require a meeting marker to avoid prompting just because Teams is open.
    let teams_marker = t.contains("microsoft teams")
        && (t.contains("meeting")
            || t.contains("besprechung")
            || t.contains("call")
            || t.contains("anruf"));
    if teams_marker {
        return Some("Teams");
    }
    // Zoom: the in-call window is literally titled "Zoom Meeting" / "Zoom Workplace…".
    if t.contains("zoom meeting") || t.contains("zoom workplace") {
        return Some("Zoom");
    }
    // Google Meet (browser): the active-tab title bubbles into the window title.
    if t.contains("google meet") || t.contains("meet.google.com") {
        return Some("Meet");
    }
    None
}

/// Read the current foreground window title (Windows). Mirrors `inject.rs`.
#[cfg(windows)]
fn foreground_title() -> String {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return String::new();
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buf);
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

#[cfg(not(windows))]
fn foreground_title() -> String {
    String::new()
}

/// Spawn the background poller. No-op everywhere except Windows (the only platform
/// with the foreground-title API wired today). Honors `config.meeting_autodetect`.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // App-Label + Unix-Sekunde der letzten Meldung (Cooldown). Kein Date::now()
        // verfügbar im Tauri-Sync-Kontext → tokio Instant für den Cooldown.
        let mut last_app: Option<&'static str> = None;
        let mut last_fired: Option<tokio::time::Instant> = None;
        let mut tick = tokio::time::interval(POLL_EVERY);
        loop {
            tick.tick().await;
            // Re-read the toggle each tick so it can be turned off live.
            let on = {
                let st = app.state::<crate::commands::AppState>();
                let c = st.config.lock();
                c.meeting_autodetect
            };
            if !on {
                last_app = None;
                continue;
            }
            let hit = match_meeting_app(&foreground_title());
            match hit {
                Some(appname) => {
                    let cooled = last_fired
                        .map(|t| t.elapsed() >= Duration::from_secs(COOLDOWN_SECS))
                        .unwrap_or(true);
                    // Rising edge OR cooldown elapsed for a (re)appearing meeting.
                    if last_app != Some(appname) && cooled {
                        last_app = Some(appname);
                        last_fired = Some(tokio::time::Instant::now());
                        let _ = app.emit(
                            EVT_MEETING_DETECTED,
                            MeetingDetectedPayload { app: appname.to_string() },
                        );
                        log::info!("meeting_detect: {appname} meeting detected → prompt");
                    }
                }
                None => {
                    // Meeting window gone/backgrounded → arm the next rising edge.
                    last_app = None;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::match_meeting_app;

    #[test]
    fn detects_each_app() {
        // Zoom + Meet have unambiguous in-call window titles → reliable.
        assert_eq!(match_meeting_app("Zoom Meeting"), Some("Zoom"));
        assert_eq!(match_meeting_app("Zoom Workplace - Meeting"), Some("Zoom"));
        assert_eq!(
            match_meeting_app("Projekt-Sync - Google Meet - Google Chrome"),
            Some("Meet")
        );
        // Teams: title-only is heuristic — needs a meeting marker (see ignores_*).
        // A meeting whose NAME lacks such a word is missed by title alone; that's
        // why the precise "mic-in-use" (Core Audio) signal is the planned upgrade.
        assert_eq!(
            match_meeting_app("Wöchentliches Meeting | Microsoft Teams"),
            Some("Teams")
        );
        assert_eq!(match_meeting_app("Anruf · Microsoft Teams"), Some("Teams"));
    }

    #[test]
    fn ignores_non_meeting_windows() {
        // Teams merely OPEN (no call) must NOT trigger — the key safety property
        // (otherwise we'd prompt constantly while Teams sits in the tray).
        assert_eq!(match_meeting_app("Microsoft Teams"), None);
        assert_eq!(match_meeting_app("Chat | Microsoft Teams"), None);
        assert_eq!(match_meeting_app("Posteingang - Outlook"), None);
        assert_eq!(match_meeting_app(""), None);
    }

    #[test]
    fn priority_teams_first() {
        // A contrived title naming several apps resolves to Teams (highest priority).
        assert_eq!(
            match_meeting_app("Zoom Meeting — Microsoft Teams call"),
            Some("Teams")
        );
    }
}
