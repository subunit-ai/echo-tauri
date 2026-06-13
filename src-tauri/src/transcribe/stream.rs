//! Live dictation streaming — the WS client for the server's `/v1/dictate`.
//!
//! While the user holds the hotkey, a session thread feeds the growing
//! recording (16 kHz s16le PCM deltas) over one WebSocket; the server decodes
//! incrementally and pushes partial transcripts, which land in the UI as
//! `echo://stream-partial` events. On release the tail + an `end` frame go
//! out, the recorder is stopped (mic released — the audio already lives
//! server-side), and the server's final (full-quality decode + inline cleanup)
//! comes back WITHOUT re-uploading the whole take.
//!
//! Failure philosophy: streaming is an accelerator, never a gate. If the WS
//! can't connect, errors mid-flight, or the final times out, the session hands
//! back whatever capture it owns and the caller falls back to the classic
//! one-shot `/v1/transcribe` upload — worst case is exactly today's behaviour.
//!
//! Protocol (one dictation per connection — see server's dictate_ws.py):
//!   C→S text   {"token"|"api_key", "language", "quality_mode", "prompt",
//!               "cleanup_style"}
//!   S→C text   {"type":"ready"}
//!   C→S binary PCM s16le 16k mono deltas
//!   S→C text   {"type":"partial","text":…}        (repeatedly)
//!   C→S text   {"type":"end"} | {"type":"cancel"}
//!   S→C text   {"type":"final","text":…,"cleaned_text"?,…}  → close

use std::net::TcpStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use super::{vocab, EngineError};
use crate::commands::AppState;
use crate::recorder::Capture;

/// The server's final answer for one streamed dictation.
pub struct StreamFinal {
    pub text: String,
    pub cleaned_text: Option<String>,
    pub quality_mode: String,
    /// Audio duration the server decoded (s). The main pipeline needs it for
    /// stats/history since the streamed path keeps no local capture on success.
    pub duration_s: f64,
    /// Server cleanup outcome ("ok"/"unavailable"/"error") so the main path can
    /// apply the SAME doomed-/v1/cleanup-skip logic as the batch round trip.
    pub cleanup_status: Option<String>,
    /// "live" mode already typed this transcript into the target as the user
    /// spoke (reconciled to this exact text on release) → the caller MUST NOT
    /// paste it again. False for "final" mode (caller pastes once).
    pub already_injected: bool,
}

/// Error + whatever capture the session still owns, so the caller can fall
/// back to the classic upload without losing the user's words.
pub struct StreamFailure {
    pub error: EngineError,
    pub capture: Option<Capture>,
}

enum Ctl {
    Finish,
    Cancel,
}

struct Session {
    ctl_tx: mpsc::Sender<Ctl>,
    done_rx: mpsc::Receiver<Result<StreamFinal, StreamFailure>>,
}

static ACTIVE: Lazy<Mutex<Option<Session>>> = Lazy::new(|| Mutex::new(None));

/// Chars the live path has typed into the target this session (reset in `start`).
/// Lets `do_transcribe` skip a batch re-paste when a live take fails AFTER already
/// typing some text — pasting on top would duplicate it.
static LIVE_INJECTED: AtomicUsize = AtomicUsize::new(0);

/// How many characters the live path has typed into the target this session.
pub fn live_injected_chars() -> usize {
    LIVE_INJECTED.load(Ordering::Relaxed)
}

/// LocalAgreement state for "live" mode: the text already typed into the target
/// (`confirmed`) and the previous partial, to detect what is stable across two
/// consecutive decodes.
struct Live {
    confirmed: String,
    prev_partial: String,
}

/// The agreed-stable prefix of two consecutive partials: their longest common
/// prefix, trimmed back to the last word boundary so a still-growing final word
/// is never committed. Only text that survived two decodes is treated as stable.
fn agreed_stable(prev: &str, cur: &str) -> String {
    let common: String = prev
        .chars()
        .zip(cur.chars())
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a)
        .collect();
    match common.rfind(char::is_whitespace) {
        Some(idx) => common[..idx].to_string(),
        None => String::new(),
    }
}

