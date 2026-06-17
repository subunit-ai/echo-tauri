//! SQLite store for history + meetings (`~/.config/echo/echo.db`).
//!
//! Why not config.json: every transcription rewrote the WHOLE config file
//! (incl. meeting transcripts — megabytes for an hour-long meeting), history
//! was hard-capped, and there was no search. The DB makes history durable,
//! searchable and unbounded while the config stays a small settings file.
//!
//! Shapes: `history` has real columns (we query/search them); `meetings` keeps
//! the entry as a JSON blob (`data`) — its shape is fluid (diarization adds
//! `speaker_text` later) and all consumers treat it as an object anyway.
//! Every row gains an `id` the frontend uses for delete/process actions.
//!
//! One process-wide connection behind a Mutex (Echo is a single-instance app —
//! see the single-instance guard in lib.rs). All helpers are best-effort
//! no-ops when `init` hasn't run (e.g. unit tests of unrelated modules).

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

static DB: Lazy<Mutex<Option<Connection>>> = Lazy::new(|| Mutex::new(None));

/// Open (or create) the database and its schema. Called once at startup.
pub fn init() -> anyhow::Result<()> {
    init_at(&crate::config::config_dir().join("echo.db"))
}

/// Open a specific database file (tests use a temp path; `init` the real one).
pub fn init_at(path: &std::path::Path) -> anyhow::Result<()> {
    let conn = Connection::open(path)?;
    // WAL: a reader (History UI) never blocks the writer (a finishing dictation).
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ts          INTEGER NOT NULL,
            text        TEXT    NOT NULL,
            quality_mode TEXT   NOT NULL DEFAULT '',
            style       TEXT    NOT NULL DEFAULT '',
            latency_ms  INTEGER,
            stt_ms      INTEGER,
            cleanup_ms  INTEGER,
            duration_s  REAL
         );
         CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts DESC);
         CREATE TABLE IF NOT EXISTS meetings (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            ts   INTEGER NOT NULL,
            data TEXT    NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_meetings_ts ON meetings(ts DESC);
         CREATE TABLE IF NOT EXISTS preset_profiles (
            id         TEXT    NOT NULL,
            account    TEXT    NOT NULL,
            name       TEXT    NOT NULL DEFAULT '',
            payload    TEXT    NOT NULL DEFAULT '{}',
            updated_at INTEGER NOT NULL,
            deleted    INTEGER NOT NULL DEFAULT 0,
            dirty      INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (account, id)
         );
         CREATE INDEX IF NOT EXISTS idx_profiles_account ON preset_profiles(account, updated_at);
         CREATE TABLE IF NOT EXISTS vocab_candidates (
            key         TEXT PRIMARY KEY,
            variants    TEXT    NOT NULL DEFAULT '[]',
            total       INTEGER NOT NULL DEFAULT 0,
            suggestion  TEXT,
            confidence  REAL,
            status      TEXT    NOT NULL DEFAULT 'pending',
            added_term  TEXT,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_vcand_status ON vocab_candidates(status, updated_at DESC);",
    )?;
    *DB.lock() = Some(conn);
    log::info!("store: opened {}", path.display());
    Ok(())
}

/// One-time import of the legacy config.json arrays (pre-DB builds). The caller
/// clears the config arrays afterwards so this never runs twice.
pub fn migrate_from_config(history: &[Value], meetings: &[Value]) -> anyhow::Result<()> {
    let mut guard = DB.lock();
    let conn = guard.as_mut().ok_or_else(|| anyhow::anyhow!("store not initialized"))?;
    let tx = conn.transaction()?;
    // Config arrays are newest-first; insert oldest-first so AUTOINCREMENT ids
    // keep chronological order.
    for e in history.iter().rev() {
        tx.execute(
            "INSERT INTO history (ts, text, quality_mode, style, latency_ms, stt_ms, cleanup_ms, duration_s)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                e.get("ts").and_then(Value::as_i64).unwrap_or(0),
                e.get("text").and_then(Value::as_str).unwrap_or(""),
                e.get("quality_mode").and_then(Value::as_str).unwrap_or(""),
                e.get("style").and_then(Value::as_str).unwrap_or(""),
                e.get("latency_ms").and_then(Value::as_i64),
                e.get("stt_ms").and_then(Value::as_i64),
                e.get("cleanup_ms").and_then(Value::as_i64),
                e.get("duration_s").and_then(Value::as_f64),
            ],
        )?;
    }
    for m in meetings.iter().rev() {
        tx.execute(
            "INSERT INTO meetings (ts, data) VALUES (?1, ?2)",
            params![m.get("ts").and_then(Value::as_i64).unwrap_or(0), m.to_string()],
        )?;
    }
    tx.commit()?;
    log::info!(
        "store: migrated {} history entries + {} meetings from config.json",
        history.len(),
        meetings.len()
    );
    Ok(())
}

