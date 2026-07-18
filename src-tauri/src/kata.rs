//! Dojo-Welt Kata-Pfad (Prompt-Halle) — a 7-station spoken lesson in prompting,
//! scored 100 % on-device against the existing 5×20 prompt rubric, plus an Obi
//! (belt) rank fed by kata completions + training days across BOTH dojo halls.
//!
//! The recording quartet mirrors `dojo.rs` exactly (shared recorder + the
//! `session_active` guard, native start cue, NO overlay orb, NO history write,
//! NO injection) and additionally **suspends the global hotkey** while a kata
//! records — otherwise a Toggle-Off / Hold-Release would run the dictation
//! pipeline over the kata audio and inject it (hotkey.rs). The suspend is ALWAYS
//! lifted again in stop AND cancel, including every error path — and in stop
//! BEFORE the fallible transcribe step.
//!
//! Everything scoring/belt-related is PURE and offline: `evaluate` grades a
//! transcript against a kata, `rank_index`/`belt_from_counts` derive the Obi
//! rank + the deltas to the next belt, and `kata_states` computes the linear
//! unlock. The command layer supplies the transcript; persistence rides the new
//! `kata_progress` table and the existing idempotent `learning_award` ledger.
//!
//! XP (contract §4): kind `"kata"` / word = `<kata_id>` / 50 XP once on the
//! FIRST pass of a kata (gated on `completed` going 0→1); kind `"kata_train"` /
//! word `"train"` / 10 XP once per local day for the first kata attempt of the
//! day (pass or fail). Both feed `echo://learning-reward` + a detached score
//! push, exactly like `dojo::dojo_record_stop`.

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, State};

use crate::commands::AppState;
use crate::transcribe::{self, EngineError};

// ── Tuning constants ─────────────────────────────────────────────────────────

/// XP for the FIRST pass of a kata (once ever, gated on completed 0→1). Same as
/// a word of the day (50) — passing a kata is a genuine milestone.
pub const KATA_XP: i64 = 50;
/// XP for the first kata ATTEMPT of a local day (pass or fail). A daily rep,
/// below a full pass — mirrors the dojo drill's per-day XP.
pub const KATA_TRAIN_XP: i64 = 10;
/// Recording length shown to the UI (the client stops at 60 s; the backend never
/// hard-cuts — same as the dojo drill's 45 s).
pub const KATA_SECONDS: i64 = 60;
/// A kata's `best_score` at/above this counts as a "high score" for the belt.
pub const KATA_HIGH_SCORE: i64 = 80;

// ── Kata catalog (contract §2 — IDs + thresholds are the canon, order fixed) ──

/// What "focus criterion" a kata grades. Katas 1–5 map onto one rubric boolean;
/// kata 6 uses the few-shot check; kata 7 (master) demands ALL five (score 100).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Goal,
    Context,
    Format,
    Constraints,
    Negative,
    /// Kata 6 — an in-prompt worked example (`prompt_coach::chk_few_shot`).
    Example,
    /// Kata 7 — the master exam: all five rubric criteria (score == 100).
    All,
}

impl Focus {
    /// The `focus` string in the `kata_list` payload (contract §5): the rubric key
    /// for 1–5, `"example"` for kata 6, `"all"` for the master.
    pub fn as_str(self) -> &'static str {
        match self {
            Focus::Goal => "goal",
            Focus::Context => "context",
            Focus::Format => "format",
            Focus::Constraints => "constraints",
            Focus::Negative => "negative",
            Focus::Example => "example",
            Focus::All => "all",
        }
    }
}

/// One kata station: stable id (also the ledger `word` + i18n key), 1-based idx,
/// the focus criterion and the total-score threshold to pass.
#[derive(Debug, Clone, Copy)]
pub struct Kata {
    pub id: &'static str,
    pub idx: i64,
    pub focus: Focus,
    pub threshold: i64,
}

