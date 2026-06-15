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
//! A dedicated thread owns the rodio output stream for the app's whole life, so the
//! audio device is already open on the press — no device-open latency on the hot
//! path. The bundled WAV is embedded in the binary. Best-effort throughout: any
//! audio failure is swallowed (the cue is non-critical, must never break dictation).
//! Only the bundled "standard" cue is native; synth presets stay in the webview.

use once_cell::sync::OnceCell;
use std::io::Cursor;
use std::sync::mpsc::{channel, Sender};

// Same asset the webview's "standard" start cue uses.
static START_WAV: &[u8] = include_bytes!("../../src/assets/sounds/start.wav");

// Sender into the audio thread; the payload is the volume (0–1).
static TX: OnceCell<Sender<f32>> = OnceCell::new();

/// Spawn the audio thread and open the output stream ONCE, at app start, so the
/// first press pays zero device-open latency. Idempotent (safe to call repeatedly).
pub fn init() {
    TX.get_or_init(|| {
        let (tx, rx) = channel::<f32>();
        let _ = std::thread::Builder::new()
            .name("echo-cue".into())
            .spawn(move || {
                // The output stream MUST stay alive for sinks to produce sound, so
                // keep it on this frame for the whole loop (recv() blocks here).
                let Ok((_stream, handle)) = rodio::OutputStream::try_default() else {
                    return; // no output device → cue silently unavailable
                };
                while let Ok(vol) = rx.recv() {
                    if let Ok(sink) = rodio::Sink::try_new(&handle) {
                        if let Ok(src) = rodio::Decoder::new(Cursor::new(START_WAV)) {
                            sink.set_volume(vol.clamp(0.0, 1.0));
                            sink.append(src);
                            sink.detach(); // play to completion independently
                        }
                    }
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