// ---- History ----

/// Insert a history row; `cap` > 0 prunes the oldest rows beyond it (the
/// config's `history_size`, kept for users who explicitly limit retention).
pub fn add_history(entry: &Value, cap: usize) {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return };
    let r = conn.execute(
        "INSERT INTO history (ts, text, quality_mode, style, latency_ms, stt_ms, cleanup_ms, duration_s)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            entry.get("ts").and_then(Value::as_i64).unwrap_or(0),
            entry.get("text").and_then(Value::as_str).unwrap_or(""),
            entry.get("quality_mode").and_then(Value::as_str).unwrap_or(""),
            entry.get("style").and_then(Value::as_str).unwrap_or(""),
            entry.get("latency_ms").and_then(Value::as_i64),
            entry.get("stt_ms").and_then(Value::as_i64),
            entry.get("cleanup_ms").and_then(Value::as_i64),
            entry.get("duration_s").and_then(Value::as_f64),
        ],
    );
    if let Err(e) = r {
        log::warn!("store: history insert failed: {e}");
        return;
    }
    if cap > 0 {
        let _ = conn.execute(
            "DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY ts DESC, id DESC LIMIT ?1)",
            params![cap as i64],
        );
    }
}

/// Newest-first history page; `query` filters with a case-insensitive substring
/// match on the text (ASCII folding — SQLite's NOCASE).
pub fn list_history(query: &str, limit: u32, offset: u32) -> Vec<Value> {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return Vec::new() };
    let sql = "SELECT id, ts, text, quality_mode, style, latency_ms, duration_s FROM history
               WHERE (?1 = '' OR text LIKE '%' || ?1 || '%')
               ORDER BY ts DESC, id DESC LIMIT ?2 OFFSET ?3";
    let Ok(mut stmt) = conn.prepare_cached(sql) else { return Vec::new() };
    let rows = stmt.query_map(params![query, limit, offset], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "ts": r.get::<_, i64>(1)?,
            "text": r.get::<_, String>(2)?,
            "quality_mode": r.get::<_, String>(3)?,
            "style": r.get::<_, String>(4)?,
            "latency_ms": r.get::<_, Option<i64>>(5)?,
            "duration_s": r.get::<_, Option<f64>>(6)?,
        }))
    });
    match rows {
        Ok(it) => it.filter_map(Result::ok).collect(),
        Err(e) => {
            log::warn!("store: history query failed: {e}");
            Vec::new()
        }
    }
}

pub fn count_history() -> i64 {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return 0 };
    conn.query_row("SELECT COUNT(*) FROM history", [], |r| r.get(0))
        .unwrap_or(0)
}

pub fn delete_history(id: i64) {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return };
    let _ = conn.execute("DELETE FROM history WHERE id = ?1", params![id]);
}

pub fn clear_history() {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return };
    let _ = conn.execute("DELETE FROM history", []);
}

// ---- Meetings ----

/// Insert a meeting entry (JSON object with at least `ts`); capped at 100 like
/// the old config array.
pub fn add_meeting(data: &Value) {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return };
    let r = conn.execute(
        "INSERT INTO meetings (ts, data) VALUES (?1, ?2)",
        params![data.get("ts").and_then(Value::as_i64).unwrap_or(0), data.to_string()],
    );
    if let Err(e) = r {
        log::warn!("store: meeting insert failed: {e}");
        return;
    }
    let _ = conn.execute(
        "DELETE FROM meetings WHERE id NOT IN (SELECT id FROM meetings ORDER BY ts DESC, id DESC LIMIT 100)",
        [],
    );
}

