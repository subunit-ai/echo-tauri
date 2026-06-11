//! Shared blocking HTTP client for the subunit cloud path (transcribe,
//! cleanup, auth).
//!
//! Every call site used to build its own `reqwest::blocking::Client`, which
//! meant a fresh DNS + TCP + TLS handshake on the hot path — twice per
//! dictation (transcribe, then cleanup). One shared client gives us a
//! connection pool; [`prewarm`] opens the connection while the user is still
//! recording so no handshake sits between "stop" and the transcript.
//!
//! Timeouts are per-request (`RequestBuilder::timeout`) since the callers'
//! budgets differ (transcribe 120 s, cleanup 30 s, auth 20 s).

use std::sync::OnceLock;
use std::time::Duration;

static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

pub fn client() -> &'static reqwest::blocking::Client {
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            // Fail fast on an unreachable server instead of eating into the
            // caller's whole request budget before the first byte.
            .connect_timeout(Duration::from_secs(8))
            // Keep pooled connections alive through NAT/firewall idle limits.
            .tcp_keepalive(Duration::from_secs(30))
            // Dictations are often minutes apart — keep the connection longer
            // than reqwest's 90 s default (prewarm re-opens it anyway).
            .pool_idle_timeout(Duration::from_secs(290))
            .build()
            .expect("build shared http client")
    })
}

/// Open (or refresh) the pooled connection to `url`'s origin so the next real
/// request skips DNS + TCP + TLS. Best-effort: any response (even 404) means
/// the connection is up; errors are only logged.
pub fn prewarm(url: &str) {
    let origin = match reqwest::Url::parse(url).and_then(|u| u.join("/")) {
        Ok(o) => o,
        Err(_) => return,
    };
    let t = std::time::Instant::now();
    match client().get(origin).timeout(Duration::from_secs(6)).send() {
        Ok(r) => log::debug!("http: prewarm {} (+{:?})", r.status(), t.elapsed()),
        Err(e) => log::debug!("http: prewarm failed: {e}"),
    }
}

/// Transport-layer failure worth exactly one immediate retry: the connection
/// died before a response existed (refused / reset / stale pooled connection
/// the server closed while idle — hyper's "connection closed before message
/// completed"). HTTP error statuses and timeouts are NOT transient: a status
/// is a real server answer, and retrying a timeout doubles the wait.
pub fn is_transient(e: &reqwest::Error) -> bool {
    if e.is_timeout() {
        return false;
    }
    if e.is_connect() {
        return true;
    }
    let mut src: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(s) = src {
        let m = s.to_string();
        if m.contains("connection closed before message completed")
            || m.contains("IncompleteMessage")
            || m.contains("connection reset")
            || m.contains("broken pipe")
        {
            return true;
        }
        src = s.source();
    }
    false
}