/// Type the newly-stable suffix into the target (append at the caret). Only ever
/// grows `confirmed`; if a partial diverges (rare model revision) we wait — the
/// finish-time reconcile fixes it against the authoritative final.
fn live_commit(l: &mut Live, cur: &str) {
    let stable = agreed_stable(&l.prev_partial, cur);
    l.prev_partial = cur.to_string();
    if stable.len() > l.confirmed.len() && stable.starts_with(&l.confirmed) {
        let delta = stable[l.confirmed.len()..].to_string();
        let n = delta.chars().count();
        crate::inject::inject_text_delta(&delta);
        LIVE_INJECTED.fetch_add(n, Ordering::Relaxed);
        l.confirmed = stable;
    }
}

/// Reconcile the live-typed text with the server's authoritative final: backspace
/// whatever we typed past their common prefix, then type the remaining tail — so
/// the target ends with EXACTLY the final transcript. Usually the common prefix
/// is everything we typed, so this just appends the tail.
fn live_reconcile(l: &Live, final_text: &str) {
    let common: String = l
        .confirmed
        .chars()
        .zip(final_text.chars())
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a)
        .collect();
    let to_delete = l
        .confirmed
        .chars()
        .count()
        .saturating_sub(common.chars().count());
    if to_delete > 0 {
        crate::inject::inject_backspaces(to_delete);
    }
    let tail = &final_text[common.len()..];
    if !tail.is_empty() {
        crate::inject::inject_text_delta(tail);
        LIVE_INJECTED.fetch_add(tail.chars().count(), Ordering::Relaxed);
    }
}

const FEED_TICK: Duration = Duration::from_millis(150);
const READ_TIMEOUT: Duration = Duration::from_millis(30);
const READY_DEADLINE: Duration = Duration::from_secs(10);
/// Final = quality decode + optional AI cleanup (Claude) — generous ceiling.
const FINAL_DEADLINE: Duration = Duration::from_secs(90);