/// The 7 katas (contract §2). Linear unlock: kata n+1 opens with kata n's pass.
pub static KATAS: [Kata; 7] = [
    Kata { id: "goal", idx: 1, focus: Focus::Goal, threshold: 40 },
    Kata { id: "context", idx: 2, focus: Focus::Context, threshold: 40 },
    Kata { id: "format", idx: 3, focus: Focus::Format, threshold: 60 },
    Kata { id: "constraints", idx: 4, focus: Focus::Constraints, threshold: 60 },
    Kata { id: "negative", idx: 5, focus: Focus::Negative, threshold: 60 },
    Kata { id: "example", idx: 6, focus: Focus::Example, threshold: 60 },
    Kata { id: "master", idx: 7, focus: Focus::All, threshold: 100 },
];

// ── Pure scoring ─────────────────────────────────────────────────────────────

/// Grade a spoken transcript against kata `k`. Pure given the text (reuses the
/// existing offline `prompt_coach::score_prompt` rubric). Returns
/// `(score 0..100, rubric booleans, focus_pass, passed)`. `passed = focus_pass
/// && score ≥ threshold` — which for the master (focus_pass = score==100,
/// threshold 100) collapses to `score == 100`, exactly the contract.
pub fn evaluate(k: &Kata, text: &str) -> (i64, serde_json::Value, bool, bool) {
    let (score, rubric) = crate::prompt_coach::score_prompt(text);
    let b = |key: &str| rubric[key].as_bool().unwrap_or(false);
    let focus_pass = match k.focus {
        Focus::Goal => b("goal"),
        Focus::Context => b("context"),
        Focus::Format => b("format"),
        Focus::Constraints => b("constraints"),
        Focus::Negative => b("negative"),
        Focus::Example => crate::prompt_coach::chk_few_shot(&text.to_lowercase()),
        Focus::All => score == 100,
    };
    let passed = focus_pass && score >= k.threshold;
    (score, rubric, focus_pass, passed)
}

// ── Pure belt (Obi) logic (contract §3) ──────────────────────────────────────

/// One belt rank and the minimum (katas_done, training_days, high_scores) it
/// needs. Requirements are monotonically non-decreasing across the array, so the
/// highest rank whose ALL conditions hold is simply the last satisfied index.
#[derive(Debug, Clone, Copy)]
struct RankReq {
    name: &'static str,
    katas: i64,
    days: i64,
    high: i64,
}

const RANKS: [RankReq; 7] = [
    RankReq { name: "white", katas: 0, days: 0, high: 0 },
    RankReq { name: "yellow", katas: 1, days: 0, high: 0 },
    RankReq { name: "orange", katas: 2, days: 2, high: 0 },
    RankReq { name: "green", katas: 3, days: 5, high: 0 },
    RankReq { name: "blue", katas: 4, days: 8, high: 0 },
    RankReq { name: "brown", katas: 6, days: 12, high: 0 },
    RankReq { name: "black", katas: 7, days: 16, high: 3 },
];

/// Index into `RANKS` of the highest rank whose every condition is met. White
/// (0/0/0) is the always-satisfied floor.
pub fn rank_index(katas_done: i64, training_days: i64, high_scores: i64) -> usize {
    let mut idx = 0;
    for (i, r) in RANKS.iter().enumerate() {
        if katas_done >= r.katas && training_days >= r.days && high_scores >= r.high {
            idx = i;
        }
    }
    idx
}

/// Build the belt payload (contract §5) + return the rank index. `next` = the
/// deltas to the next rank (each clamped ≥ 0), or null at black.
pub fn belt_from_counts(
    katas_done: i64,
    training_days: i64,
    high_scores: i64,
) -> (serde_json::Value, usize) {
    let idx = rank_index(katas_done, training_days, high_scores);
    let next = if idx + 1 < RANKS.len() {
        let nr = &RANKS[idx + 1];
        serde_json::json!({
            "rank": nr.name,
            "need_katas": (nr.katas - katas_done).max(0),
            "need_days": (nr.days - training_days).max(0),
            "need_high": (nr.high - high_scores).max(0),
        })
    } else {
        serde_json::Value::Null
    };
    let belt = serde_json::json!({
        "rank": RANKS[idx].name,
        "katas_done": katas_done,
        "training_days": training_days,
        "high_scores": high_scores,
        "next": next,
    });
    (belt, idx)
}

