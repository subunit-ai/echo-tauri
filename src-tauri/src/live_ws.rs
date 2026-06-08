//! LIVE mode — stream the mic to the WhisperLive proxy (live-transcribe.subunit.ai)
//! over a WebSocket and type the transcript IN as you speak (~2s latency).
//!
//! This is the low-latency alternative to the segment-batch path in
//! `streaming.rs`. It opens ONE authenticated WS, streams 16 kHz mono float32
//! continuously, and types finalized words as they arrive.
//!
//! Protocol (WhisperLive, behind our JWT proxy):
//!   connect wss://…/ with `Authorization: Bearer <jwt>` → send {uid,language,task,model,use_vad} →
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

/// Live-dictation control signal (stored in AppState.streaming): the hotkey
/// release drives FINISH (flush + stop) and Escape drives CANCEL (discard).
pub const RUN: u8 = 0;
pub const FINISH: u8 = 1;
pub const CANCEL: u8 = 2;

const SR: u32 = 16000;
/// Wait this long for the WhisperLive model to come up (SERVER_READY) before
/// giving up — streaming audio before it's ready drops the first words.
const READY_TIMEOUT_SECS: u64 = 15;
/// Bound the WS connect so a black-holed network surfaces as a drop, not a hang.
const CONNECT_TIMEOUT_SECS: u64 = 10;
/// Recover a dropped connection mid-dictation this many times before wrapping up.
const MAX_RECONNECTS: u32 = 3;
const RECONNECT_BACKOFF_MS: u64 = 500;

pub fn spawn(app: AppHandle, signal: Arc<AtomicU8>, gen: u64) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(app.clone(), signal.clone()).await {
            log::warn!("live_ws: {e}");
            // run() handles its own terminal states; this is the last-resort path.
            emit_state(&app, EngineState::Error, Some("Live-Diktat fehlgeschlagen.".into()));
        }
        let state = app.state::<AppState>();
        // Clear the streaming slot ONLY if it still holds OUR signal. do_transcribe/
        // do_cancel may have already take()n it, and a newer do_start may have
        // installed a DIFFERENT signal — nulling that would strand the new live
        // session (its FINISH/CANCEL would never reach the new task). The Arc identity
        // is the precise ownership token; the generation counter alone is a TOCTOU
        // here. Hold the lock across the check+clear so it's race-free.
        {
            let mut s = state.streaming.lock();
            if s.as_ref().map_or(false, |cur| Arc::ptr_eq(cur, &signal)) {
                *s = None;
            }
        }
        // Release the mic + captured target only if no NEWER session has taken over
        // (a fresh do_start bumps session_gen and now owns the recorder). On a normal
        // finish do_transcribe already took the signal, so the recorder release is
        // driven by the generation match — NOT by signal identity (which is gone).
        if state.session_gen.load(Ordering::SeqCst) == gen {
            let _ = state.recorder.stop();
            *state.target.lock() = None;
        }
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

/// Guarantee a `ws(s)://host…` URL carries a path component. tokio-tungstenite
/// writes the HTTP upgrade request-target verbatim from the URL path, so a bare
/// authority (`wss://live-transcribe.subunit.ai`) produces an empty path and the
/// request line becomes `GET ?token=… HTTP/1.1` (no leading `/`) — which
/// Cloudflare rejects with 400 Bad Request *before* it reaches our proxy, i.e. a
/// silent connect failure with an empty proxy log. Splicing in `/` after the
/// authority makes it the well-formed `GET /?token=…`. Idempotent: a URL that
/// already has a path is returned unchanged.
fn ensure_ws_path(endpoint: &str) -> String {
    let Some(scheme_end) = endpoint.find("://") else {
        return endpoint.to_string();
    };
    let auth_start = scheme_end + 3;
    // The authority ends at the first '/' (already a path) or '?' (query, no path).
    match endpoint[auth_start..].find(|c: char| c == '/' || c == '?') {
        Some(rel) => {
            let i = auth_start + rel;
            if endpoint.as_bytes()[i] == b'/' {
                endpoint.to_string() // already has a path
            } else {
                format!("{}/{}", &endpoint[..i], &endpoint[i..]) // '?' with no path
            }
        }
        None => format!("{endpoint}/"), // bare authority, no path/query
    }
}