/// Begin a streaming session for the recording that `do_start` just opened.
/// Cloud mode only; no-op otherwise. Replaces any previous session.
pub fn start(app: &AppHandle, live: bool) {
    let state = app.state::<AppState>();
    if state.config.lock().mode != "subunit" {
        return; // local engine has no streaming backend (yet)
    }
    cancel(); // a stale session must never outlive its recording
    LIVE_INJECTED.store(0, Ordering::Relaxed); // fresh per-session live-typing counter

    let (ctl_tx, ctl_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    *ACTIVE.lock() = Some(Session { ctl_tx, done_rx });

    let app = app.clone();
    std::thread::Builder::new()
        .name("echo-stream".into())
        .spawn(move || session_thread(app, ctl_rx, done_tx, live))
        .ok();
}

/// Drop the running session (key never released properly, scene unmounted).
/// The server keeps nothing; the local recording stays untouched.
pub fn cancel() {
    if let Some(s) = ACTIVE.lock().take() {
        let _ = s.ctl_tx.send(Ctl::Cancel);
    }
}

/// Flush the tail, stop the recorder, and wait for the server's final.
/// `None` → no session was running (caller takes the classic path).
pub fn finish() -> Option<Result<StreamFinal, StreamFailure>> {
    let s = ACTIVE.lock().take()?;
    if s.ctl_tx.send(Ctl::Finish).is_err() {
        return None; // thread already gone without reporting — classic path
    }
    match s.done_rx.recv_timeout(FINAL_DEADLINE + Duration::from_secs(5)) {
        Ok(r) => Some(r),
        Err(_) => Some(Err(StreamFailure {
            error: EngineError::new("network", "Streaming-Final nicht erhalten (Timeout)"),
            capture: None,
        })),
    }
}

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

fn session_thread(
    app: AppHandle,
    ctl_rx: mpsc::Receiver<Ctl>,
    done_tx: mpsc::Sender<Result<StreamFinal, StreamFailure>>,
    live: bool,
) {
    // Unavailable ⇒ report once and leave; the caller's fallback owns the take.
    let mut ws = match connect(&app) {
        Ok(ws) => ws,
        Err(e) => {
            log::info!("stream: unavailable ({}) — classic path will handle it", e.message);
            let _ = done_tx.send(Err(StreamFailure { error: e, capture: None }));
            return;
        }
    };
    log::info!("stream: connected, live partials on (live_typing={live})");

    // LocalAgreement state for "live" mode — None unless live typing is on.
    let mut live_state = if live {
        Some(Live { confirmed: String::new(), prev_partial: String::new() })
    } else {
        None
    };

    // Sent watermark in DOWNSAMPLED samples. The last 2 samples of every pass
    // are held back: the linear resampler's tail depends on samples that
    // haven't arrived yet, so only the stable prefix ever goes on the wire.
    let mut sent: usize = 0;

    loop {
        match ctl_rx.recv_timeout(FEED_TICK) {
            Ok(Ctl::Cancel) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = ws.send(Message::Text(r#"{"type":"cancel"}"#.into()));
                let _ = ws.close(None);
                return;
            }
            Ok(Ctl::Finish) => {
                let result = finish_flow(&app, &mut ws, &mut sent, live_state.as_mut());
                let _ = done_tx.send(result);
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Err(e) = feed_delta(&app, &mut ws, &mut sent, false) {
                    // Mid-stream break: the recording continues locally — hand
                    // the failure over and let finish() fall back classically.
                    log::warn!("stream: feed failed ({}) — degrading to classic", e.message);
                    let _ = done_tx.send(Err(StreamFailure { error: e, capture: None }));
                    return;
                }
                if let Err(e) = drain_partials(&app, &mut ws, live_state.as_mut()) {
                    log::warn!("stream: read failed ({}) — degrading to classic", e.message);
                    let _ = done_tx.send(Err(StreamFailure { error: e, capture: None }));
                    return;
                }
            }
        }
    }
}

/// Open the socket, authenticate, await `ready`.
fn connect(app: &AppHandle) -> Result<Ws, EngineError> {
    let state = app.state::<AppState>();
    if state.config.lock().mode == "subunit" {
        crate::auth::ensure_fresh(app);
    }
    let cfg = state.config.lock().clone();

    let url = cfg
        .subunit_endpoint
        .replace("https://", "wss://")
        .replace("http://", "ws://")
        .replace("/v1/transcribe", "/v1/dictate");
    let request = url
        .clone()
        .into_client_request()
        .map_err(|e| EngineError::new("internal", format!("bad stream url: {e}")))?;

    // Manual TCP connect so we control the timeout (the default OS connect
    // can hang for over a minute on a dead route).
    let host = request.uri().host().unwrap_or_default().to_string();
    let port = request.uri().port_u16().unwrap_or(443);
    let addr = (host.as_str(), port);
    let tcp = std::net::TcpStream::connect_timeout(
        &resolve(addr).ok_or_else(|| EngineError::new("network", "DNS-Auflösung fehlgeschlagen"))?,
        Duration::from_secs(5),
    )
    .map_err(|e| EngineError::new("network", format!("Stream-Verbindung: {e}")))?;
    let _ = tcp.set_nodelay(true);
    // Bound EVERY socket op from here on. Without these, a peer that accepts
    // TCP and then stalls (hung origin behind an edge, Wi-Fi dying right after
    // connect) wedges the TLS handshake or a read/write FOREVER — the user
    // would sit on a frozen "transcribing" with the mic indicator still on
    // until finish()'s 95 s deadline. With 5 s ops, every wedge is short.
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(5)));
    // The handshake sees the read timeout as WouldBlock → Interrupted; retry
    // against an overall deadline instead of failing on the first tick.
    let deadline = Instant::now() + READY_DEADLINE;
    let mut pending = tungstenite::client_tls(request, tcp);
    let (mut ws, _resp) = loop {
        match pending {
            Ok(ok) => break ok,
            Err(tungstenite::HandshakeError::Interrupted(mid)) => {
                if Instant::now() > deadline {
                    return Err(EngineError::new("network", "Stream-Handshake Timeout"));
                }
                pending = mid.handshake();
            }
            Err(tungstenite::HandshakeError::Failure(e)) => {
                return Err(EngineError::new("network", format!("Stream-Handshake: {e}")));
            }
        }
    };

    // Hello: same credentials + knobs as /v1/transcribe. Resolve the cleanup
    // style EXACTLY like the batch path (commands::do_transcribe) so streaming
    // does not silently bypass Auto-Mode: with auto-mode on, pick the style from
    // the window captured at record-start (do_start ran before this connect), so
    // the server applies the right per-app style inline and per-app switching
    // keeps working with streaming on (the default). Long-form re-selection still
    // only happens on the batch path — long recordings aren't the streaming case.
    let style = if cfg.cleanup_enabled {
        let resolved = if cfg.cleanup_auto_mode {
            let (app_name, title) = {
                let t = state.target.lock();
                (
                    t.as_ref().map(|t| t.app.clone()).unwrap_or_default(),
                    t.as_ref().map(|t| t.title.clone()).unwrap_or_default(),
                )
            };
            crate::auto_mode::pick_style(&app_name, &title, &cfg.auto_mode_overrides, &cfg.cleanup_style).0
        } else {
            cfg.cleanup_style.clone()
        };
        if resolved != "raw" {
            resolved
        } else {
            String::new()
        }
    } else {
        String::new()
    };
    let hello = serde_json::json!({
        "token": cfg.subunit_access_token,
        "api_key": cfg.subunit_api_key,
        "language": cfg.language,
        "quality_mode": cfg.cloud_quality_mode,
        "prompt": vocab::vocab_prompt(&cfg),
        "cleanup_style": style,
    });
    ws.send(Message::Text(hello.to_string()))
        .map_err(|e| EngineError::new("network", format!("Stream-Hello: {e}")))?;

    // Await ready. The 5 s socket read timeout shows up as WouldBlock — treat
    // it as a deadline tick, not an error.
    loop {
        if Instant::now() > deadline {
            return Err(EngineError::new("network", "Stream-Server antwortet nicht (ready)"));
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                match v.get("type").and_then(|t| t.as_str()) {
                    Some("ready") => break,
                    Some("error") => {
                        // The server names the rejection class in `code` so the
                        // caller can route paywall vs re-login vs retry.
                        let code = v
                            .get("code")
                            .and_then(|c| c.as_str())
                            .unwrap_or("auth")
                            .to_string();
                        let detail = v
                            .get("detail")
                            .and_then(|d| d.as_str())
                            .unwrap_or("Stream abgelehnt")
                            .to_string();
                        return Err(EngineError::new(&code, detail));
                    }
                    _ => continue,
                }
            }
            Ok(Message::Close(frame)) => {
                let code = frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(0);
                let kind = match code {
                    4001 => "auth",
                    4002 => "trial_expired",
                    _ => "network",
                };
                return Err(EngineError::new(kind, format!("Stream geschlossen ({code})")));
            }
            Ok(_) => continue,
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue; // deadline tick
            }
            Err(e) => return Err(EngineError::new("network", format!("Stream-Ready: {e}"))),
        }
    }

    set_read_timeout(&mut ws, READ_TIMEOUT);
    Ok(ws)
}

