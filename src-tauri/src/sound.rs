//! Native record-start / record-stop cues.
//!
//! The record-start sound used to be played by the webview (`src/lib/sounds.ts`),
//! but the main window hides to the tray on close (`prevent_close` + `hide()`), and
//! WebKit SUSPENDS a hidden page's `AudioContext`. So when you trigger dictation by
//! the global hotkey while working in another app — the normal case — the webview's
//! context was suspended and the cue only played after an async `resume()`, i.e. it
//! arrived late. Playing it natively here makes it instant regardless of window
//! state (TJ: "der muss instant kommen, vorgeladen sein").
//!
//! The release/stop cue (v0.5.89) is the exact same reasoning applied to the OTHER
//! end of the press: `stop.wav` is `start.wav` reversed and trimmed to its actual
//! swoosh content, with a short fade-in/fade-out so the reversal doesn't click
//! (generated once offline, not derived at runtime). It plays natively for the
//! same instant-even-hidden guarantee. It's the acoustic counterpart of the start
//! cue, so it shares the start cue's own toggle/id — there is no separate "stop
//! sound" setting.
//!
//! A dedicated thread plays the cues; it opens a FRESH output stream PER cue rather
//! than holding one open for the app's life. A long-held cpal/CoreAudio stream goes
//! stale after system sleep / lid-close / a default-device change (no auto-recovery)
//! — that's exactly when the cue began lagging again after the Mac had been closed.
//! A fresh handle each time can't go stale; the few-ms device open is negligible for
//! a short UI cue and runs off the hot path (the press just sends on a channel). The
//! bundled WAVs are embedded in the binary. Best-effort throughout: any audio
//! failure is swallowed (the cue is non-critical, must never break dictation). Only
//! the bundled "standard" cues are native; synth presets stay in the webview.

use once_cell::sync::OnceCell;
use std::io::Cursor;
use std::sync::mpsc::{channel, Sender};

// Same asset the webview's "standard" start cue uses.
static START_WAV: &[u8] = include_bytes!("../../src/assets/sounds/start.wav");
// `start.wav` reversed (+ 5ms fade-in / 20ms fade-out to kill reversal clicks),
// trimmed to the actual swoosh content — see src/assets/sounds/stop.wav.
static STOP_WAV: &[u8] = include_bytes!("../../src/assets/sounds/stop.wav");

/// Which bundled cue to play, carried through the channel alongside the volume.
enum Cue {
    Start(f32),
    Stop(f32),
}

// Sender into the audio thread.
static TX: OnceCell<Sender<Cue>> = OnceCell::new();

/// Spawn the audio thread and open the output stream ONCE, at app start, so the
/// Idempotent (safe to call repeatedly). Spawns the audio thread that plays cues.
pub fn init() {
    TX.get_or_init(|| {
        let (tx, rx) = channel::<Cue>();
        let _ = std::thread::Builder::new()
            .name("echo-cue".into())
            .spawn(move || {
                for cue in rx {
                    let (bytes, vol): (&[u8], f32) = match cue {
                        Cue::Start(v) => (START_WAV, v),
                        Cue::Stop(v) => (STOP_WAV, v),
                    };
                    // Open a FRESH output stream PER cue. A long-held stream goes
                    // stale after system sleep / lid-close / a default-device change
                    // (cpal/CoreAudio doesn't auto-recover) — which is exactly when
                    // the cue started lagging again after the Mac had been closed.
                    // A fresh device handle each time can't go stale. Building the
                    // default-output stream costs only a few ms — fine for a short
                    // UI cue, and immune to the device dying under us.
                    let Ok((stream, handle)) = rodio::OutputStream::try_default() else {
                        continue; // no output device right now → skip this cue
                    };
                    if let Ok(sink) = rodio::Sink::try_new(&handle) {
                        if let Ok(src) = rodio::Decoder::new(Cursor::new(bytes)) {
                            sink.set_volume(vol.clamp(0.0, 1.0));
                            sink.append(src);
                            // Hold the stream alive until the cue finishes, THEN drop
                            // it — so the next cue opens its own fresh stream.
                            sink.sleep_until_end();
                        }
                    }
                    drop(stream);
                }
            });
        tx
    });
}

/// Play the record-start cue at `volume` (0–1). No-op if `init` never ran or the
/// audio thread/device is unavailable.
pub fn play_start(volume: f32) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(Cue::Start(volume));
    }
}

/// Play the record-stop/release cue at `volume` (0–1) — the reversed start cue.
/// No-op if `init` never ran or the audio thread/device is unavailable.
pub fn play_stop(volume: f32) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(Cue::Stop(volume));
    }
}