/// Linear-unlock state ("done"/"open"/"locked") per kata in catalog order, from
/// the progress map (id → (best_score, completed)). Completed katas are `done`;
/// the first non-completed is `open`; everything after is `locked`.
pub fn kata_states(progress: &HashMap<String, (i64, i64)>) -> Vec<&'static str> {
    let mut open_assigned = false;
    KATAS
        .iter()
        .map(|k| {
            let completed = progress.get(k.id).map(|(_, c)| *c).unwrap_or(0);
            if completed == 1 {
                "done"
            } else if !open_assigned {
                open_assigned = true;
                "open"
            } else {
                "locked"
            }
        })
        .collect()
}

// ── Store-backed helpers (belt snapshot + progress map) ───────────────────────

/// The progress map (id → (best_score, completed)) for `account`.
fn progress_map(account: &str) -> HashMap<String, (i64, i64)> {
    crate::store::kata_all(account)
        .into_iter()
        .map(|(k, b, c)| (k, (b, c)))
        .collect()
}

/// Current belt payload + rank index for `account`, read from the store:
/// `katas_done` = completed rows, `high_scores` = best_score ≥ 80 rows,
/// `training_days` = distinct days across dojo/kata/kata_train ledger kinds.
fn belt_snapshot(account: &str) -> (serde_json::Value, usize) {
    let all = crate::store::kata_all(account);
    let katas_done = all.iter().filter(|(_, _, c)| *c == 1).count() as i64;
    let high_scores = all.iter().filter(|(_, best, _)| *best >= KATA_HIGH_SCORE).count() as i64;
    let training_days = crate::store::learning_training_days(account);
    belt_from_counts(katas_done, training_days, high_scores)
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// The kata path + current belt for the Prompt-Halle home view (contract §5).
#[tauri::command]
pub fn kata_list(state: State<'_, AppState>) -> serde_json::Value {
    let account = crate::presets::account_key(&state.config.lock());
    let progress = progress_map(&account);
    let states = kata_states(&progress);
    let (belt, _) = belt_snapshot(&account);
    let katas: Vec<serde_json::Value> = KATAS
        .iter()
        .zip(states.iter())
        .map(|(k, st)| {
            let (best, _completed) = progress.get(k.id).copied().unwrap_or((0, 0));
            serde_json::json!({
                "id": k.id,
                "idx": k.idx,
                "state": *st,
                "best_score": best,
                "threshold": k.threshold,
                "focus": k.focus.as_str(),
            })
        })
        .collect();
    serde_json::json!({
        "belt": belt,
        "katas": katas,
        "seconds": KATA_SECONDS,
    })
}

/// Begin a kata recording. Refuses a LOCKED kata (or unknown id) with `Err("locked")`
/// BEFORE touching the recorder; any non-locked kata (done or open) is trainable.
/// Then mirrors `dojo_record_start`: grabs the shared recorder behind the
/// `session_active` guard and suspends the global hotkey for the take's life.
#[tauri::command]
pub fn kata_record_start(
    app: AppHandle,
    kata: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Gate on the kata's unlock state before claiming the recorder.
    let account = crate::presets::account_key(&state.config.lock());
    let states = kata_states(&progress_map(&account));
    match KATAS.iter().position(|k| k.id == kata) {
        Some(i) if states[i] != "locked" => {}
        _ => return Err("locked".into()),
    }

    if state.session_active.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let (dev, sound, vol, start_id) = {
        let c = state.config.lock();
        (c.mic_device_name.clone(), c.sound_start_enabled, c.sound_volume, c.sound_start_id.clone())
    };
    if let Err(msg) = state.recorder.start(if dev.is_empty() { None } else { Some(dev) }) {
        state.session_active.store(false, Ordering::SeqCst); // never strand the guard
        return Err(msg);
    }
    // Recorder is ours — lock out the hotkey pipeline for the kata's life.
    crate::hotkey::hotkey_set_suspended(app, true);
    if sound && start_id == "standard" {
        crate::sound::play_start(vol);
    }
    Ok(())
}

/// Current mic level (0..1) for the in-scroll kata meter. Polled while recording.
#[tauri::command]
pub fn kata_record_level(state: State<'_, AppState>) -> f32 {
    state.recorder.level()
}

/// Abort the kata, discard the audio, ALWAYS lift the hotkey suspend + guard.
#[tauri::command]
pub fn kata_record_cancel(app: AppHandle, state: State<'_, AppState>) {
    let _ = state.recorder.stop();
    state.session_active.store(false, Ordering::SeqCst);
    crate::hotkey::hotkey_set_suspended(app, false); // free the hotkey again
}

/// Stop + transcribe + score a kata (contract §5). `(async)`: transcription
/// blocks on the network. NO injection, NO history, NO synapse — the RAW
/// transcript (no cleanup) is scored and handed straight back with the belt. The
/// hotkey suspend + session guard are lifted the instant the mic is ours-and-
/// stopped, BEFORE the fallible transcribe step, so every error path frees them.
#[tauri::command(async)]
pub fn kata_record_stop(
    app: AppHandle,
    kata: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, EngineError> {
    // Take the capture while still holding the guard, then release guard + hotkey
    // before anything fallible (a racing dictation gates on session_active).
    let cap_result = state.recorder.stop();
    state.session_active.store(false, Ordering::SeqCst);
    crate::hotkey::hotkey_set_suspended(app.clone(), false);

    let cap = match cap_result {
        Some(c) if !c.samples.is_empty() => c,
        Some(_) => return Err(EngineError::new("empty", "leere Aufnahme")),
        None => return Err(EngineError::new("no_recording", "keine aktive Aufnahme")),
    };

    if state.config.lock().mode == "subunit" {
        crate::auth::ensure_fresh(&app);
    }
    let cfg = state.config.lock().clone();

    // Raw transcript ONLY — no cleanup (a kata is scored on what was actually
    // said; cleanup would smooth over the very markers we grade).
    let r = transcribe::run_opts(&cfg, &cap.samples, cap.sample_rate, false, None)?;
    if r.text.trim().is_empty() {
        return Err(EngineError::new("empty", "Keine Sprache erkannt – Mikrofon prüfen?"));
    }

    let account = crate::presets::account_key(&cfg);
    let day = crate::store::today_local();
    // Resolve the kata (start already gated locked; fall back to master defensively).
    let k = KATAS.iter().find(|k| k.id == kata).unwrap_or(&KATAS[KATAS.len() - 1]);
    let (score, rubric, focus_pass, passed) = evaluate(k, &r.text);

    // Rank BEFORE any writes from this attempt (contract: pre-update rank).
    let (_, rank_before) = belt_snapshot(&account);
    // Was this kata already completed before this attempt? Gates the 50-XP pass.
    let was_completed = crate::store::kata_all(&account)
        .into_iter()
        .find(|(id, ..)| *id == kata)
        .map(|(_, _, c)| c == 1)
        .unwrap_or(false);

    let now = unix_now();
    let mut xp_awarded = 0i64;
    let mut reward_events: Vec<serde_json::Value> = Vec::new();

    // kata_train: 10 XP for the first kata attempt of the local day (pass or fail).
    // learning_award is idempotent per (account, day, kind, word) → true once/day.
    if crate::store::learning_award(&account, &day, "kata_train", "train", KATA_TRAIN_XP, now) {
        xp_awarded += KATA_TRAIN_XP;
        reward_events
            .push(serde_json::json!({ "kind": "kata_train", "word": "train", "xp": KATA_TRAIN_XP }));
    }

    // Persist progress: best_score = MAX, completed sticky (a pass sets it 1).
    crate::store::kata_upsert(&account, &kata, score, if passed { 1 } else { 0 }, now);

    // first_pass = this pass flipped completed 0→1 for this kata.
    let first_pass = passed && !was_completed;
    // kata: 50 XP, once ever on the first pass. The was_completed gate (not the
    // day-scoped ledger) is what makes this once-EVER: a later re-pass on another
    // day would insert a new ledger row, but was_completed is then true → skipped.
    if first_pass && crate::store::learning_award(&account, &day, "kata", &kata, KATA_XP, now) {
        xp_awarded += KATA_XP;
        reward_events
            .push(serde_json::json!({ "kind": "kata", "word": &kata, "xp": KATA_XP }));
    }

    // best_score after the upsert (the persisted max, for the UI's "best" badge).
    let best_score = crate::store::kata_all(&account)
        .into_iter()
        .find(|(id, ..)| *id == kata)
        .map(|(_, b, _)| b)
        .unwrap_or(score);

    // Belt AFTER the writes, and whether the rank rose through this attempt.
    let (belt_after, rank_after) = belt_snapshot(&account);
    let belt_up: Option<&'static str> =
        if rank_after > rank_before { Some(RANKS[rank_after].name) } else { None };

    // ONE reward event carrying whatever was credited (mirrors dojo/prompt_coach).
    if !reward_events.is_empty() {
        let xp_total = crate::store::learning_xp(&account, None);
        let (level, _, _) = crate::commands::level_for_xp(xp_total);
        let _ = app.emit(
            "echo://learning-reward",
            serde_json::json!({ "events": reward_events, "xp_total": xp_total, "level": level }),
        );
        crate::commands::push_learning_score_detached(cfg.clone(), account.clone());
    }

    Ok(serde_json::json!({
        "transcript": r.text,
        "score": score,
        "rubric": rubric,
        "focus_pass": focus_pass,
        "passed": passed,
        "first_pass": first_pass,
        "best_score": best_score,
        "xp_awarded": xp_awarded,
        "belt": belt_after,
        "belt_up": belt_up,
    }))
}

// ── Tests (pure functions only; DB-touching cases live in store::round_trip) ──

#[cfg(test)]
mod tests {
    use super::*;

    /// (score, focus_pass, passed) for a kata id against `text`.
    fn ev(id: &str, text: &str) -> (i64, bool, bool) {
        let k = KATAS.iter().find(|k| k.id == id).expect("kata id");
        let (score, _r, focus_pass, passed) = evaluate(k, text);
        (score, focus_pass, passed)
    }

    fn rank(k: i64, d: i64, h: i64) -> &'static str {
        RANKS[rank_index(k, d, h)].name
    }

    #[test]
    fn catalog_is_the_contract() {
        let ids: Vec<&str> = KATAS.iter().map(|k| k.id).collect();
        assert_eq!(ids, ["goal", "context", "format", "constraints", "negative", "example", "master"]);
        let thresholds: Vec<i64> = KATAS.iter().map(|k| k.threshold).collect();
        assert_eq!(thresholds, [40, 40, 60, 60, 60, 60, 100]);
        // idx is 1-based and dense.
        for (i, k) in KATAS.iter().enumerate() {
            assert_eq!(k.idx, i as i64 + 1);
        }
        // focus strings per §5.
        assert_eq!(KATAS[5].focus.as_str(), "example");
        assert_eq!(KATAS[6].focus.as_str(), "all");
    }

    #[test]
    fn belt_matrix_all_ranks() {
        assert_eq!(rank(0, 0, 0), "white");
        assert_eq!(rank(1, 0, 0), "yellow");
        assert_eq!(rank(1, 1, 0), "yellow"); // orange needs 2 katas + 2 days
        assert_eq!(rank(2, 2, 0), "orange");
        assert_eq!(rank(3, 5, 0), "green");
        assert_eq!(rank(4, 8, 0), "blue");
        assert_eq!(rank(6, 12, 0), "brown");
        assert_eq!(rank(7, 16, 3), "black");
    }

    #[test]
    fn belt_boundary_cases() {
        // 6 Katas / 11 Tage → blue, NOT brown (brown needs 12 days).
        assert_eq!(rank(6, 11, 0), "blue");
        // 7 / 16 / 2 highs → brown, NOT black (black needs 3 highs).
        assert_eq!(rank(7, 16, 2), "brown");
        // Katas short for orange (needs 2), days/high plentiful → yellow.
        assert_eq!(rank(1, 99, 99), "yellow");
        // 3 katas but only 4 days → orange (green needs 5 days).
        assert_eq!(rank(3, 4, 0), "orange");
        // Black needs 16 days too: 7/15/5 → brown (days short).
        assert_eq!(rank(7, 15, 5), "brown");
        // Enough katas+days for black but only 3 highs required exactly.
        assert_eq!(rank(7, 16, 3), "black");
    }

    #[test]
    fn belt_next_deltas_and_black_has_no_next() {
        // Contract §5 example: yellow (1 kata, 3 days, 0 high) → next orange, need 1 kata.
        let (belt, idx) = belt_from_counts(1, 3, 0);
        assert_eq!(RANKS[idx].name, "yellow");
        assert_eq!(belt["rank"], "yellow");
        assert_eq!(belt["katas_done"], 1);
        assert_eq!(belt["training_days"], 3);
        assert_eq!(belt["high_scores"], 0);
        assert_eq!(belt["next"]["rank"], "orange");
        assert_eq!(belt["next"]["need_katas"], 1);
        assert_eq!(belt["next"]["need_days"], 0); // already past 2 days
        assert_eq!(belt["next"]["need_high"], 0);
        // White → next yellow needs 1 kata.
        let (w, _) = belt_from_counts(0, 0, 0);
        assert_eq!(w["rank"], "white");
        assert_eq!(w["next"]["rank"], "yellow");
        assert_eq!(w["next"]["need_katas"], 1);
        // Brown → next black needs the high-score jump surfaced.
        let (br, _) = belt_from_counts(6, 12, 0);
        assert_eq!(br["rank"], "brown");
        assert_eq!(br["next"]["rank"], "black");
        assert_eq!(br["next"]["need_katas"], 1); // 7-6
        assert_eq!(br["next"]["need_days"], 4); // 16-12
        assert_eq!(br["next"]["need_high"], 3); // 3-0
        // Black is terminal.
        let (bl, _) = belt_from_counts(7, 16, 3);
        assert_eq!(bl["rank"], "black");
        assert!(bl["next"].is_null());
    }

    #[test]
    fn kata_states_linear_unlock() {
        let mut p: HashMap<String, (i64, i64)> = HashMap::new();
        // Nothing done → first open, rest locked.
        let s = kata_states(&p);
        assert_eq!(s[0], "open");
        assert!(s[1..].iter().all(|x| *x == "locked"));
        // Complete katas 1+2 → both done, kata 3 open, rest locked.
        p.insert("goal".into(), (80, 1));
        p.insert("context".into(), (70, 1));
        let s = kata_states(&p);
        assert_eq!(&s[..4], &["done", "done", "open", "locked"]);
        // Attempted-but-not-passed (completed 0) still counts as NOT done → open.
        let mut p2: HashMap<String, (i64, i64)> = HashMap::new();
        p2.insert("goal".into(), (30, 0));
        let s2 = kata_states(&p2);
        assert_eq!(s2[0], "open");
        assert_eq!(s2[1], "locked");
    }

    #[test]
    fn kata_pass_matrix_goal_and_context() {
        // Kata 1 goal (threshold 40): pass = goal + one more criterion ≥ 40.
        let (s, f, p) = ev("goal", "Schreib eine Absage, maximal drei Sätze.");
        assert_eq!((s, f, p), (40, true, true));
        // focus without threshold: goal true, score 20 < 40 → fail.
        let (s, f, p) = ev("goal", "Schreib das.");
        assert!(s < 40 && f && !p, "goal below threshold: {s}");
        // threshold without focus: score 40 via constraints+negative, goal false → fail.
        let (s, f, p) = ev("goal", "Das Budget liegt bei maximal 100 Euro ohne weitere Kosten.");
        assert!(s >= 40 && !f && !p, "goal absent but score {s}");

        // Kata 2 context (threshold 40).
        let (s, f, p) = ev("context", "Erstelle eine Mail, weil der Kunde wartet.");
        assert!(s >= 40 && f && p, "context pass: {s}");
        // focus without threshold: context true, score < 40.
        let (s, f, p) = ev("context", "Der Hintergrund ist schwierig.");
        assert!(s < 40 && f && !p, "context below threshold: {s}");
        // threshold without focus: goal+format = 40, context false.
        let (s, f, p) = ev("context", "Schreib eine Liste.");
        assert!(s >= 40 && !f && !p, "context absent but score {s}");
    }

    #[test]
    fn kata_pass_matrix_format_constraints_negative() {
        // Kata 3 format (threshold 60).
        let (s, f, p) =
            ev("format", "Erstelle eine Tabelle mit maximal drei Zeilen, weil ich einen Überblick brauche.");
        assert!(s >= 60 && f && p, "format pass: {s}");
        let (s, f, p) = ev("format", "Gib mir eine Tabelle."); // 40 < 60, format true
        assert!(s < 60 && f && !p, "format below threshold: {s}");
        let (s, f, p) =
            ev("format", "Schreib eine Absage, weil der Termin maximal drei Tage entfernt ist ohne Aufschub.");
        assert!(s >= 60 && !f && !p, "format absent but score {s}");

        // Kata 4 constraints (threshold 60).
        let (s, f, p) =
            ev("constraints", "Erstelle eine Liste mit maximal drei Punkten, weil es kurz sein soll.");
        assert!(s >= 60 && f && p, "constraints pass: {s}");
        let (s, f, p) = ev("constraints", "Nur kurz."); // constraints true, score 20
        assert!(s < 60 && f && !p, "constraints below threshold: {s}");
        let (s, f, p) =
            ev("constraints", "Erstelle eine Tabelle, weil ich sie brauche, ohne Fachbegriffe.");
        assert!(s >= 60 && !f && !p, "constraints absent but score {s}");

        // Kata 5 negative (threshold 60).
        let (s, f, p) = ev(
            "negative",
            "Schreib einen Post ohne Anglizismen, weil er seriös wirken soll, maximal fünf Sätze.",
        );
        assert!(s >= 60 && f && p, "negative pass: {s}");
        let (s, f, p) = ev("negative", "Bitte ohne Füllwörter."); // negative true, score 20
        assert!(s < 60 && f && !p, "negative below threshold: {s}");
        let (s, f, p) = ev(
            "negative",
            "Erstelle eine Tabelle mit genau drei Zeilen, weil ich einen Überblick brauche.",
        );
        assert!(s >= 60 && !f && !p, "negative absent but score {s}");
    }

    #[test]
    fn kata_pass_matrix_example_and_master() {
        // Kata 6 example (threshold 60, focus = few-shot).
        let (s, f, p) = ev(
            "example",
            "Schreib ein Update, zum Beispiel: Ware ist raus, maximal fünf Wörter, ohne Floskeln.",
        );
        assert!(s >= 60 && f && p, "example pass: {s}");
        // focus without threshold: has an example but score < 60.
        let (s, f, p) = ev("example", "Zum Beispiel so ähnlich.");
        assert!(s < 60 && f && !p, "example below threshold: {s}");
        // threshold without focus: score ≥ 60 but no example marker.
        let (s, f, p) =
            ev("example", "Erstelle eine Tabelle mit maximal drei Zeilen ohne Fachbegriffe.");
        assert!(s >= 60 && !f && !p, "example marker absent but score {s}");

        // Kata 7 master: only a perfect 100 passes.
        let (s, f, p) = ev(
            "master",
            "Erstelle eine Tabelle mit genau 3 Spalten, weil ich einen klaren Überblick brauche, \
             und nutze nur belegte Zahlen, aber nicht mehr als nötig.",
        );
        assert_eq!((s, f, p), (100, true, true), "master 100 passes");
        // 80 (four criteria) fails the master.
        let (s, f, p) = ev(
            "master",
            "Erstelle eine Tabelle mit genau drei Spalten, weil ich einen Überblick brauche.",
        );
        assert!(s == 80 && !f && !p, "master 80 fails: {s}");
    }
}
