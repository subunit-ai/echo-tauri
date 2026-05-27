//! Live dictation. While recording with `live_type` on, a background controller
//! polls the (non-draining) recorder buffer, cuts the audio on speech pauses
//! (RMS silence) — or at a hard max length — transcribes each segment and types
//! it into the focused window so text appears as you speak. Experimental.
//!
//! Coordination: a shared signal (0 = run, 1 = finish/flush, 2 = cancel/discard)
//! lets the hotkey release (`do_transcribe`) and Escape (`do_cancel`) drive the
//! controller without racing the recorder's drain-on-stop.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::commands::AppState;
use crate::events::{emit_state, EngineState};
use crate::inject::Target;

pub const RUN: u8 = 0;
pub const FINISH: u8 = 1;
pub const CANCEL: u8 = 2;

const POLL: Duration = Duration::from_millis(150);
const SILENCE_RMS: f32 = 0.012; // raw-sample RMS below this = "silence"
const PAUSE_S: f32 = 0.55; // trailing silence that ends a segment
const MIN_SEGMENT_S: f32 = 1.0; // don't cut shorter than this on a pause
const MAX_SEGMENT_S: f32 = 12.0; // force a cut for continuous speech

fn rms(s: &[f32]) -> f32 {
    if s.is_empty() {
        return 0.0;
    }
    let sum: f32 = s.iter().map(|x| x * x).sum();
    (sum / s.len() as f32).sqrt()
}

pub fn spawn(app: AppHandle, signal: Arc<AtomicU8>) {
    let _ = std::thread::Builder::new()
        .name("echo-stream".into())
        .spawn(move || run(app, signal));
}

fn run(app: AppHandle, signal: Arc<AtomicU8>) {
    let state = app.state::<AppState>();
    let target = state.target.lock().clone();
    let mut consumed: usize = 0;
    let mut canceled = false;

    loop {
        std::thread::sleep(POLL);
        let sig = signal.load(Ordering::Relaxed);
        if sig == CANCEL {
            canceled = true;
            break;
        }
        let finishing = sig == FINISH || !state.recorder.is_recording();

        let cap = match state.recorder.snapshot() {
            Some(c) => c,
            None => {
                if finishing {
                    break;
                }
                continue;
            }
        };
        let sr = cap.sample_rate.max(1);
        let samples = cap.samples;
        let available = samples.len();
        if available <= consumed {
            if finishing {
                break;
            }
            continue;
        }

        let pause_n = (PAUSE_S * sr as f32) as usize;
        let min_n = (MIN_SEGMENT_S * sr as f32) as usize;
        let max_n = (MAX_SEGMENT_S * sr as f32) as usize;
        let seg_len = available - consumed;

        let cut = if finishing {
            Some(available) // flush all remaining audio as the final segment
        } else {
            let tail = &samples[available.saturating_sub(pause_n)..available];
            if rms(tail) < SILENCE_RMS && seg_len > pause_n + min_n {
                Some(available - pause_n) // the speech part before the pause
            } else if seg_len >= max_n {
                Some(available)
            } else {
                None
            }
        };

        if let Some(end) = cut {
            let end = end.max(consumed);
            let seg = samples[consumed..end].to_vec();
            consumed = available; // drop trailing silence; resume from "now"
            if rms(&seg) >= SILENCE_RMS {
                type_segment(&app, &seg, sr, target.as_ref());
            }
        }

        if finishing {
            break;
        }
    }

    // Cleanup: halt capture, clear shared state, report terminal state.
    let _ = state.recorder.stop();
    *state.target.lock() = None;
    *state.streaming.lock() = None;
    emit_state(
        &app,
        if canceled {
            EngineState::Idle
        } else {
            EngineState::Done
        },
        None,
    );
}

fn type_segment(app: &AppHandle, seg: &[f32], sr: u32, target: Option<&Target>) {
    let state = app.state::<AppState>();
    if state.config.lock().mode == "subunit" {
        crate::auth::ensure_fresh(app);
    }
    let cfg = state.config.lock().clone();
    match crate::transcribe::run(&cfg, seg, sr) {
        Ok(r) => {
            // Vocab is already applied inside transcribe::run; add DACH (no AI
            // cleanup mid-stream — that's a whole-text rewrite, not per segment).
            let mut text = r.text;
            if cfg.dach_format_enabled {
                text = crate::dach::dach_format(&text);
            }
            let text = text.trim();
            if !text.is_empty() {
                let _ = crate::inject::type_live(&format!("{text} "), &cfg, target);
            }
        }
        Err(e) => log::debug!("live segment: {}", e.message),
    }
}
