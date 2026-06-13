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

// ── Live-typing debug capture (opt-in via ECHO_LIVE_DEBUG=1) ─────────────────
// When set, a streamed dictation records every partial (timestamped) + the final
// and writes a replayable fixture to <config>/livetest/<unix_ms>.json — turning a
// REAL dictation into a regression/latency fixture for the offline test harness
// (livetest_replay), captured with the app's own fresh auth. Off = two cheap
// no-op checks per partial; nothing written. Runs on the per-session stream thread,
// so a thread-local needs no locking.
struct DebugRec {
    start: Instant,
    partials: Vec<(u64, String, String)>, // (t_ms, partial_text, server committed prefix)
}
thread_local! {
    static DBG: std::cell::RefCell<Option<DebugRec>> = const { std::cell::RefCell::new(None) };
}
fn dbg_begin() {
    if std::env::var_os("ECHO_LIVE_DEBUG").is_some() {
        DBG.with(|d| *d.borrow_mut() = Some(DebugRec { start: Instant::now(), partials: Vec::new() }));
    }
}
fn dbg_partial(text: &str, committed: Option<&str>) {
    DBG.with(|d| {
        if let Some(r) = d.borrow_mut().as_mut() {
            let t = r.start.elapsed().as_millis() as u64;
            r.partials.push((t, text.to_string(), committed.unwrap_or_default().to_string()));
        }
    });
}
fn dbg_finish(final_text: &str) {
    DBG.with(|d| {
        let Some(r) = d.borrow_mut().take() else { return };
        let t_final = r.start.elapsed().as_millis() as u64;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let Some(dir) = crate::config::config_file().parent().map(|p| p.join("livetest")) else {
            return;
        };
        let _ = std::fs::create_dir_all(&dir);
        let fixture = serde_json::json!({
            "final": final_text,
            "t_final_ms": t_final,
            "partials": r.partials.iter().map(|(t, s, c)| serde_json::json!({"t_ms": t, "text": s, "committed": c})).collect::<Vec<_>>(),
        });
        let path = dir.join(format!("{ts}.json"));
        if std::fs::write(&path, serde_json::to_string_pretty(&fixture).unwrap_or_default()).is_ok() {
            log::info!("live-debug: fixture written ({} partials) {path:?}", r.partials.len());
        }
    });
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

/// A live partial arrived — steer the typed text toward its agreed-stable prefix.
/// Crucially this must NOT freeze when the server revises already-typed text
/// (e.g. inserts a comma / recases a word once the tail settles): the old
/// "append only if `stable` still starts with `confirmed`" guard stalled there
/// and dumped the remainder late at finish ("breaks after the comma"). We now
/// reconcile toward the stable text on every partial instead (bounded — see
/// `apply_target`), so typing keeps flowing.
fn live_commit(l: &mut Live, cur: &str, committed: Option<&str>) {
    // Type the LONGER of two stable targets:
    //  - agreed-stable (client LocalAgreement): the common prefix of two consecutive
    //    partials, trimmed to a word boundary. Tracks ~1 word behind live speech, so
    //    it flows continuously WITHOUT needing a pause.
    //  - the server's committed prefix: final-quality and FROZEN (only ever extended),
    //    but it ONLY advances at VAD silence boundaries — through a long run-on
    //    sentence it stays put for many seconds (that was the freeze: first chunk
    //    typed, then nothing until the next pause / the final).
    // Whichever is longer wins: agreed-stable keeps typing during continuous speech,
    // committed leaps ahead with quality-corrected text at pauses. plan_target bounds
    // any divergence (small recase/comma → ≤MAX_REWRITE rewrite; large mid-sentence →
    // wait, then append-only at the final) so this never wild-deletes.
    let ag = agreed_stable(&l.prev_partial, cur);
    let target = match committed {
        Some(c) if c.chars().count() > ag.chars().count() => c.to_string(),
        _ => ag,
    };
    l.prev_partial = cur.to_string();
    if !target.is_empty() {
        apply_target(l, &target, false);
    }
}

/// Largest trailing divergence we will REWRITE (backspace + retype). Backspacing
/// is destructive — it eats whatever sits at the caret — so we cap it hard. A
/// pure extension deletes nothing; a small last-word/punctuation refinement is
/// rewritten; anything larger is handled without a purge (append-only at finish,
/// or simply waited out mid-stream). This is what stops the "wild delete".
const MAX_REWRITE: usize = 24;

/// One injection step the live path will perform at the caret.
#[derive(Debug, PartialEq)]
enum LiveOp {
    /// Delete this many characters (flag-zeroed Backspaces — never word-deletes).
    Backspace(usize),
    /// Type this string at the caret.
    Type(String),
}

/// PURE decision: how to steer already-typed `confirmed` toward `target` (the
/// authoritative text so far), returning the ops to perform and the resulting
/// on-screen text. No I/O — unit-tested below. NEVER mass-deletes.
///
/// - Pure extension (`target` starts with what we typed): append the new tail, no delete.
/// - `target` shorter (a prefix of `confirmed`): at finish, trim the extra (bounded);
///   mid-stream WAIT — a transient shorter partial must not shrink the text.
/// - Genuine middle divergence: if the diverging tail is short (≤ MAX_REWRITE),
///   backspace+retype it (fixes a recase/comma — this is what unfreezes "stuck
///   after the comma"); if large, append-only at finish, else WAIT mid-stream.
fn plan_target(confirmed: &str, target: &str, is_final: bool) -> (Vec<LiveOp>, String) {
    if target == confirmed {
        return (vec![], confirmed.to_string());
    }
    if confirmed.is_empty() {
        return (vec![LiveOp::Type(target.to_string())], target.to_string());
    }
    let confirmed_n = confirmed.chars().count();

    // Pure extension — the common case. Append only the new suffix.
    if target.starts_with(confirmed) {
        let tail: String = target.chars().skip(confirmed_n).collect();
        return (vec![LiveOp::Type(tail)], target.to_string());
    }

    // `target` is a prefix of what we typed (it got shorter).
    if confirmed.starts_with(target) {
        let to_delete = confirmed_n - target.chars().count();
        if is_final && to_delete <= MAX_REWRITE {
            return (vec![LiveOp::Backspace(to_delete)], target.to_string());
        }
        return (vec![], confirmed.to_string()); // mid-stream: wait
    }

    // Genuine middle divergence (recased word, inserted punctuation, …).
    let common = confirmed
        .chars()
        .zip(target.chars())
        .take_while(|(a, b)| a == b)
        .count();
    let to_delete = confirmed_n - common;
    if to_delete <= MAX_REWRITE {
        let tail: String = target.chars().skip(common).collect();
        let mut ops = Vec::new();
        if to_delete > 0 {
            ops.push(LiveOp::Backspace(to_delete));
        }
        if !tail.is_empty() {
            ops.push(LiveOp::Type(tail));
        }
        return (ops, target.to_string());
    }
    if is_final {
        // Large divergence at finish → append-only, word-aligned (no purge, no dup).
        let typed_words = confirmed.split_whitespace().count();
        let extra = target
            .split_whitespace()
            .skip(typed_words)
            .collect::<Vec<_>>()
            .join(" ");
        if !extra.is_empty() {
            let out = format!(" {extra}"); // `confirmed` never ends in whitespace
            let new_confirmed = format!("{confirmed}{out}");
            return (vec![LiveOp::Type(out)], new_confirmed);
        }
    }
    // mid-stream large divergence: wait — a later partial usually re-aligns.
    (vec![], confirmed.to_string())
}

/// Apply `plan_target`'s decision through the real injector and update state.
fn apply_target(l: &mut Live, target: &str, is_final: bool) {
    let (ops, new_confirmed) = plan_target(&l.confirmed, target, is_final);
    for op in ops {
        match op {
            LiveOp::Backspace(n) => crate::inject::inject_backspaces(n),
            LiveOp::Type(s) => {
                let n = s.chars().count();
                crate::inject::inject_text_delta(&s);
                LIVE_INJECTED.fetch_add(n, Ordering::Relaxed);
            }
        }
    }
    l.confirmed = new_confirmed;
}

/// Finish-time reconcile against the server's authoritative final.
fn live_reconcile(l: &mut Live, final_text: &str) {
    apply_target(l, final_text, true);
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
    dbg_begin(); // opt-in fixture capture (ECHO_LIVE_DEBUG)

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
                        let committed = v.get("committed").and_then(|c| c.as_str());
                        dbg_partial(text, committed);
                        // Live mode: type the server's committed (frozen) prefix.
                        if let Some(l) = live.as_deref_mut() {
                            live_commit(l, text, committed);
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

    // ── live-typing reconcile planner (plan_target) ──────────────────────────

    #[test]
    fn plan_first_text_from_empty() {
        let (ops, c) = plan_target("", "Hallo", false);
        assert_eq!(ops, vec![LiveOp::Type("Hallo".into())]);
        assert_eq!(c, "Hallo");
    }

    #[test]
    fn plan_pure_extension_appends_only() {
        let (ops, c) = plan_target("So ist", "So ist die", false);
        assert_eq!(ops, vec![LiveOp::Type(" die".into())]);
        assert_eq!(c, "So ist die");
    }

    #[test]
    fn plan_noop_when_equal() {
        let (ops, c) = plan_target("So ist die", "So ist die", false);
        assert!(ops.is_empty());
        assert_eq!(c, "So ist die");
    }

    /// THE bug: the final inserted a comma into already-typed text. Old code
    /// froze (no starts_with); now we backspace the short tail and retype it.
    #[test]
    fn plan_comma_revision_rewrites_short_tail_live() {
        let (ops, c) = plan_target("So ist die Bude", "So ist die, Bude", false);
        // common prefix "So ist die" = 10 chars → delete " Bude" (5), type ", Bude".
        assert_eq!(
            ops,
            vec![LiveOp::Backspace(5), LiveOp::Type(", Bude".into())]
        );
        assert_eq!(c, "So ist die, Bude");
    }

    #[test]
    fn plan_shorter_partial_waits_midstream() {
        // A transient shorter partial must NOT shrink the typed text mid-stream.
        let (ops, c) = plan_target("So ist die Bude", "So ist die", false);
        assert!(ops.is_empty());
        assert_eq!(c, "So ist die Bude");
    }

    #[test]
    fn plan_shorter_final_trims() {
        let (ops, c) = plan_target("So ist die Bude", "So ist die", true);
        assert_eq!(ops, vec![LiveOp::Backspace(5)]);
        assert_eq!(c, "So ist die");
    }

    #[test]
    fn plan_large_early_divergence_waits_midstream() {
        // Long text, diverges at char 0 (recase) → too big to rewrite mid-stream.
        let confirmed = "hallo wie geht es dir und so weiter heute";
        let target = "Hallo wie geht es dir und so weiter heute";
        let (ops, c) = plan_target(confirmed, target, false);
        assert!(ops.is_empty(), "must wait, not carpet-bomb: {ops:?}");
        assert_eq!(c, confirmed);
    }

    #[test]
    fn plan_large_early_divergence_appends_at_finish() {
        // Same big early divergence, but at finish → append only the new words.
        let confirmed = "hallo wie geht es dir und so weiter heute"; // 9 words
        let target = "Hallo wie geht es dir und so weiter heute noch mehr";
        let (ops, c) = plan_target(confirmed, target, true);
        assert_eq!(ops, vec![LiveOp::Type(" noch mehr".into())]);
        assert_eq!(c, format!("{confirmed} noch mehr"));
    }

    // ── Live-typing test center ─────────────────────────────────────────────
    // Replay REAL speech through the REAL reconcile logic (agreed_stable +
    // plan_target) into a simulated buffer, so live-typing correctness + stall +
    // wild-delete can be checked WITHOUT a human dictating. `livetest_capture`
    // streams an audio file to the server and saves a fixture; `livetest_replay`
    // and the committed-fixture regression test run the logic offline.

    /// Run the actual client reconcile logic over a captured partial stream into
    /// a simulated text buffer and print a report. Returns (live_result, stats).
    /// The on-screen buffer is always == the planner's `confirmed` by construction,
    /// so `confirmed` IS the simulated buffer.
    fn livetest_analyze(partials: &[(u64, String, String)], final_text: &str) -> (String, usize, u64) {
        let mut confirmed = String::new();
        let mut prev = String::new();
        let (mut total_bs, mut max_bs, mut rewrites, mut typed) = (0usize, 0usize, 0usize, 0usize);
        let mut last_progress = partials.first().map(|p| p.0).unwrap_or(0);
        let mut max_gap: u64 = 0;
        // Server cadence: biggest gap between consecutive partial ARRIVALS. If this
        // is large, the freeze is the server withholding stable text (tail guard),
        // not the client logic.
        let mut max_partial_gap: u64 = 0;
        let mut prev_t = partials.first().map(|p| p.0).unwrap_or(0);
        let mut timeline: Vec<String> = Vec::new();
        let mut apply = |ops: &[LiveOp]| {
            for op in ops {
                match op {
                    LiveOp::Backspace(n) => {
                        total_bs += n;
                        max_bs = max_bs.max(*n);
                        rewrites += 1;
                    }
                    LiveOp::Type(s) => typed += s.chars().count(),
                }
            }
        };
        for (t, cur, committed) in partials {
            max_partial_gap = max_partial_gap.max(t.saturating_sub(prev_t));
            prev_t = *t;
            // Mirror live_commit: type the LONGER of agreed-stable and the server's
            // committed prefix. agreed-stable tracks ~1 word behind live speech (fast,
            // no pause needed); committed is final-quality but only advances at VAD
            // pauses (it would freeze through long run-on sentences). The longer wins:
            // fast during continuous speech, quality-corrected at pauses.
            let ag = agreed_stable(&prev, cur);
            let target = if committed.chars().count() > ag.chars().count() {
                committed.clone()
            } else {
                ag
            };
            prev = cur.clone();
            if target.is_empty() {
                continue;
            }
            let (ops, newc) = plan_target(&confirmed, &target, false);
            if ops.is_empty() {
                max_gap = max_gap.max(t.saturating_sub(last_progress));
            } else {
                let typed_now: usize = ops
                    .iter()
                    .map(|o| match o {
                        LiveOp::Type(s) => s.chars().count(),
                        LiveOp::Backspace(_) => 0,
                    })
                    .sum();
                timeline.push(format!("  {t:>6}ms  +{typed_now:>3} → {newc:?}"));
                last_progress = *t;
                apply(&ops);
            }
            confirmed = newc;
        }
        let (ops, newc) = plan_target(&confirmed, final_text, true);
        apply(&ops);
        confirmed = newc;

        let exact = confirmed == final_text;
        println!("── live-typing replay report ──");
        println!("partials      : {}", partials.len());
        println!("server final  : {final_text:?}");
        println!("live result   : {confirmed:?}");
        println!("EXACT MATCH   : {exact}");
        println!("max SERVER gap (between partial arrivals)          : {max_partial_gap} ms  ← freeze if large = server tail-guard");
        println!("max CLIENT gap (partials arriving, nothing typed)  : {max_gap} ms  ← freeze if large = client logic");
        println!("backspaces    : total={total_bs} max_single={max_bs} rewrites={rewrites} typed_chars={typed}");
        println!("── typing timeline (when text actually grew) ──");
        for line in &timeline {
            println!("{line}");
        }
        // Regression guard: a single backspace must never exceed the rewrite cap
        // (that was the "wild delete" — purging the whole line at finish).
        assert!(max_bs <= MAX_REWRITE, "WILD DELETE: single backspace {max_bs} > cap {MAX_REWRITE}");
        (confirmed, max_bs, max_gap)
    }

    /// Stream a 16 kHz s16le mono PCM file to /v1/dictate in real-time 150 ms
    /// chunks, capture every partial (timestamped) + the final, save a JSON
    /// fixture, and print the replay report. Reads creds from this machine's Echo
    /// config (credential never printed). Run:
    ///   ECHO_LIVE_AUDIO=/path/x.pcm ECHO_LIVE_FIXTURE=out.json \
    ///     cargo test --lib -- --ignored livetest_capture --nocapture
    #[test]
    #[ignore]
    fn livetest_capture() {
        let Ok(audio_path) = std::env::var("ECHO_LIVE_AUDIO") else {
            println!("SKIP: set ECHO_LIVE_AUDIO=<16k s16le mono pcm>");
            return;
        };
        let fixture_path =
            std::env::var("ECHO_LIVE_FIXTURE").unwrap_or_else(|_| "/tmp/echo-livetest.json".into());
        let pcm = std::fs::read(&audio_path).expect("read audio pcm");
        println!("audio: {audio_path} ({} bytes ≈ {:.1}s @16k)", pcm.len(), pcm.len() as f64 / 32000.0);

        let cfg_path = crate::config::config_file();
        let cfg: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&cfg_path).expect("echo config"))
                .expect("config json");
        let token = cfg["subunit_access_token"].as_str().unwrap_or_default().to_string();
        let api_key = cfg["subunit_api_key"].as_str().unwrap_or_default().to_string();
        if token.is_empty() && api_key.is_empty() {
            println!("SKIP: not signed in");
            return;
        }
        let endpoint = cfg["subunit_endpoint"]
            .as_str()
            .unwrap_or("https://transcribe.subunit.ai/v1/transcribe")
            .replace("https://", "wss://")
            .replace("/v1/transcribe", "/v1/dictate");

        let (mut ws, _) = tungstenite::connect(&endpoint).expect("connect");
        ws.send(Message::Text(
            serde_json::json!({
                "token": token, "api_key": api_key, "language": "de",
                "quality_mode": "quality", "cleanup_style": "",
            })
            .to_string(),
        ))
        .expect("hello");
        loop {
            match ws.read().expect("ready") {
                Message::Text(t) => {
                    let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                    if v["type"] == "ready" {
                        break;
                    }
                    if v["type"] == "error" {
                        // Expired/!auth token → skip, don't fail (use the app's fresh
                        // auth via ECHO_LIVE_DEBUG capture instead, or dictate to refresh).
                        println!("SKIP: server rejected ({}) — token likely expired; dictate once in Echo to refresh, then re-run", v["code"]);
                        return;
                    }
                }
                other => panic!("expected text, got {other:?}"),
            }
        }
        set_read_timeout(&mut ws, Duration::from_millis(5));

        let start = Instant::now();
        let mut partials: Vec<(u64, String, String)> = Vec::new();
        let record = |ws: &mut Ws, partials: &mut Vec<(u64, String, String)>, window: Duration| -> Option<String> {
            let until = Instant::now() + window;
            loop {
                if Instant::now() >= until {
                    return None;
                }
                match ws.read() {
                    Ok(Message::Text(t)) => {
                        let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                        match v["type"].as_str() {
                            Some("partial") => {
                                if let Some(s) = v["text"].as_str() {
                                    partials.push((
                                        start.elapsed().as_millis() as u64,
                                        s.to_string(),
                                        v["committed"].as_str().unwrap_or_default().to_string(),
                                    ));
                                }
                            }
                            Some("final") => {
                                return Some(v["text"].as_str().unwrap_or_default().to_string());
                            }
                            _ => {}
                        }
                    }
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(e))
                        if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                    Err(e) => panic!("read: {e}"),
                }
            }
        };

        // 150 ms of 16k s16le mono = 4800 bytes. Feed in real time, draining partials.
        for chunk in pcm.chunks(4800) {
            ws.send(Message::Binary(chunk.to_vec())).expect("audio");
            record(&mut ws, &mut partials, Duration::from_millis(150));
        }
        let t_end_ms = start.elapsed().as_millis() as u64;
        ws.send(Message::Text(r#"{"type":"end"}"#.into())).expect("end");
        let final_text = loop {
            if let Some(f) = record(&mut ws, &mut partials, Duration::from_millis(500)) {
                break f;
            }
            if start.elapsed() > Duration::from_secs(90) {
                panic!("no final within 90s");
            }
        };
        let t_final_ms = start.elapsed().as_millis() as u64;
        println!("stream: {} partials, release@{t_end_ms}ms, final@{t_final_ms}ms (release→final {}ms)", partials.len(), t_final_ms - t_end_ms);

        let fixture = serde_json::json!({
            "audio": audio_path,
            "final": final_text,
            "t_end_ms": t_end_ms,
            "t_final_ms": t_final_ms,
            "partials": partials.iter().map(|(t, s, c)| serde_json::json!({"t_ms": t, "text": s, "committed": c})).collect::<Vec<_>>(),
        });
        std::fs::write(&fixture_path, serde_json::to_string_pretty(&fixture).unwrap()).expect("write fixture");
        println!("fixture saved: {fixture_path}");

        livetest_analyze(&partials, &final_text);
    }

    /// Replay a saved fixture through the reconcile logic — OFFLINE (no server).
    /// `ECHO_LIVE_FIXTURE=out.json cargo test --lib -- --ignored livetest_replay --nocapture`
    #[test]
    #[ignore]
    fn livetest_replay() {
        let path = std::env::var("ECHO_LIVE_FIXTURE").unwrap_or_else(|_| "/tmp/echo-livetest.json".into());
        let Ok(raw) = std::fs::read_to_string(&path) else {
            println!("SKIP: no fixture at {path}");
            return;
        };
        let v: serde_json::Value = serde_json::from_str(&raw).expect("fixture json");
        let final_text = v["final"].as_str().unwrap_or_default().to_string();
        let partials: Vec<(u64, String, String)> = v["partials"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .map(|p| {
                (
                    p["t_ms"].as_u64().unwrap_or(0),
                    p["text"].as_str().unwrap_or_default().to_string(),
                    p["committed"].as_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        livetest_analyze(&partials, &final_text);
    }

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
                        dbg_finish(&text); // write the opt-in fixture (ECHO_LIVE_DEBUG)
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
                            dbg_partial(text, v.get("committed").and_then(|c| c.as_str()));
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