/// All meetings, newest first, each as its JSON object with `id` injected.
pub fn list_meetings() -> Vec<Value> {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return Vec::new() };
    let Ok(mut stmt) =
        conn.prepare_cached("SELECT id, data FROM meetings ORDER BY ts DESC, id DESC")
    else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        let id: i64 = r.get(0)?;
        let data: String = r.get(1)?;
        Ok((id, data))
    });
    match rows {
        Ok(it) => it
            .filter_map(Result::ok)
            .filter_map(|(id, data)| {
                let mut v: Value = serde_json::from_str(&data).ok()?;
                v.as_object_mut()?.insert("id".into(), json!(id));
                Some(v)
            })
            .collect(),
        Err(e) => {
            log::warn!("store: meetings query failed: {e}");
            Vec::new()
        }
    }
}

/// The raw transcript text of one meeting (for re-processing).
pub fn meeting_text(id: i64) -> Option<String> {
    let guard = DB.lock();
    let conn = guard.as_ref()?;
    let data: String = conn
        .query_row("SELECT data FROM meetings WHERE id = ?1", params![id], |r| r.get(0))
        .ok()?;
    serde_json::from_str::<Value>(&data)
        .ok()?
        .get("text")?
        .as_str()
        .map(str::to_string)
}

/// Merge a key into a meeting found by its timestamp (the detached diarization
/// thread only knows the `ts` it stored the meeting under).
pub fn update_meeting_by_ts(ts: i64, key: &str, value: &str) {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return };
    let row: Result<(i64, String), _> = conn.query_row(
        "SELECT id, data FROM meetings WHERE ts = ?1 ORDER BY id DESC LIMIT 1",
        params![ts],
        |r| Ok((r.get(0)?, r.get(1)?)),
    );
    let Ok((id, data)) = row else { return };
    let Ok(mut v) = serde_json::from_str::<Value>(&data) else { return };
    if let Some(obj) = v.as_object_mut() {
        obj.insert(key.to_string(), json!(value));
    }
    let _ = conn.execute(
        "UPDATE meetings SET data = ?1 WHERE id = ?2",
        params![v.to_string(), id],
    );
}

// ---- Orb profiles (per-account, local-first, cloud-synced) ----
//
// Each profile is an opaque JSON `payload` (the full orb look) the app owns.
// Rows are partitioned by `account` so multiple accounts on one machine never
// mix. `dirty` = has local changes not yet pushed to the server; tombstones
// (`deleted=1`) ride along so a delete propagates. Mirrors the server schema.

/// All non-deleted profiles for `account`, newest-first.
pub fn list_profiles(account: &str) -> Vec<Value> {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return Vec::new() };
    let sql = "SELECT id, name, payload, updated_at FROM preset_profiles
               WHERE account = ?1 AND deleted = 0 ORDER BY updated_at DESC, name ASC";
    let Ok(mut stmt) = conn.prepare_cached(sql) else { return Vec::new() };
    let rows = stmt.query_map(params![account], |r| {
        let payload: String = r.get(2)?;
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "name": r.get::<_, String>(1)?,
            "payload": serde_json::from_str::<Value>(&payload).unwrap_or_else(|_| json!({})),
            "updated_at": r.get::<_, i64>(3)?,
        }))
    });
    match rows {
        Ok(it) => it.filter_map(Result::ok).collect(),
        Err(e) => {
            log::warn!("store: profile query failed: {e}");
            Vec::new()
        }
    }
}

/// Insert or replace a profile, marking it dirty (needs push). `payload` is a
/// JSON string. Used by the local CRUD commands.
pub fn upsert_profile(account: &str, id: &str, name: &str, payload: &str, updated_at: i64, dirty: bool) {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return };
    let _ = conn.execute(
        "INSERT INTO preset_profiles (id, account, name, payload, updated_at, deleted, dirty)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
         ON CONFLICT(account, id) DO UPDATE SET
            name = excluded.name, payload = excluded.payload,
            updated_at = excluded.updated_at, deleted = 0, dirty = excluded.dirty",
        params![id, account, name, payload, updated_at, dirty as i64],
    );
}