fn resolve(addr: (&str, u16)) -> Option<std::net::SocketAddr> {
    use std::net::ToSocketAddrs;
    addr.to_socket_addrs().ok()?.next()
}

fn set_read_timeout(ws: &mut Ws, t: Duration) {
    match ws.get_ref() {
        MaybeTlsStream::Plain(s) => {
            let _ = s.set_read_timeout(Some(t));
        }
        MaybeTlsStream::Rustls(s) => {
            let _ = s.sock.set_read_timeout(Some(t));
        }
        _ => {}
    }
}

/// Snapshot the recorder, downsample, and send everything past the watermark.
/// `flush` sends the full tail (release); otherwise the last 2 samples are
/// held back for resampler determinism.
fn feed_delta(
    app: &AppHandle,
    ws: &mut Ws,
    sent: &mut usize,
    flush: bool,
) -> Result<(), EngineError> {
    let state = app.state::<AppState>();
    let Some(cap) = state.recorder.snapshot() else {
        return Ok(()); // recorder not live yet — next tick
    };
    let (down, _) = super::downsample_to_16k(&cap.samples, cap.sample_rate);
    let stable = if flush { down.len() } else { down.len().saturating_sub(2) };
    if stable <= *sent {
        return Ok(());
    }
    let mut bytes = Vec::with_capacity((stable - *sent) * 2);
    for &s in &down[*sent..stable] {
        bytes.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    *sent = stable;
    ws.send(Message::Binary(bytes))
        .map_err(|e| EngineError::new("network", format!("Stream-Audio: {e}")))
}

/// Read every pending message; emit partials to the UI. Non-blocking via the
/// socket read timeout.
fn drain_partials(
    app: &AppHandle,
    ws: &mut Ws,
    mut live: Option<&mut Live>,
) -> Result<(), EngineError> {
    loop {
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                if v.get("type").and_then(|t| t.as_str()) == Some("partial") {
                    if let Some(text) = v.get("text").and_then(|t| t.as_str()) {
                        let _ = app.emit("echo://stream-partial", text.to_string());
                        // Live mode: type the newly-stable prefix into the target.
                        if let Some(l) = live.as_deref_mut() {
                            live_commit(l, text);
                        }
                    }
                }
            }
            Ok(Message::Close(_)) => {
                return Err(EngineError::new("network", "Stream-Server hat geschlossen"));
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Ok(()); // nothing pending
            }
            Err(e) => return Err(EngineError::new("network", format!("Stream-Lesen: {e}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tungstenite::Message;

    /// Protocol smoke against a `/v1/dictate` server. By default it targets a
    /// LOCAL instance of the real dictate_ws.py with a stubbed model
    /// (`ECHO_DICTATE_TEST_URL=ws://127.0.0.1:8899/v1/dictate`); pointed at
    /// the public endpoint it also exercises edge TLS + real auth (reads this
    /// machine's Echo config at runtime — the credential is never printed).
    /// Ignored by default: `cargo test -- --ignored dictate_ws --nocapture`
    #[test]
    #[ignore]
    fn dictate_ws_protocol_smoke() {
        let (endpoint, token, api_key) = match std::env::var("ECHO_DICTATE_TEST_URL") {
            Ok(url) => (url, String::new(), "test-key".to_string()),
            Err(_) => {
                let cfg_path = crate::config::config_file();
                let raw = match std::fs::read_to_string(&cfg_path) {
                    Ok(r) => r,
                    Err(_) => {
                        println!("SKIP: no echo config at {cfg_path:?}");
                        return;
                    }
                };
                let cfg: serde_json::Value = serde_json::from_str(&raw).expect("config json");
                let token = cfg["subunit_access_token"].as_str().unwrap_or_default();
                let api_key = cfg["subunit_api_key"].as_str().unwrap_or_default();
                if token.is_empty() && api_key.is_empty() {
                    println!("SKIP: not signed in");
                    return;
                }
                let url = cfg["subunit_endpoint"]
                    .as_str()
                    .unwrap_or("https://transcribe.subunit.ai/v1/transcribe")
                    .replace("https://", "wss://")
                    .replace("/v1/transcribe", "/v1/dictate");
                (url, token.to_string(), api_key.to_string())
            }
        };

        let (mut ws, _) = tungstenite::connect(&endpoint).expect("connect");
        ws.send(Message::Text(
            serde_json::json!({
                "token": token, "api_key": api_key,
                "language": "de", "quality_mode": "instant", "cleanup_style": "tidy",
            })
            .to_string(),
        ))
        .expect("hello");
        let ready: serde_json::Value = match ws.read().expect("ready frame") {
            Message::Text(t) => serde_json::from_str(&t).unwrap(),
            other => panic!("expected text, got {other:?}"),
        };
        assert_eq!(ready["type"], "ready", "ready frame: {ready}");
        println!("DICTATE_WS ready ok");

        // ~2.5 s of speech-band chirp in 0.5 s chunks (mirrors feed_delta).
        let tone: Vec<u8> = (0..(16_000.0 * 2.5) as usize)
            .flat_map(|i| {
                let t = i as f32 / 16_000.0;
                let v = 0.3 * (2.0 * std::f32::consts::PI * 220.0 * t).sin()
                    * (0.5 + 0.5 * (i as f32 / 800.0).sin());
                ((v * 32767.0) as i16).to_le_bytes()
            })
            .collect();
        for chunk in tone.chunks(16_000) {
            ws.send(Message::Binary(chunk.to_vec())).expect("audio");
            std::thread::sleep(Duration::from_millis(100));
        }
        ws.send(Message::Text(r#"{"type":"end"}"#.into())).expect("end");

        let mut partials = 0;
        loop {
            match ws.read().expect("frame") {
                Message::Text(t) => {
                    let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                    match v["type"].as_str() {
                        Some("partial") => partials += 1,
                        Some("final") => {
                            println!(
                                "DICTATE_WS final ok: partials={partials} duration={} tier={} chars={}",
                                v["duration_s"], v["quality_mode"],
                                v["text"].as_str().map(|s| s.chars().count()).unwrap_or(0)
                            );
                            return;
                        }
                        other => panic!("unexpected frame type {other:?}: {v}"),
                    }
                }
                Message::Close(c) => panic!("closed before final: {c:?}"),
                _ => {}
            }
        }
    }
}

/// Release path: flush the tail, send `end`, stop the recorder (audio already
/// lives server-side), await the final. The stopped capture rides along on
/// every failure so the caller can fall back to the classic upload.
fn finish_flow(
    app: &AppHandle,
    ws: &mut Ws,
    sent: &mut usize,
    mut live: Option<&mut Live>,
) -> Result<StreamFinal, StreamFailure> {
    let flush_result = feed_delta(app, ws, sent, true)
        .and_then(|()| {
            ws.send(Message::Text(r#"{"type":"end"}"#.into()))
                .map_err(|e| EngineError::new("network", format!("Stream-End: {e}")))
        });

    // Mic off NOW — the user released the key; nothing more to capture either way.
    let state = app.state::<AppState>();
    let capture = state.recorder.stop();

    if let Err(error) = flush_result {
        return Err(StreamFailure { error, capture });
    }

    let deadline = Instant::now() + FINAL_DEADLINE;
    loop {
        if Instant::now() > deadline {
            return Err(StreamFailure {
                error: EngineError::new("network", "Stream-Final Timeout"),
                capture,
            });
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                match v.get("type").and_then(|t| t.as_str()) {
                    Some("final") => {
                        let text = v
                            .get("text")
                            .and_then(|t| t.as_str())
                            .unwrap_or_default()
                            .to_string();
                        let cleaned_text = v
                            .get("cleaned_text")
                            .and_then(|t| t.as_str())
                            .filter(|s| !s.trim().is_empty())
                            .map(|s| s.to_string());
                        let quality_mode = v
                            .get("quality_mode")
                            .and_then(|t| t.as_str())
                            .unwrap_or("cloud-stream")
                            .to_string();
                        let duration_s =
                            v.get("duration_s").and_then(|d| d.as_f64()).unwrap_or(0.0);
                        let cleanup_status = v
                            .get("cleanup_status")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string());
                        let _ = ws.close(None);
                        // Live mode: reconcile what we typed during speech with the
                        // authoritative final (backspace any divergent tail, type the
                        // rest) so the target ends with EXACTLY the final transcript.
                        let already_injected = if let Some(l) = live.as_deref_mut() {
                            live_reconcile(l, &text);
                            true
                        } else {
                            false
                        };
                        return Ok(StreamFinal {
                            text,
                            cleaned_text,
                            quality_mode,
                            duration_s,
                            cleanup_status,
                            already_injected,
                        });
                    }
                    Some("partial") => {
                        // Late lookahead while the final computes — still useful.
                        if let Some(text) = v.get("text").and_then(|t| t.as_str()) {
                            let _ = app.emit("echo://stream-partial", text.to_string());
                        }
                    }
                    Some("error") => {
                        let code = v
                            .get("code")
                            .and_then(|c| c.as_str())
                            .unwrap_or("server")
                            .to_string();
                        let detail = v
                            .get("detail")
                            .and_then(|d| d.as_str())
                            .unwrap_or("Stream-Fehler")
                            .to_string();
                        return Err(StreamFailure {
                            error: EngineError::new(&code, detail),
                            capture,
                        });
                    }
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => {
                return Err(StreamFailure {
                    error: EngineError::new("network", "Stream vor Final geschlossen"),
                    capture,
                });
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => {
                return Err(StreamFailure {
                    error: EngineError::new("network", format!("Stream-Final: {e}")),
                    capture,
                });
            }
        }
    }
}
