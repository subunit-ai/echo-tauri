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
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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
    /// Server-issued resume handle (from `ready`). When present, the server
    /// parks this session's audio (and possibly the computed final) for a
    /// short window after an abnormal drop — `resume_finish` can collect it
    /// over a fresh socket instead of re-uploading the whole take.
    pub resume_id: Option<String>,
}

/// What the server's `ready` frame announced for this connection.
#[derive(Default)]
struct ReadyInfo {
    /// Handle under which the server would park this session on a drop.
    resume_id: Option<String>,
    /// Resume only: bytes of 16 kHz s16le audio the server already holds —
    /// the client ships exactly the remainder.
    received_bytes: u64,
    /// Resume only: the final was already computed; the server replays it
    /// immediately — send nothing, just await it.
    final_ready: bool,
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

/// Live-injection generation. ONLY the newest session may type into the target.
/// `start` and `cancel` bump it; a session whose captured gen no longer matches
/// goes silent IMMEDIATELY (see `apply_target`). Without this, a just-cancelled
/// session whose thread is still mid-`feed_delta` kept injecting while the new
/// session also injected — on Windows the OS then interleaves the two `SendInput`
/// streams character-by-character, producing the garbled "two transcripts woven
/// together" output. Bumping the gen makes the stale session a no-op without the
/// latency of joining its thread.
static LIVE_GEN: AtomicU64 = AtomicU64::new(0);

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
    partials: Vec<(u64, String, String)>, // (t_ms, partial_text, server stable prefix)
}
thread_local! {
    static DBG: std::cell::RefCell<Option<DebugRec>> = const { std::cell::RefCell::new(None) };
}
fn dbg_begin() {
    if std::env::var_os("ECHO_LIVE_DEBUG").is_some() {
        DBG.with(|d| *d.borrow_mut() = Some(DebugRec { start: Instant::now(), partials: Vec::new() }));
    }
}
fn dbg_partial(text: &str, stable: Option<&str>) {
    DBG.with(|d| {
        if let Some(r) = d.borrow_mut().as_mut() {
            let t = r.start.elapsed().as_millis() as u64;
            r.partials.push((t, text.to_string(), stable.unwrap_or_default().to_string()));
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
            "partials": r.partials.iter().map(|(t, s, c)| serde_json::json!({"t_ms": t, "text": s, "stable": c})).collect::<Vec<_>>(),
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
    /// This session's injection generation; it may only type while it equals the
    /// global `LIVE_GEN` (i.e. it's still the newest session).
    gen: u64,
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

/// A live partial arrived — steer the typed text toward the server's word-level
/// `stable` prefix when present, else the client agreed-stable of two partials.
///
/// The server (Option 1) now accumulates an APPEND-ONLY word-level LocalAgreement
/// prefix and ships it as `stable`: a word joins once it survived two consecutive
/// decodes, compared case/punctuation-insensitively. That normalisation is the
/// key — it lets the whole-buffer COMMIT pass and the context-window LIVE pass
/// agree (they differ only in punctuation/casing of the overlap, which collapsed
/// the client's char-level agreed-stable and froze typing mid-sentence). `stable`
/// grows word-by-word even during a pauseless run-on and never shrinks, so typing
/// it is a near-pure append. Fallback to client agreed-stable for an older server
/// that doesn't send `stable`. Either way `plan_target`/`apply_target` bound any
/// divergence and never wild-delete; the release-time reconcile fixes residuals.
fn live_commit(l: &mut Live, cur: &str, stable: Option<&str>) {
    let target = match stable {
        Some(s) if !s.is_empty() => s.to_string(),
        Some(_) => return, // server sent an empty stable prefix → nothing to type yet
        None => agreed_stable(&l.prev_partial, cur),
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
    // Stale-session guard: a cancelled/superseded session must NEVER type into the
    // target (else two sessions' keystrokes interleave). Once a newer session has
    // started (or this one was cancelled), `LIVE_GEN` moved past our gen → go silent.
    if l.gen != LIVE_GEN.load(Ordering::SeqCst) {
        return;
    }
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
/// Liveness watchdog while awaiting the final: ping this often, and declare
/// the link dead after this much TOTAL silence (no partial, no pong, no
/// close). Pongs answer at the protocol layer even while the server decodes,
/// so real silence means the path is gone — fail in ~15 s and let the resume/
/// batch fallback act instead of sitting out the 90 s ceiling on a dead line.
const FINAL_PING_EVERY: Duration = Duration::from_secs(3);
const FINAL_SILENCE_DEADLINE: Duration = Duration::from_secs(15);
/// Resume ships raw 16 kHz PCM (32 KB/s). Above this tail size (~16 s of
/// missing audio) the Opus-compressed batch upload is the cheaper wire path.
const RESUME_MAX_TAIL_BYTES: usize = 512_000;

/// Begin a streaming session for the recording that `do_start` just opened.
/// Cloud mode only; no-op otherwise. Replaces any previous session.
pub fn start(app: &AppHandle, live: bool) {
    let state = app.state::<AppState>();
    if state.config.lock().mode != "subunit" {
        return; // local engine has no streaming backend (yet)
    }
    cancel(); // a stale session must never outlive its recording (also bumps LIVE_GEN)
    LIVE_INJECTED.store(0, Ordering::Relaxed); // fresh per-session live-typing counter
    // Claim the newest injection generation: only THIS session may now type.
    let gen = LIVE_GEN.fetch_add(1, Ordering::SeqCst) + 1;

    let (ctl_tx, ctl_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    *ACTIVE.lock() = Some(Session { ctl_tx, done_rx });

    let app = app.clone();
    std::thread::Builder::new()
        .name("echo-stream".into())
        .spawn(move || session_thread(app, ctl_rx, done_tx, live, gen))
        .ok();
}

/// Drop the running session (key never released properly, scene unmounted).
/// The server keeps nothing; the local recording stays untouched.
pub fn cancel() {
    // Bump the generation FIRST so the outgoing session goes silent immediately,
    // even though its thread may still be mid-tick — it stops injecting before it
    // ever observes the Cancel control message (no thread-join latency needed).
    LIVE_GEN.fetch_add(1, Ordering::SeqCst);
    if let Some(s) = ACTIVE.lock().take() {
        let _ = s.ctl_tx.send(Ctl::Cancel);
    }
}

/// Flush the tail, stop the recorder, and wait for the server's final.
/// `None` → no session was running (caller takes the classic path).
pub fn finish() -> Option<Result<StreamFinal, StreamFailure>> {
    let s = ACTIVE.lock().take()?;
    if s.ctl_tx.send(Ctl::Finish).is_err() {
        // Thread already gone (mid-hold break). It may have left a failure —
        // with the resume handle under which the server parked the audio it
        // had received — in the done channel: surface it so the caller can
        // resume instead of re-uploading. Nothing queued → classic path.
        return s.done_rx.try_recv().ok();
    }
    match s.done_rx.recv_timeout(FINAL_DEADLINE + Duration::from_secs(5)) {
        Ok(r) => Some(r),
        Err(_) => Some(Err(StreamFailure {
            error: EngineError::new("network", "Streaming-Final nicht erhalten (Timeout)"),
            capture: None,
            resume_id: None,
        })),
    }
}

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

fn session_thread(
    app: AppHandle,
    ctl_rx: mpsc::Receiver<Ctl>,
    done_tx: mpsc::Sender<Result<StreamFinal, StreamFailure>>,
    live: bool,
    gen: u64,
) {
    // Unavailable ⇒ report once and leave; the caller's fallback owns the take.
    let (mut ws, ready) = match connect(&app, None) {
        Ok(ok) => ok,
        Err(e) => {
            log::info!("stream: unavailable ({}) — classic path will handle it", e.message);
            let _ = done_tx.send(Err(StreamFailure { error: e, capture: None, resume_id: None }));
            return;
        }
    };
    // The server parks a dropped session under this handle — every failure
    // from here on carries it so the caller can resume instead of re-upload.
    let rid = ready.resume_id;
    log::info!(
        "stream: connected, live partials on (live_typing={live}, resumable={})",
        rid.is_some()
    );
    dbg_begin(); // opt-in fixture capture (ECHO_LIVE_DEBUG)

    // LocalAgreement state for "live" mode — None unless live typing is on.
    let mut live_state = if live {
        Some(Live { confirmed: String::new(), prev_partial: String::new(), gen })
    } else {
        None
    };

    // Incremental 16 kHz resampler: tracks the output watermark so each tick
    // resamples + ships only the newly-stable tail (O(tail), not O(whole buffer)).
    let mut feed = Resampler16k::default();

    loop {
        match ctl_rx.recv_timeout(FEED_TICK) {
            Ok(Ctl::Cancel) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = ws.send(Message::Text(r#"{"type":"cancel"}"#.into()));
                let _ = ws.close(None);
                return;
            }
            Ok(Ctl::Finish) => {
                let result = finish_flow(&app, &mut ws, &mut feed, live_state.as_mut(), &rid);
                let _ = done_tx.send(result);
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Err(e) = feed_delta(&app, &mut ws, &mut feed, false) {
                    // Mid-stream break: the recording continues locally — hand
                    // the failure over and let finish() fall back classically.
                    log::warn!("stream: feed failed ({}) — degrading to classic", e.message);
                    let _ = done_tx.send(Err(StreamFailure {
                        error: e,
                        capture: None,
                        resume_id: rid.clone(),
                    }));
                    return;
                }
                if let Err(e) = drain_partials(&app, &mut ws, live_state.as_mut()) {
                    log::warn!("stream: read failed ({}) — degrading to classic", e.message);
                    let _ = done_tx.send(Err(StreamFailure {
                        error: e,
                        capture: None,
                        resume_id: rid.clone(),
                    }));
                    return;
                }
            }
        }
    }
}

/// Open the socket, authenticate, await `ready`. With `resume`, ask the
/// server to continue a parked session instead of starting fresh.
fn connect(app: &AppHandle, resume: Option<&str>) -> Result<(Ws, ReadyInfo), EngineError> {
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
            let (app_name, url, title) = {
                let t = state.target.lock();
                (
                    t.as_ref().map(|t| t.app.clone()).unwrap_or_default(),
                    t.as_ref().map(|t| t.url.clone()).unwrap_or_default(),
                    t.as_ref().map(|t| t.title.clone()).unwrap_or_default(),
                )
            };
            crate::auto_mode::pick_style(&app_name, &url, &title, &cfg.auto_mode_overrides, &cfg.cleanup_style).0
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
    let mut hello = serde_json::json!({
        "token": cfg.subunit_access_token,
        "api_key": cfg.subunit_api_key,
        "language": cfg.language,
        "quality_mode": cfg.cloud_quality_mode,
        "prompt": vocab::vocab_prompt(&cfg),
        "cleanup_style": style,
    });
    if let Some(rid) = resume {
        hello["resume"] = serde_json::Value::String(rid.to_string());
    }
    ws.send(Message::Text(hello.to_string()))
        .map_err(|e| EngineError::new("network", format!("Stream-Hello: {e}")))?;

    // Await ready. The 5 s socket read timeout shows up as WouldBlock — treat
    // it as a deadline tick, not an error.
    let ready;
    loop {
        if Instant::now() > deadline {
            return Err(EngineError::new("network", "Stream-Server antwortet nicht (ready)"));
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
                match v.get("type").and_then(|t| t.as_str()) {
                    Some("ready") => {
                        // Older servers send a bare ready — every field is optional.
                        ready = ReadyInfo {
                            resume_id: v
                                .get("resume_id")
                                .and_then(|r| r.as_str())
                                .filter(|r| !r.is_empty())
                                .map(|r| r.to_string()),
                            received_bytes: v
                                .get("received_bytes")
                                .and_then(|b| b.as_u64())
                                .unwrap_or(0),
                            final_ready: v
                                .get("final_ready")
                                .and_then(|f| f.as_bool())
                                .unwrap_or(false),
                        };
                        break;
                    }
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
    Ok((ws, ready))
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

/// Incremental 16 kHz resampler over the append-only capture buffer.
///
/// `feed_delta` used to re-run `downsample_to_16k` over the WHOLE growing buffer
/// every 150 ms and ship only the new tail — O(n) work per tick, O(n²) over a
/// take. Since the capture buffer only ever grows (samples are appended, never
/// rewritten), every 16 kHz output sample is FINAL the moment its right
/// interpolation neighbour exists. So we keep an output watermark and emit only
/// the newly-stable samples, reading just the tail each tick. The bytes put on
/// the wire are byte-identical to the old whole-buffer path (proven in
/// `resampler_matches_whole_buffer_downsample`), so the server decodes exactly
/// the same audio — zero accuracy impact, just less client CPU on long takes.
#[derive(Default)]
struct Resampler16k {
    out_idx: usize, // next 16 kHz output-sample index to emit
}

impl Resampler16k {
    /// Int16-LE bytes for output samples that became stable since the last call,
    /// given the full source captured so far. `flush` also emits the final
    /// boundary samples (release) — mirrors `downsample_to_16k`'s `out_len`.
    fn pull(&mut self, src: &[f32], sr: u32, flush: bool) -> Vec<u8> {
        if sr == 16_000 {
            // No resample; hold back the last 2 samples mid-stream for parity with
            // the resampled branch (a sub-millisecond audio tail), flush sends all.
            let stable = if flush { src.len() } else { src.len().saturating_sub(2) };
            if stable <= self.out_idx {
                return Vec::new();
            }
            let mut out = Vec::with_capacity((stable - self.out_idx) * 2);
            for &s in &src[self.out_idx..stable] {
                out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
            }
            self.out_idx = stable;
            return out;
        }
        let ratio = 16_000f64 / sr as f64;
        let out_len = ((src.len() as f64) * ratio) as usize; // == downsample_to_16k's out_len
        let mut out = Vec::new();
        let mut i = self.out_idx;
        while i < out_len {
            let pos = i as f64 / ratio;
            let idx = pos.floor() as usize;
            // Mid-stream: only emit samples whose right neighbour already exists, so
            // the interpolated value can never change once shipped. Flush emits the
            // rest (the last sample falls back to b = a, exactly like downsample).
            if !flush && idx + 1 >= src.len() {
                break;
            }
            if idx >= src.len() {
                break;
            }
            let frac = (pos - idx as f64) as f32;
            let a = src[idx];
            let b = src.get(idx + 1).copied().unwrap_or(a);
            let s = a + (b - a) * frac;
            out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
            i += 1;
        }
        self.out_idx = i;
        out
    }
}

/// Snapshot the recorder, resample the new tail to 16 kHz, and ship it.
/// `flush` emits the full tail (release); otherwise boundary samples are held
/// back until their interpolation neighbour arrives (see `Resampler16k`).
fn feed_delta(
    app: &AppHandle,
    ws: &mut Ws,
    feed: &mut Resampler16k,
    flush: bool,
) -> Result<(), EngineError> {
    let state = app.state::<AppState>();
    let Some(cap) = state.recorder.snapshot() else {
        return Ok(()); // recorder not live yet — next tick
    };
    let bytes = feed.pull(&cap.samples, cap.sample_rate, flush);
    if bytes.is_empty() {
        return Ok(());
    }
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
                        // `stable` = server word-level append-only prefix (Option 1);
                        // that is what the live path types. Captured for the fixture.
                        let stable = v.get("stable").and_then(|c| c.as_str());
                        dbg_partial(text, stable);
                        if let Some(l) = live.as_deref_mut() {
                            live_commit(l, text, stable);
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

    // ── Incremental resampler (H1) ───────────────────────────────────────────
    // The streaming feed resamples + ships only the new tail each tick. These
    // prove the bytes put on the wire are byte-identical to the old whole-buffer
    // `downsample_to_16k` for ANY chunk split, so the server decodes exactly the
    // same audio — the safety net that makes the O(n²)→O(n) change zero-risk.

    fn whole_buffer_bytes(src: &[f32], sr: u32) -> Vec<u8> {
        let (down, _) = crate::transcribe::downsample_to_16k(src, sr);
        let mut b = Vec::with_capacity(down.len() * 2);
        for &s in &down {
            b.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
        }
        b
    }

    fn incremental_bytes(src: &[f32], sr: u32, chunk: usize) -> Vec<u8> {
        let mut r = Resampler16k::default();
        let mut got = Vec::new();
        let mut len = 0;
        while len < src.len() {
            len = (len + chunk).min(src.len());
            got.extend(r.pull(&src[..len], sr, false));
        }
        got.extend(r.pull(src, sr, true)); // release flush
        got
    }

    #[test]
    fn resampler_matches_whole_buffer_downsample() {
        // A speech-like signal at the common 48 kHz mic rate.
        let src: Vec<f32> = (0..20_011)
            .map(|i| (i as f32 * 0.013).sin() * 0.6 + (i as f32 * 0.071).sin() * 0.3)
            .collect();
        let reference = whole_buffer_bytes(&src, 48_000);
        // Every feed cadence must yield the SAME total bytes as one whole-buffer pass.
        for chunk in [1usize, 137, 999, 4096, 7777, 19_999, 21_000] {
            assert_eq!(
                incremental_bytes(&src, 48_000, chunk),
                reference,
                "split={chunk}"
            );
        }
    }

    #[test]
    fn resampler_passthrough_16k_and_upsample_8k() {
        let src: Vec<f32> = (0..5_003).map(|i| (i as f32 * 0.05).sin() * 0.5).collect();
        // 16k: passthrough must still equal the reference path.
        assert_eq!(
            incremental_bytes(&src, 16_000, 333),
            whole_buffer_bytes(&src, 16_000)
        );
        // 8k (e.g. Bluetooth HFP): upsampled 2× — must still match the whole-buffer math.
        assert_eq!(
            incremental_bytes(&src, 8_000, 333),
            whole_buffer_bytes(&src, 8_000)
        );
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
        for (t, cur, stable) in partials {
            max_partial_gap = max_partial_gap.max(t.saturating_sub(prev_t));
            prev_t = *t;
            // Mirror live_commit: type the server's word-level append-only `stable`
            // prefix when the fixture carries one (Option 1); else fall back to the
            // client agreed-stable of two consecutive partials (older fixtures).
            let target = if !stable.is_empty() {
                stable.clone()
            } else {
                agreed_stable(&prev, cur)
            };
            prev = cur.clone();
            if target.is_empty() {
                continue;
            }
            let (ops, newc) = plan_target(&confirmed, &target, false);
            if std::env::var_os("ECHO_TRACE").is_some() {
                println!("  t={t:>6} ag={:>3} conf={:>3} ops={} | tail={:?}",
                    target.chars().count(), confirmed.chars().count(),
                    if ops.is_empty() {"WAIT"} else {"TYPE"},
                    target.chars().rev().take(28).collect::<String>().chars().rev().collect::<String>());
            }
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
                                    let stable = v["stable"].as_str()
                                        .or_else(|| v["committed"].as_str())
                                        .unwrap_or_default();
                                    partials.push((
                                        start.elapsed().as_millis() as u64,
                                        s.to_string(),
                                        stable.to_string(),
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
                    p["stable"].as_str()
                        .or_else(|| p["committed"].as_str())
                        .unwrap_or_default()
                        .to_string(),
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

    // ── Resume E2E (live server) ─────────────────────────────────────────
    // Prove the flaky-network recovery against the real endpoint: a hard
    // TCP drop (no close frame) must park the session server-side, and a
    // reconnect with the resume handle must continue it — mid-stream (tail
    // shipped) and after a computed-but-undelivered final (instant replay).

    fn dictate_test_target() -> Option<(String, String, String)> {
        if let Ok(url) = std::env::var("ECHO_DICTATE_TEST_URL") {
            return Some((url, String::new(), "test-key".to_string()));
        }
        let cfg_path = crate::config::config_file();
        let raw = std::fs::read_to_string(&cfg_path).ok()?;
        let cfg: serde_json::Value = serde_json::from_str(&raw).ok()?;
        let token = cfg["subunit_access_token"].as_str().unwrap_or_default();
        let api_key = cfg["subunit_api_key"].as_str().unwrap_or_default();
        if token.is_empty() && api_key.is_empty() {
            println!("SKIP: not signed in");
            return None;
        }
        let url = cfg["subunit_endpoint"]
            .as_str()
            .unwrap_or("https://transcribe.subunit.ai/v1/transcribe")
            .replace("https://", "wss://")
            .replace("/v1/transcribe", "/v1/dictate");
        Some((url, token.to_string(), api_key.to_string()))
    }

    fn test_tone(seconds: f32) -> Vec<u8> {
        (0..(16_000.0 * seconds) as usize)
            .flat_map(|i| {
                let t = i as f32 / 16_000.0;
                let v = 0.3 * (2.0 * std::f32::consts::PI * 220.0 * t).sin()
                    * (0.5 + 0.5 * (i as f32 / 800.0).sin());
                ((v * 32767.0) as i16).to_le_bytes()
            })
            .collect()
    }

    fn ws_hello(
        endpoint: &str,
        token: &str,
        api_key: &str,
        resume: Option<&str>,
    ) -> (
        WebSocket<MaybeTlsStream<TcpStream>>,
        serde_json::Value,
    ) {
        let (mut ws, _) = tungstenite::connect(endpoint).expect("connect");
        let mut hello = serde_json::json!({
            "token": token, "api_key": api_key,
            "language": "de", "quality_mode": "instant", "cleanup_style": "",
        });
        if let Some(r) = resume {
            hello["resume"] = serde_json::Value::String(r.to_string());
        }
        ws.send(Message::Text(hello.to_string())).expect("hello");
        let frame: serde_json::Value = match ws.read().expect("ready frame") {
            Message::Text(t) => serde_json::from_str(&t).unwrap(),
            other => panic!("expected text, got {other:?}"),
        };
        (ws, frame)
    }

    /// Kill the connection the way a dying network does: SO_LINGER(0) turns
    /// the close into a TCP RST. A plain drop only sends FIN — the server
    /// could still WRITE into the half-closed socket, so nothing would park.
    fn hard_kill(ws: WebSocket<MaybeTlsStream<TcpStream>>) {
        let tcp = match ws.get_ref() {
            MaybeTlsStream::Plain(s) => s,
            MaybeTlsStream::Rustls(s) => &s.sock,
            _ => return,
        };
        let _ = socket2::SockRef::from(tcp).set_linger(Some(Duration::ZERO));
        drop(ws);
    }

    fn read_final(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>) -> serde_json::Value {
        loop {
            match ws.read().expect("frame") {
                Message::Text(t) => {
                    let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                    match v["type"].as_str() {
                        Some("partial") | Some("capped") => continue,
                        Some("final") => return v,
                        other => panic!("unexpected frame type {other:?}: {v}"),
                    }
                }
                Message::Close(c) => panic!("closed before final: {c:?}"),
                _ => {}
            }
        }
    }

    #[test]
    #[ignore]
    fn dictate_ws_resume_midstream() {
        let Some((endpoint, token, api_key)) = dictate_test_target() else { return };
        let (mut ws, ready) = ws_hello(&endpoint, &token, &api_key, None);
        assert_eq!(ready["type"], "ready", "ready frame: {ready}");
        let Some(rid) = ready["resume_id"].as_str().filter(|r| !r.is_empty()) else {
            println!("SKIP: server has no resume support (old server?): {ready}");
            return;
        };
        let rid = rid.to_string();

        let tone = test_tone(3.0);
        for chunk in tone.chunks(16_000) {
            ws.send(Message::Binary(chunk.to_vec())).expect("audio");
            std::thread::sleep(Duration::from_millis(80));
        }
        // Hard drop: no cancel, no close frame — exactly a dying network.
        // The park lands only after the server's in-flight partial pass
        // finishes (cold model loads take seconds) — wait generously; the
        // production client bridges this same gap with its resume retry.
        hard_kill(ws);
        std::thread::sleep(Duration::from_secs(5));

        let (mut ws, ready) = ws_hello(&endpoint, &token, &api_key, Some(&rid));
        assert_eq!(ready["type"], "ready", "resume ready frame: {ready}");
        let received = ready["received_bytes"].as_u64().expect("received_bytes") as usize;
        assert!(
            received > 0 && received <= tone.len(),
            "received_bytes {} out of range (sent {})",
            received,
            tone.len()
        );
        // Ship only the missing tail — the resume contract.
        let tail = &tone[received & !1..];
        if !tail.is_empty() {
            ws.send(Message::Binary(tail.to_vec())).expect("tail");
        }
        ws.send(Message::Text(r#"{"type":"end"}"#.into())).expect("end");
        let fin = read_final(&mut ws);
        let dur = fin["duration_s"].as_f64().unwrap_or(0.0);
        assert!(
            (dur - 3.0).abs() < 0.3,
            "resumed final should cover the WHOLE take, got {dur}s"
        );
        println!(
            "DICTATE_WS resume-midstream ok: parked {} B, tail {} B, final {}s",
            received,
            tail.len(),
            dur
        );
    }

    #[test]
    #[ignore]
    fn dictate_ws_resume_parked_final() {
        let Some((endpoint, token, api_key)) = dictate_test_target() else { return };
        let (mut ws, ready) = ws_hello(&endpoint, &token, &api_key, None);
        assert_eq!(ready["type"], "ready", "ready frame: {ready}");
        let Some(rid) = ready["resume_id"].as_str().filter(|r| !r.is_empty()) else {
            println!("SKIP: server has no resume support (old server?): {ready}");
            return;
        };
        let rid = rid.to_string();

        let tone = test_tone(2.5);
        for chunk in tone.chunks(16_000) {
            ws.send(Message::Binary(chunk.to_vec())).expect("audio");
            std::thread::sleep(Duration::from_millis(80));
        }
        ws.send(Message::Text(r#"{"type":"end"}"#.into())).expect("end");
        // Vanish BEFORE the final arrives — the server computes it, delivery
        // fails (RST), and the response must get parked for replay.
        hard_kill(ws);
        std::thread::sleep(Duration::from_secs(5));

        let (mut ws, ready) = ws_hello(&endpoint, &token, &api_key, Some(&rid));
        assert_eq!(ready["type"], "ready", "resume ready frame: {ready}");
        assert_eq!(
            ready["final_ready"].as_bool(),
            Some(true),
            "expected a parked final: {ready}"
        );
        let fin = read_final(&mut ws);
        let dur = fin["duration_s"].as_f64().unwrap_or(0.0);
        assert!((dur - 2.5).abs() < 0.3, "parked final duration off: {dur}s");
        println!("DICTATE_WS resume-parked-final ok: replayed {dur}s final with zero re-upload");
    }
}

/// Release path: flush the tail, send `end`, stop the recorder (audio already
/// lives server-side), await the final. The stopped capture rides along on
/// every failure so the caller can fall back to the classic upload — together
/// with the resume handle, so it can try the cheap parked-session pickup first.
fn finish_flow(
    app: &AppHandle,
    ws: &mut Ws,
    feed: &mut Resampler16k,
    live: Option<&mut Live>,
    rid: &Option<String>,
) -> Result<StreamFinal, StreamFailure> {
    let flush_result = feed_delta(app, ws, feed, true)
        .and_then(|()| {
            ws.send(Message::Text(r#"{"type":"end"}"#.into()))
                .map_err(|e| EngineError::new("network", format!("Stream-End: {e}")))
        });

    // Mic off NOW — the user released the key; nothing more to capture either way.
    let state = app.state::<AppState>();
    let capture = state.recorder.stop();

    if let Err(error) = flush_result {
        return Err(StreamFailure { error, capture, resume_id: rid.clone() });
    }

    await_final(app, ws, live).map_err(|error| StreamFailure {
        error,
        capture,
        resume_id: rid.clone(),
    })
}

/// Await the server's `final`, forwarding late partials to the UI. A liveness
/// watchdog pings the peer and declares the link dead after
/// FINAL_SILENCE_DEADLINE of total silence — on a black-holed connection this
/// hands control to the resume/batch fallback in ~15 s instead of burning the
/// full 90 s ceiling while the user stares at "transcribing".
fn await_final(
    app: &AppHandle,
    ws: &mut Ws,
    mut live: Option<&mut Live>,
) -> Result<StreamFinal, EngineError> {
    let deadline = Instant::now() + FINAL_DEADLINE;
    let mut last_rx = Instant::now();
    let mut last_ping = Instant::now();
    loop {
        if Instant::now() > deadline {
            return Err(EngineError::new("network", "Stream-Final Timeout"));
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                last_rx = Instant::now();
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
                            dbg_partial(text, v.get("stable").and_then(|c| c.as_str()));
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
                        return Err(EngineError::new(&code, detail));
                    }
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => {
                return Err(EngineError::new("network", "Stream vor Final geschlossen"));
            }
            Ok(_) => last_rx = Instant::now(), // pong/binary — the link is alive
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if last_rx.elapsed() > FINAL_SILENCE_DEADLINE {
                    return Err(EngineError::new(
                        "network",
                        "Stream-Final: Verbindung still — Fallback",
                    ));
                }
                if last_ping.elapsed() >= FINAL_PING_EVERY {
                    last_ping = Instant::now();
                    if let Err(e) = ws.send(Message::Ping(Vec::new())) {
                        return Err(EngineError::new("network", format!("Stream-Ping: {e}")));
                    }
                }
            }
            Err(e) => {
                return Err(EngineError::new("network", format!("Stream-Final: {e}")));
            }
        }
    }
}

/// Collect a dictation the server parked after an abnormal drop: reconnect
/// with the resume handle, ship ONLY the audio the server never received,
/// and await the final — instead of re-uploading the whole take through the
/// batch path, which is exactly what hurts on the flaky network that caused
/// the drop. One retry bridges the race where the server has not yet noticed
/// the drop (parking happens when ITS side of the socket dies).
pub fn resume_finish(
    app: &AppHandle,
    resume_id: &str,
    cap: &Capture,
) -> Result<StreamFinal, EngineError> {
    let t0 = Instant::now();
    let mut retried = false;
    let (mut ws, ready) = loop {
        match connect(app, Some(resume_id)) {
            Ok(ok) => break ok,
            Err(e) if e.code == "resume_unknown" && !retried => {
                retried = true;
                std::thread::sleep(Duration::from_secs(2));
            }
            Err(e) => return Err(e),
        }
    };

    if !ready.final_ready {
        // Ship the tail the server is missing. downsample_to_16k produces the
        // byte-identical stream the session already sent (that parity is what
        // `resampler_matches_whole_buffer_downsample` proves), so slicing at
        // the server's received-byte count continues the buffer seamlessly.
        let (s16, _) = super::downsample_to_16k(&cap.samples, cap.sample_rate);
        let from_sample = ((ready.received_bytes as usize) / 2).min(s16.len());
        let tail_bytes = (s16.len() - from_sample) * 2;
        if tail_bytes > RESUME_MAX_TAIL_BYTES {
            let _ = ws.close(None);
            return Err(EngineError::new(
                "resume_tail",
                format!("Resume-Tail zu groß ({tail_bytes} B) — Batch-Upload ist billiger"),
            ));
        }
        let mut bytes = Vec::with_capacity(tail_bytes);
        for &s in &s16[from_sample..] {
            bytes.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
        }
        for chunk in bytes.chunks(64 * 1024) {
            ws.send(Message::Binary(chunk.to_vec()))
                .map_err(|e| EngineError::new("network", format!("Resume-Audio: {e}")))?;
        }
        ws.send(Message::Text(r#"{"type":"end"}"#.into()))
            .map_err(|e| EngineError::new("network", format!("Resume-End: {e}")))?;
        log::info!(
            "stream: resume — server held {} B, shipped {} B tail",
            ready.received_bytes,
            tail_bytes
        );
    } else {
        log::info!("stream: resume — final was already computed, zero re-upload");
    }

    let fin = await_final(app, &mut ws, None)?;
    log::info!(
        "stream: resumed parked session ok in {:?} ({:.1}s audio)",
        t0.elapsed(),
        fin.duration_s
    );
    Ok(fin)
}