/// Tombstone a profile (kept as a dirty deleted row so the delete syncs).
pub fn soft_delete_profile(account: &str, id: &str, updated_at: i64) {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return };
    let _ = conn.execute(
        "UPDATE preset_profiles SET deleted = 1, dirty = 1, updated_at = ?3
         WHERE account = ?1 AND id = ?2",
        params![account, id, updated_at],
    );
}

/// Rows with un-pushed local changes (including tombstones) for the sync push.
pub fn take_dirty_profiles(account: &str) -> Vec<Value> {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return Vec::new() };
    let sql = "SELECT id, name, payload, updated_at, deleted FROM preset_profiles
               WHERE account = ?1 AND dirty = 1";
    let Ok(mut stmt) = conn.prepare_cached(sql) else { return Vec::new() };
    let rows = stmt.query_map(params![account], |r| {
        let payload: String = r.get(2)?;
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "name": r.get::<_, String>(1)?,
            "payload": serde_json::from_str::<Value>(&payload).unwrap_or_else(|_| json!({})),
            "updated_at": r.get::<_, i64>(3)?,
            "deleted": r.get::<_, i64>(4)? != 0,
        }))
    });
    match rows {
        Ok(it) => it.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

/// Clear the dirty flag for the pushed `(id, updated_at)` pairs — but only if
/// the row hasn't been edited again since (its `updated_at` still matches), so
/// an edit racing the push isn't silently dropped (it stays dirty, re-pushed).
pub fn mark_profiles_synced(account: &str, items: &[(String, i64)]) {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return };
    for (id, updated_at) in items {
        let _ = conn.execute(
            "UPDATE preset_profiles SET dirty = 0
             WHERE account = ?1 AND id = ?2 AND updated_at = ?3",
            params![account, id, updated_at],
        );
    }
}

