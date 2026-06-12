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
         CREATE INDEX IF NOT EXISTS idx_meetings_ts ON meetings(ts DESC);",
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

        let _ = std::fs::remove_file(&path);
    }
}