#[cfg(test)]
mod tests {
    use super::ensure_ws_path;

    #[test]
    fn adds_slash_to_bare_authority() {
        assert_eq!(
            ensure_ws_path("wss://live-transcribe.subunit.ai"),
            "wss://live-transcribe.subunit.ai/"
        );
    }

    #[test]
    fn keeps_existing_path() {
        assert_eq!(ensure_ws_path("wss://host/live"), "wss://host/live");
        assert_eq!(ensure_ws_path("wss://host/"), "wss://host/");
    }

    #[test]
    fn splices_slash_before_query() {
        assert_eq!(ensure_ws_path("wss://host?x=1"), "wss://host/?x=1");
    }
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

/// How a single WS session ended — drives the reconnect decision in [`run`].
#[derive(PartialEq)]
enum Phase {
    /// Clean finish (hotkey released / recording stopped) — tail flushed.
    Finished,
    /// User hit Escape — discard.
    Canceled,
    /// Connection dropped/failed unexpectedly while still recording.
    Disconnected,
}

async fn run(app: AppHandle, signal: Arc<AtomicU8>) -> anyhow::Result<()> {
    // Auth + config snapshot up front.
    crate::auth::ensure_fresh(&app);
    let (mut cfg, target) = {
        let state = app.state::<AppState>();
        let cfg = state.config.lock().clone();
        let target = state.target.lock().clone();
        (cfg, target)
    };

    // Survives across reconnects: `typed` is the prefix already typed in the
    // CURRENT session, `sent` the recorder samples already streamed.
    let mut typed = String::new();
    let mut sent: usize = 0;
    let mut reconnects: u32 = 0;

    loop {
        let phase = stream_session(&app, &cfg, target.as_ref(), &signal, &mut typed, &mut sent)
            .await
            .unwrap_or(Phase::Disconnected); // connect/handshake error → treat as a drop

        match phase {
            Phase::Finished => {
                emit_state(&app, EngineState::Done, None);
                return Ok(());
            }
            Phase::Canceled => {
                emit_state(&app, EngineState::Idle, None);
                return Ok(());
            }
            Phase::Disconnected => {
                // Only reconnect if the user is still actively dictating. If they
                // already released/escaped or the mic stopped, just wrap up.
                let sig = signal.load(Ordering::Relaxed);
                let recording = app.state::<AppState>().recorder.is_recording();
                let wrapping_up = sig != RUN || !recording;
                if wrapping_up || reconnects >= MAX_RECONNECTS {
                    if sig == CANCEL {
                        emit_state(&app, EngineState::Idle, None);
                    } else if typed.is_empty() {
                        // Nothing ever transcribed across all attempts → real failure.
                        emit_state(
                            &app,
                            EngineState::Error,
                            Some("Verbindung zum Live-Server fehlgeschlagen.".into()),
                        );
                    } else {
                        // Keep whatever we already typed in.
                        emit_state(&app, EngineState::Done, None);
                    }
                    return Ok(());
                }
                reconnects += 1;
                log::warn!("live_ws: disconnected — reconnect {reconnects}/{MAX_RECONNECTS}");
                // A reconnected WhisperLive session starts a fresh transcript
                // coordinate system, so reset `typed` (we keep `sent` so we don't
                // re-stream — and re-type — audio the old session already consumed).
                typed.clear();
                tokio::time::sleep(Duration::from_millis(RECONNECT_BACKOFF_MS)).await;
                crate::auth::ensure_fresh(&app); // token may have expired during the outage
                cfg = app.state::<AppState>().config.lock().clone();
            }
        }
    }
}

/// One WS session: connect, handshake, wait for SERVER_READY, stream mic audio,
/// type finalized words, and on a clean finish drain + flush the tail. Returns how
/// the session ended so [`run`] can reconnect on an unexpected drop.
async fn stream_session(
    app: &AppHandle,
    cfg: &crate::config::Config,
    target: Option<&crate::inject::Target>,
    signal: &Arc<AtomicU8>,
    typed: &mut String,
    sent: &mut usize,
) -> anyhow::Result<Phase> {
    let token = cfg.subunit_access_token.clone();
    let endpoint = if cfg.live_ws_endpoint.trim().is_empty() {
        "wss://live-transcribe.subunit.ai/".to_string()
    } else {
        ensure_ws_path(cfg.live_ws_endpoint.trim())
    };

    // Send the JWT in the Authorization header, NOT the URL query. The proxy
    // accepts either, but `?token=<jwt>` lands in Cloudflare/edge/proxy access
    // logs (and any intermediary), so a header keeps the credential out of URLs.
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = endpoint
        .as_str()
        .into_client_request()
        .map_err(|e| anyhow::anyhow!("bad live_ws endpoint {endpoint:?}: {e}"))?;
    let bearer = format!("Bearer {token}")
        .parse()
        .map_err(|_| anyhow::anyhow!("access token not valid for an Authorization header"))?;
    request
        .headers_mut()
        .insert(tokio_tungstenite::tungstenite::http::header::AUTHORIZATION, bearer);

    // Bounded connect so a black-holed network surfaces as a drop, not a hang.
    let connect = tokio::time::timeout(
        Duration::from_secs(CONNECT_TIMEOUT_SECS),
        tokio_tungstenite::connect_async(request),
    )
    .await;
    let (ws, _resp) = match connect {
        Err(_) => anyhow::bail!("connect timeout after {CONNECT_TIMEOUT_SECS}s"),
        // Surface the real handshake error (e.g. an HTTP 4xx from the edge). run()
        // maps any Err to a silent reconnect, so without this log the cause is
        // invisible in the field log — which is exactly how the missing-path 400
        // hid for two releases.
        Ok(Err(e)) => {
            log::warn!("live_ws: connect failed: {e}");
            return Err(e.into());
        }
        Ok(Ok(pair)) => pair,
    };
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

    let mut ready = false; // server confirmed SERVER_READY — don't stream before this
    let mut last_full = String::new();
    let connect_start = std::time::Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(200));