/// Reconcile the authoritative server set into the local store: server rows
/// overwrite local NON-dirty rows (server is truth for already-synced state),
/// local dirty rows are left for the next push, and local non-dirty rows the
/// server no longer has (deleted elsewhere) are removed.
pub fn apply_server_profiles(account: &str, server_rows: &[Value]) {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return };
    let mut server_ids: Vec<String> = Vec::with_capacity(server_rows.len());
    for row in server_rows {
        let Some(id) = row.get("id").and_then(Value::as_str) else { continue };
        server_ids.push(id.to_string());
        // Skip if a dirty local version exists (pending push wins for now).
        let dirty: i64 = conn
            .query_row(
                "SELECT dirty FROM preset_profiles WHERE account = ?1 AND id = ?2",
                params![account, id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if dirty == 1 {
            continue;
        }
        let name = row.get("name").and_then(Value::as_str).unwrap_or("");
        let payload = row
            .get("payload")
            .map(|p| if p.is_string() { p.as_str().unwrap_or("{}").to_string() } else { p.to_string() })
            .unwrap_or_else(|| "{}".to_string());
        let updated_at = row.get("updated_at").and_then(Value::as_i64).unwrap_or(0);
        let _ = conn.execute(
            "INSERT INTO preset_profiles (id, account, name, payload, updated_at, deleted, dirty)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)
             ON CONFLICT(account, id) DO UPDATE SET
                name = excluded.name, payload = excluded.payload,
                updated_at = excluded.updated_at, deleted = 0, dirty = 0",
            params![id, account, name, payload, updated_at],
        );
    }
    // Remove local non-dirty profiles the server didn't return (deleted elsewhere).
    let keep: std::collections::HashSet<&str> = server_ids.iter().map(String::as_str).collect();
    let existing: Vec<String> = {
        let sql = "SELECT id FROM preset_profiles WHERE account = ?1 AND dirty = 0 AND deleted = 0";
        match conn.prepare_cached(sql) {
            Ok(mut stmt) => stmt
                .query_map(params![account], |r| r.get::<_, String>(0))
                .map(|it| it.filter_map(Result::ok).collect())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    };
    for id in existing {
        if !keep.contains(id.as_str()) {
            let _ = conn.execute(
                "DELETE FROM preset_profiles WHERE account = ?1 AND id = ?2",
                params![account, id],
            );
        }
    }
}

// ── Auto-vocab candidates (autovocab.rs detection → hybrid learn flow) ──────

/// Current status of a candidate if seen before ("pending" | "added" | "ignored").
pub fn vcand_status(key: &str) -> Option<String> {
    let guard = DB.lock();
    let conn = guard.as_ref()?;
    conn.query_row(
        "SELECT status FROM vocab_candidates WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

/// Insert/refresh a PENDING candidate. Never resurrects an 'added'/'ignored' row
/// (the WHERE guard scopes updates to still-pending ones), so a handled term
/// stays handled.
pub fn upsert_vcand_pending(key: &str, variants_json: &str, total: i64, now: i64) {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return };
    let _ = conn.execute(
        "INSERT INTO vocab_candidates (key, variants, total, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'pending', ?4, ?4)
         ON CONFLICT(key) DO UPDATE SET
            variants = excluded.variants, total = excluded.total, updated_at = excluded.updated_at
         WHERE status = 'pending'",
        params![key, variants_json, total, now],
    );
}

/// Record the LLM suggestion + resulting status (+ the added term, for undo).
pub fn set_vcand(
    key: &str,
    suggestion: Option<&str>,
    confidence: Option<f64>,
    status: &str,
    added_term: Option<&str>,
    now: i64,
) {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return };
    let _ = conn.execute(
        "UPDATE vocab_candidates SET suggestion = ?2, confidence = ?3, status = ?4,
            added_term = ?5, updated_at = ?6 WHERE key = ?1",
        params![key, suggestion, confidence, status, added_term, now],
    );
}

/// One candidate row by key (variants/suggestion/added_term — for confirm/undo).
pub fn get_vcand(key: &str) -> Option<Value> {
    let guard = DB.lock();
    let conn = guard.as_ref()?;
    conn.query_row(
        "SELECT key, variants, total, suggestion, confidence, status, added_term
         FROM vocab_candidates WHERE key = ?1",
        params![key],
        |r| {
            let variants: String = r.get(1)?;
            Ok(json!({
                "key": r.get::<_, String>(0)?,
                "variants": serde_json::from_str::<Value>(&variants).unwrap_or_else(|_| json!([])),
                "total": r.get::<_, i64>(2)?,
                "suggestion": r.get::<_, Option<String>>(3)?,
                "confidence": r.get::<_, Option<f64>>(4)?,
                "status": r.get::<_, String>(5)?,
                "added_term": r.get::<_, Option<String>>(6)?,
            }))
        },
    )
    .ok()
}

/// Candidates with a given status, newest first (for the UI panels).
pub fn list_vcand(status: &str) -> Vec<Value> {
    let guard = DB.lock();
    let Some(conn) = guard.as_ref() else { return Vec::new() };
    let Ok(mut stmt) = conn.prepare_cached(
        "SELECT key, variants, total, suggestion, confidence, status, added_term, updated_at
         FROM vocab_candidates WHERE status = ?1 ORDER BY updated_at DESC, total DESC",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map(params![status], |r| {
        let variants: String = r.get(1)?;
        Ok(json!({
            "key": r.get::<_, String>(0)?,
            "variants": serde_json::from_str::<Value>(&variants).unwrap_or_else(|_| json!([])),
            "total": r.get::<_, i64>(2)?,
            "suggestion": r.get::<_, Option<String>>(3)?,
            "confidence": r.get::<_, Option<f64>>(4)?,
            "status": r.get::<_, String>(5)?,
            "added_term": r.get::<_, Option<String>>(6)?,
            "updated_at": r.get::<_, i64>(7)?,
        }))
    });
    match rows {
        Ok(it) => it.filter_map(Result::ok).collect(),
        Err(e) => {
            log::warn!("store: vcand query failed: {e}");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One sequential round-trip over the whole store API (the connection is a
    /// process-wide singleton, so a single test keeps it deterministic).
    #[test]
    fn round_trip() {
        let path = std::env::temp_dir().join(format!("echo-store-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        init_at(&path).expect("init");

        // History: insert 3 with cap 2 → oldest pruned.
        for (i, text) in ["alpha eins", "beta zwei", "gamma drei"].iter().enumerate() {
            add_history(
                &json!({ "ts": 100 + i as i64, "text": text, "quality_mode": "cloud",
                          "style": "raw", "latency_ms": 1200 + i as i64 }),
                2,
            );
        }
        assert_eq!(count_history(), 2);
        let all = list_history("", 10, 0);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0]["text"], "gamma drei"); // newest first
        assert_eq!(all[0]["latency_ms"], 1202);
        // Search: substring, case-insensitive (ASCII).
        assert_eq!(list_history("BETA", 10, 0).len(), 1);
        assert_eq!(list_history("alpha", 10, 0).len(), 0); // pruned by cap
        // Delete one by id, then clear.
        let id = all[0]["id"].as_i64().unwrap();
        delete_history(id);
        assert_eq!(count_history(), 1);
        clear_history();
        assert_eq!(count_history(), 0);

        // Meetings: insert, tag by ts (diarization path), read back with id.
        add_meeting(&json!({ "ts": 555, "text": "meeting transcript", "duration_s": 60 }));
        update_meeting_by_ts(555, "speaker_text", "S1: hallo");
        let meetings = list_meetings();
        assert_eq!(meetings.len(), 1);
        assert_eq!(meetings[0]["speaker_text"], "S1: hallo");
        let mid = meetings[0]["id"].as_i64().unwrap();
        assert_eq!(meeting_text(mid).as_deref(), Some("meeting transcript"));

        // Legacy config.json migration (newest-first arrays).
        clear_history();
        migrate_from_config(
            &[json!({"ts": 2, "text": "neu"}), json!({"ts": 1, "text": "alt"})],
            &[],
        )
        .expect("migrate");
        let migrated = list_history("", 10, 0);
        assert_eq!(migrated[0]["text"], "neu");
        assert_eq!(migrated[1]["text"], "alt");

        // Orb profiles: per-account isolation, dirty tracking, server reconcile.
        upsert_profile("em:a", "p1", "Aurora", r#"{"style":"sonar2"}"#, 100, true);
        upsert_profile("em:a", "p2", "Mono", r#"{"style":"bars"}"#, 100, true);
        upsert_profile("em:b", "p1", "B-only", r#"{"style":"wave"}"#, 100, true);
        assert_eq!(list_profiles("em:a").len(), 2);
        assert_eq!(list_profiles("em:b").len(), 1); // isolation
        assert_eq!(list_profiles("em:b")[0]["payload"]["style"], "wave");
        assert_eq!(take_dirty_profiles("em:a").len(), 2);
        mark_profiles_synced("em:a", &[("p1".into(), 100), ("p2".into(), 100)]);
        assert_eq!(take_dirty_profiles("em:a").len(), 0);
        // A stale (mismatched updated_at) sync-ack must NOT clear a fresh edit.
        upsert_profile("em:a", "p1", "Aurora2", r#"{"style":"sonar2"}"#, 120, true);
        mark_profiles_synced("em:a", &[("p1".into(), 100)]); // stale ts → no-op
        assert_eq!(take_dirty_profiles("em:a").len(), 1);
        mark_profiles_synced("em:a", &[("p1".into(), 120)]);
        assert_eq!(take_dirty_profiles("em:a").len(), 0);
        // Tombstone hides from list but rides along as dirty for the push.
        soft_delete_profile("em:a", "p2", 200);
        assert_eq!(list_profiles("em:a").len(), 1);
        assert_eq!(take_dirty_profiles("em:a").len(), 1);
        // Server reconcile: a dirty local row survives; a synced row absent from
        // the server set is removed; a server-only row is pulled in.
        mark_profiles_synced("em:a", &[("p2".into(), 200)]);
        upsert_profile("em:a", "p3", "LocalDirty", "{}", 300, true);
        apply_server_profiles(
            "em:a",
            &[json!({"id":"p1","name":"AuroraSynced","payload":{"style":"sonar2"},"updated_at":150})],
        );
        let a = list_profiles("em:a");
        let ids: std::collections::HashSet<&str> =
            a.iter().filter_map(|p| p["id"].as_str()).collect();
        assert!(ids.contains("p1") && ids.contains("p3")); // server p1 + local-dirty p3
        assert!(!ids.contains("p2")); // synced+deleted, not on server → gone

        let _ = std::fs::remove_file(&path);
    }
}
