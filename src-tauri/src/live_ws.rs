//! LIVE mode — stream the mic to the WhisperLive proxy (live-transcribe.subunit.ai)
//! over a WebSocket and type the transcript IN as you speak (~2s latency).
//!
//! This is the low-latency alternative to the segment-batch path in
//! `streaming.rs`. It opens ONE authenticated WS, streams 16 kHz mono float32
//! continuously, and types finalized words as they arrive.
//!
//! Protocol (WhisperLive, behind our JWT proxy):
//!   connect wss://…/?token=<jwt> → send {uid,language,task,model,use_vad} →
//!   await {"message":"SERVER_READY"} → stream float32-LE binary frames →
//!   receive {"segments":[{start,end,text}]} (evolving partials).
//!   CRITICAL: float32, not int16 (int16 → VAD drops it all as silence).
//!
//! Typing strategy: treat all segments EXCEPT the last as stable (the last is
//! still being revised). Type the forward-growth of the stable prefix as it
//! grows; on finish, flush the final segment too. We never re-type or correct
//! already-typed text (can't un-type), so we only ever append stable text.
//!
//! Reuses the shared RUN/FINISH/CANCEL signal from `streaming` (stored in
//! AppState.streaming) so the hotkey-release (do_transcribe → FINISH) and
//! Escape (do_cancel → CANCEL) drive this exactly like the batch path.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Manager};
use tokio_tungstenite::tungstenite::Message;

use crate::commands::AppState;
use crate::events::{emit_state, EngineState};
use crate::streaming::{CANCEL, FINISH};

const SR: u32 = 16000;

pub fn spawn(app: AppHandle, signal: Arc<AtomicU8>) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(app.clone(), signal).await {
            log::warn!("live_ws: {e}");
        }
        // Whatever happened, leave the engine in a clean state.
        let state = app.state::<AppState>();
        let _ = state.recorder.stop();
        *state.target.lock() = None;
        *state.streaming.lock() = None;
    });
}

/// Linear-resample mono f32 from `from_sr` to 16 kHz. WhisperLive assumes 16 kHz;
/// cpal captures at the device rate (often 44.1/48 kHz).
fn resample_16k(samples: &[f32], from_sr: u32) -> Vec<f32> {
    if from_sr == SR || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = from_sr as f64 / SR as f64;
    let out_len = ((samples.len() as f64) / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 * ratio;
        let i0 = src.floor() as usize;
        let frac = (src - i0 as f64) as f32;
        let a = samples[i0.min(samples.len() - 1)];
        let b = samples[(i0 + 1).min(samples.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

fn f32_le_bytes(samples: &[f32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(samples.len() * 4);
    for &s in samples {
        b.extend_from_slice(&s.to_le_bytes());
    }
    b
}

/// Concatenate the text of all segments except the last (stable prefix).
fn stable_text(v: &serde_json::Value) -> Option<String> {
    let segs = v.get("segments")?.as_array()?;
    if segs.is_empty() {
        return None;
    }
    let take = segs.len().saturating_sub(1);
    let parts: Vec<&str> = segs
        .iter()
        .take(take)
        .filter_map(|s| s.get("text").and_then(|x| x.as_str()))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    Some(parts.join(" "))
}

/// Full text of ALL segments (used to flush the tail at finish).
fn full_text(v: &serde_json::Value) -> String {
    v.get("segments")
        .and_then(|s| s.as_array())
        .map(|segs| {
            segs.iter()
                .filter_map(|s| s.get("text").and_then(|x| x.as_str()))
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

async fn run(app: AppHandle, signal: Arc<AtomicU8>) -> anyhow::Result<()> {
    // Auth + config snapshot up front.
    crate::auth::ensure_fresh(&app);
    let (cfg, target) = {
        let state = app.state::<AppState>();
        let cfg = state.config.lock().clone();
        let target = state.target.lock().clone();
        (cfg, target)
    };
    let token = cfg.subunit_access_token.clone();
    let endpoint = if cfg.live_ws_endpoint.trim().is_empty() {
        "wss://live-transcribe.subunit.ai".to_string()
    } else {
        cfg.live_ws_endpoint.trim().to_string()
    };
    let sep = if endpoint.contains('?') { '&' } else { '?' };
    let url = format!("{endpoint}{sep}token={token}");

    let (ws, _resp) = tokio_tungstenite::connect_async(&url).await?;
    let (mut write, mut read) = ws.split();

    // Config handshake.
    let hello = serde_json::json!({
        "uid": "echo-live",
        "language": if cfg.language.is_empty() { "de".into() } else { cfg.language.clone() },
        "task": "transcribe",
        "model": "large-v3-turbo",
        "use_vad": true,
    });
    write.send(Message::Text(hello.to_string())).await?;

    let mut typed = String::new(); // stable text already typed (never re-typed)
    let mut last_full = String::new(); // most recent full text (for the finish flush)
    let mut sent: usize = 0; // recorder samples already streamed
    let mut canceled = false;
    let mut tick = tokio::time::interval(Duration::from_millis(200));

    loop {
        tokio::select! {
            _ = tick.tick() => {
                let sig = signal.load(Ordering::Relaxed);
                if sig == CANCEL { canceled = true; break; }
                let recording = { app.state::<AppState>().recorder.is_recording() };
                let finishing = sig == FINISH || !recording;

                if let Some(cap) = { app.state::<AppState>().recorder.snapshot() } {
                    if cap.samples.len() > sent {
                        let new = cap.samples[sent..].to_vec();
                        sent = cap.samples.len();
                        let pcm = resample_16k(&new, cap.sample_rate);
                        if !pcm.is_empty()
                            && write.send(Message::Binary(f32_le_bytes(&pcm))).await.is_err()
                        {
                            break;
                        }
                    }
                }
                if finishing { break; }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                            last_full = full_text(&v);
                            if let Some(stable) = stable_text(&v) {
                                if stable.len() > typed.len() && stable.starts_with(&typed) {
                                    let delta = format!("{} ", &stable[typed.len()..].trim_start());
                                    typed = stable;
                                    let _ = crate::inject::type_live(&delta, &cfg, target.as_ref());
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }

    // Finish: stop sending, ask the server to close, drain remaining results and
    // flush the final segment (everything is stable once recording stopped).
    let _ = write.send(Message::Close(None)).await;
    if !canceled {
        let drain = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(Ok(msg)) = read.next().await {
                if let Message::Text(t) = msg {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                        last_full = full_text(&v);
                    }
                } else if matches!(msg, Message::Close(_)) {
                    break;
                }
            }
        });
        let _ = drain.await;
        // Type whatever stable text wasn't typed yet (the trailing final segment).
        if last_full.len() > typed.len() && last_full.starts_with(&typed) {
            let tail = last_full[typed.len()..].trim();
            if !tail.is_empty() {
                let _ = crate::inject::type_live(&format!("{tail} "), &cfg, target.as_ref());
            }
        }
    }

    emit_state(
        &app,
        if canceled { EngineState::Idle } else { EngineState::Done },
        None,
    );
    Ok(())
}
