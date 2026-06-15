//! Native record-start cue.
//!
//! The record-start sound used to be played by the webview (`src/lib/sounds.ts`),
//! but the main window hides to the tray on close (`prevent_close` + `hide()`), and
//! WebKit SUSPENDS a hidden page's `AudioContext`. So when you trigger dictation by
//! the global hotkey while working in another app — the normal case — the webview's
//! context was suspended and the cue only played after an async `resume()`, i.e. it
//! arrived late. Playing it natively here makes it instant regardless of window
//! state (TJ: "der muss instant kommen, vorgeladen sein").
//!
//! A dedicated thread plays the cues; it opens a FRESH output stream PER cue rather
//! than holding one open for the app's life. A long-held cpal/CoreAudio stream goes
//! stale after system sleep / lid-close / a default-device change (no auto-recovery)
//! — that's exactly when the cue began lagging again after the Mac had been closed.
//! A fresh handle each time can't go stale; the few-ms device open is negligible for
//! a short UI cue and runs off the hot path (the press just sends on a channel). The
//! bundled WAV is embedded in the binary. Best-effort throughout: any audio failure
//! is swallowed (the cue is non-critical, must never break dictation). Only the
//! bundled "standard" cue is native; synth presets stay in the webview.

use once_cell::sync::OnceCell;
use std::io::Cursor;
use std::sync::mpsc::{channel, Sender};

// Same asset the webview's "standard" start cue uses.
static START_WAV: &[u8] = include_bytes!("../../src/assets/sounds/start.wav");

// Sender into the audio thread; the payload is the volume (0–1).
static TX: OnceCell<Sender<f32>> = OnceCell::new();

/// Spawn the audio thread and open the output stream ONCE, at app start, so the
/// Idempotent (safe to call repeatedly). Spawns the audio thread that plays cues.
pub fn init() {
    TX.get_or_init(|| {
        let (tx, rx) = channel::<f32>();
        let _ = std::thread::Builder::new()
            .name("echo-cue".into())
            .spawn(move || {
                for vol in rx {
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
                        if let Ok(src) = rodio::Decoder::new(Cursor::new(START_WAV)) {
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
        let _ = tx.send(volume);
    }
}