    loop {
        tokio::select! {
            _ = tick.tick() => {
                let sig = signal.load(Ordering::Relaxed);
                if sig == CANCEL { return Ok(Phase::Canceled); }
                let recording = app.state::<AppState>().recorder.is_recording();
                let finishing = sig == FINISH || !recording;

                if !ready {
                    // Hold audio until the model is up — streaming before
                    // SERVER_READY means the first words get dropped server-side.
                    if connect_start.elapsed() > Duration::from_secs(READY_TIMEOUT_SECS) {
                        anyhow::bail!("server not ready in time");
                    }
                    if finishing { break; } // user finished before we ever got ready
                    continue;
                }

                if let Some(cap) = app.state::<AppState>().recorder.snapshot() {
                    if cap.samples.len() > *sent {
                        let new = cap.samples[*sent..].to_vec();
                        *sent = cap.samples.len();
                        let pcm = resample_16k(&new, cap.sample_rate);
                        if !pcm.is_empty()
                            && write.send(Message::Binary(f32_le_bytes(&pcm))).await.is_err()
                        {
                            return Ok(Phase::Disconnected);
                        }
                    }
                }
                if finishing { break; }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                            if !ready {
                                if v.get("message").and_then(|m| m.as_str()) == Some("SERVER_READY") {
                                    ready = true;
                                }
                                continue;
                            }
                            last_full = full_text(&v);
                            if let Some(stable) = stable_text(&v) {
                                if stable.len() > typed.len() && stable.starts_with(typed.as_str()) {
                                    let delta = format!("{} ", &stable[typed.len()..].trim_start());
                                    *typed = stable;
                                    let _ = crate::inject::type_live(&delta, cfg, target);
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => return Ok(Phase::Disconnected),
                    Some(Err(_)) => return Ok(Phase::Disconnected),
                    _ => {}
                }
            }
        }
    }

    // Clean finish: stop sending, ask the server to close, drain remaining results
    // and flush the trailing final segment (all stable once recording stopped).
    let _ = write.send(Message::Close(None)).await;
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
    if last_full.len() > typed.len() && last_full.starts_with(typed.as_str()) {
        let tail = last_full[typed.len()..].trim();
        if !tail.is_empty() {
            let _ = crate::inject::type_live(&format!("{tail} "), cfg, target);
            *typed = last_full;
        }
    }
    Ok(Phase::Finished)
}
