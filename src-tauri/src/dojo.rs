//! Rhetorik-Dojo (Welle 4) — spoken 45-second drills, scored 100 % on-device.
//!
//! Three drill kinds rotate one-per-day (deterministic by local date):
//!   * **Gauntlet** — speak freely on a topic; fillers cost points (fluency).
//!   * **Tabu**    — describe a term WITHOUT naming it or its taboo words.
//!   * **Besser sagen** — rephrase a weak sentence with precise, elevated words.
//!
//! The recording quartet mirrors `notes.rs` exactly (shared recorder + the
//! `session_active` guard, native start cue, NO overlay orb, NO history write,
//! NO injection) and additionally **suspends the global hotkey** while a drill
//! records — otherwise a Toggle-Off / Hold-Release would run the dictation
//! pipeline over the drill audio and inject it (hotkey.rs:194). The suspend is
//! ALWAYS lifted again in stop AND cancel, including every error path.
//!
//! Scoring is pure, deterministic and offline (no LLM in this wave): the three
//! `score_*` functions below take already-derived counts and return
//! `(score 0..100, Breakdown)`, which the `dojo_record_stop` command wraps for
//! the UI. XP (15, once per day, only at score ≥ 50) rides the existing
//! `store::learning_award` ledger under kind `"dojo"`, word = the drill kind.

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::analysis;
use crate::commands::AppState;
use crate::transcribe::{self, EngineError};

// ── Tuning constants ─────────────────────────────────────────────────────────

/// XP for a passed drill (once per day). Below `word_of_day` (50) — a drill is a
/// quick daily rep, taught vocabulary is the real work.
pub const DOJO_XP: i64 = 15;
/// Fixed drill length shown to the UI (the mic is user-stopped, not hard-cut).
pub const DOJO_SECONDS: i64 = 45;
/// Score at/above which a drill counts as passed (and earns XP).
pub const DOJO_PASS: i64 = 50;

const GAUNTLET_MIN_WORDS: usize = 40;
const GAUNTLET_FILLER_PENALTY: i64 = 12;
/// Below this many seconds the take can't be a real 45 s drill — flagged short
/// regardless of a padded word count.
const MIN_PLAUSIBLE_SECONDS: f64 = 5.0;

const TABU_MIN_WORDS: usize = 25;
const TABU_VIOLATION_PENALTY: i64 = 40;
const TABU_TERM_PENALTY: i64 = 30;

const BETTER_MIN_WORDS: usize = 8;
const BETTER_WEAK_PENALTY: i64 = 15;
const BETTER_VAGUE_PENALTY: i64 = 10;
const BETTER_ELEVATED_BONUS: i64 = 10;

// ── Exercise catalogs (const, ≥ 20 each) ─────────────────────────────────────

/// Everyday German speaking prompts for the Gauntlet (fluency under time).
pub const GAUNTLET_TOPICS: &[&str] = &[
    "Erkläre dein aktuelles Projekt in einfachen Worten.",
    "Was macht für dich gute Zusammenarbeit aus?",
    "Beschreibe deinen idealen Arbeitstag von morgens bis abends.",
    "Überzeuge jemanden, ein Buch zu lesen, das dir wichtig ist.",
    "Erkläre, wie du eine schwierige Entscheidung triffst.",
    "Was würdest du an deiner Stadt verbessern und warum?",
    "Beschreibe eine Fähigkeit, die du dieses Jahr lernen willst.",
    "Erkläre einem Kind, wie das Internet ungefähr funktioniert.",
    "Was bedeutet Erfolg für dich ganz persönlich?",
    "Stell ein Produkt vor, das du zuletzt gekauft hast.",
    "Erkläre, warum Pausen für die Produktivität wichtig sind.",
    "Beschreibe deinen Lieblingsort und warum er dir gefällt.",
    "Was hast du aus einem Fehler gelernt?",
    "Wie würdest du ein neues Team am ersten Tag motivieren?",
    "Beschreibe ein konkretes Ziel für die nächsten fünf Jahre.",
    "Überzeuge dein Team von einer neuen Idee.",
    "Erkläre den Unterschied zwischen wichtig und dringend.",
    "Was macht für dich eine gute Führungskraft aus?",
    "Beschreibe, wie du mit Stress im Alltag umgehst.",
    "Erkläre, warum dir ein bestimmtes Hobby Freude macht.",
];

/// One Tabu drill: name `begriff` WITHOUT saying it or any `taboo` word. Taboo
/// words are lowercase base forms — matched inflected, so "server" also blocks
/// "servern"/"servers".
#[derive(Debug, Clone, Copy)]
pub struct TabuTask {
    pub begriff: &'static str,
    pub taboo: [&'static str; 3],
}

pub const TABU_TASKS: &[TabuTask] = &[
    TabuTask { begriff: "Deployment", taboo: ["server", "code", "hochladen"] },
    TabuTask { begriff: "Meeting", taboo: ["besprechung", "termin", "reden"] },
    TabuTask { begriff: "Fahrrad", taboo: ["treten", "pedale", "lenker"] },
    TabuTask { begriff: "Kaffee", taboo: ["koffein", "tasse", "trinken"] },
    TabuTask { begriff: "Regenschirm", taboo: ["regen", "nass", "schützen"] },
    TabuTask { begriff: "Passwort", taboo: ["geheim", "anmelden", "sicherheit"] },
    TabuTask { begriff: "Bibliothek", taboo: ["bücher", "lesen", "ausleihen"] },
    TabuTask { begriff: "Ampel", taboo: ["rote", "grüne", "verkehr"] },
    TabuTask { begriff: "Kühlschrank", taboo: ["kalt", "essen", "küche"] },
    TabuTask { begriff: "Schlüssel", taboo: ["türe", "schloss", "öffnen"] },
    TabuTask { begriff: "Telefon", taboo: ["anrufen", "hören", "nummer"] },
    TabuTask { begriff: "Brille", taboo: ["sehen", "augen", "gläser"] },
    TabuTask { begriff: "Rechnung", taboo: ["geld", "bezahlen", "betrag"] },
    TabuTask { begriff: "Urlaub", taboo: ["reisen", "strand", "erholen"] },
    TabuTask { begriff: "Feuerwehr", taboo: ["feuer", "löschen", "brand"] },
    TabuTask { begriff: "Wecker", taboo: ["morgen", "klingeln", "aufwachen"] },
    TabuTask { begriff: "Landkarte", taboo: ["wege", "orientieren", "gebiet"] },
    TabuTask { begriff: "Impfung", taboo: ["spritze", "schutz", "arzt"] },
    TabuTask { begriff: "Aufzug", taboo: ["etage", "hoch", "fahren"] },
    TabuTask { begriff: "Kompass", taboo: ["norden", "nadel", "richtung"] },
];

/// Weak German sentences for "Besser sagen" — each stuffed with vague crutch
/// words (gut / machen / Dinge / Sache / irgendwie …) the speaker must replace
/// with precise, stronger vocabulary in their spoken rephrasing.
pub const BETTER_TASKS: &[&str] = &[
    "Das Projekt ist echt gut gelaufen und wir haben viele Dinge gemacht.",
    "Wir müssen die Sache irgendwie besser machen.",
    "Die Präsentation war schön und die Leute fanden sie gut.",
    "Ich habe da so ein paar Dinge, die man mal machen könnte.",
    "Das Meeting war irgendwie wichtig, aber wir haben nicht viel gemacht.",
    "Der neue Kollege macht seine Sachen eigentlich ganz gut.",
    "Wir sollten die Dinge einfach mal anders machen.",
    "Das Ergebnis ist gut, auch wenn ein paar Sachen fehlen.",
    "Die Idee ist irgendwie cool, aber schwierig zu machen.",
    "Er hat viele gute Dinge gesagt, die wir machen sollten.",
    "Das Tool ist ganz nett und macht so seine Sache.",
    "Wir haben das Problem irgendwie gelöst, war aber schwierig.",
    "Die Zahlen sehen gut aus, aber da sind noch ein paar Dinge offen.",
    "Ich finde, wir machen das schon ganz gut so.",
    "Das war ein schönes Gespräch und wir haben viel besprochen.",
    "Die App macht viele Dinge, aber irgendwie fehlt der Fokus.",
    "Der Plan ist gut, wir müssen nur ein paar Sachen anpassen.",
    "Das Feedback war irgendwie gemischt, aber überwiegend gut.",
    "Wir sollten die wichtigen Dinge einfach zuerst machen.",
    "Die Lösung ist gut und macht insgesamt einen schönen Eindruck.",
];

/// Prompt-Golf tasks — "get an AI to do X" in as few, as precise words as
/// possible. The user SPEAKS the prompt; it's scored on the prompt rubric plus a
/// brevity bonus (fewest words, cleanest ask wins).
pub const GOLF_TASKS: &[&str] = &[
    "Bring eine KI dazu, einen wöchentlichen Statusreport aus Stichpunkten zu bauen.",
    "Bring eine KI dazu, eine Einladung zu einem Termin höflich abzulehnen.",
    "Bring eine KI dazu, einen Code-Abschnitt zu reviewen und Risiken zu nennen.",
    "Bring eine KI dazu, einen langen Text in fünf Stichpunkten zusammenzufassen.",
    "Bring eine KI dazu, eine E-Mail an einen Kunden freundlich, aber bestimmt zu formulieren.",
    "Bring eine KI dazu, drei Namensvorschläge für ein Produkt zu liefern.",
    "Bring eine KI dazu, einen Fehler im Code zu finden und die Ursache zu erklären.",
    "Bring eine KI dazu, einen Fachtext für Einsteiger verständlich zu erklären.",
    "Bring eine KI dazu, eine Tabelle mit Vor- und Nachteilen zu erstellen.",
    "Bring eine KI dazu, einen Tweet mit maximal 200 Zeichen zu schreiben.",
    "Bring eine KI dazu, aus Notizen eine klare Aufgabenliste zu machen.",
    "Bring eine KI dazu, ein Meeting-Protokoll in Entscheidungen und To-dos zu gliedern.",
    "Bring eine KI dazu, einen Satz in drei verschiedenen Tonlagen umzuschreiben.",
    "Bring eine KI dazu, eine Idee mit einem konkreten Beispiel zu belegen.",
    "Bring eine KI dazu, Rückfragen zu stellen, bevor sie eine Aufgabe löst.",
];

// ── Deterministic per-day exercise pick ──────────────────────────────────────

/// djb2 (matches `analysis::pick_word_of_day`'s hash spirit) — stable across
/// builds/platforms, so a given date always maps to the same task.
fn djb2(s: &str) -> u64 {
    s.bytes().fold(5381u64, |h, b| {
        h.wrapping_shl(5).wrapping_add(h).wrapping_add(b as u64)
    })
}

/// Which drill kind runs today. Serialized as the ledger `word` + payload key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Gauntlet,
    Tabu,
    Better,
    Golf,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Gauntlet => "gauntlet",
            Kind::Tabu => "tabu",
            Kind::Better => "better",
            Kind::Golf => "golf",
        }
    }
}

/// The concrete drill chosen for a day: the rotated kind plus the one selected
/// catalog entry (only the field for that kind is populated).
#[derive(Debug, Clone)]
pub struct Exercise {
    pub kind: Kind,
    pub topic: Option<&'static str>,
    pub term: Option<&'static str>,
    pub taboo: Option<[&'static str; 3]>,
    pub weak_sentence: Option<&'static str>,
}

/// Deterministic drill for `day` ('YYYY-MM-DD'). `day_num` = days-since-epoch
/// (the caller passes `commands::day_number(day)`) and drives the KIND rotation
/// (gauntlet → tabu → better on consecutive days); the date HASH selects the
/// task within that kind's catalog — same pattern as
/// `analysis::pick_word_of_day`. Both inputs pure ⇒ trivially testable.
pub fn pick_exercise(day: &str, day_num: i64) -> Exercise {
    let kind = match day_num.rem_euclid(4) {
        0 => Kind::Gauntlet,
        1 => Kind::Tabu,
        2 => Kind::Better,
        _ => Kind::Golf,
    };
    let h = djb2(day) as usize;
    match kind {
        Kind::Gauntlet => Exercise {
            kind,
            topic: Some(GAUNTLET_TOPICS[h % GAUNTLET_TOPICS.len()]),
            term: None,
            taboo: None,
            weak_sentence: None,
        },
        Kind::Tabu => {
            let t = &TABU_TASKS[h % TABU_TASKS.len()];
            Exercise {
                kind,
                topic: None,
                term: Some(t.begriff),
                taboo: Some(t.taboo),
                weak_sentence: None,
            }
        }
        Kind::Better => Exercise {
            kind,
            topic: None,
            term: None,
            taboo: None,
            weak_sentence: Some(BETTER_TASKS[h % BETTER_TASKS.len()]),
        },
        // Golf reuses `topic` for the "get an AI to do X" task string (dojo_today
        // returns it under "topic", same as the Gauntlet).
        Kind::Golf => Exercise {
            kind,
            topic: Some(GOLF_TASKS[h % GOLF_TASKS.len()]),
            term: None,
            taboo: None,
            weak_sentence: None,
        },
    }
}

// ── Scoring (pure, offline, testable) ────────────────────────────────────────

/// Unified score breakdown across all three drills — fields not relevant to a
/// drill stay at their default (0 / [] / false). Serialized straight into the
/// `dojo_record_stop` payload's `breakdown`, so field names ARE the contract.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Breakdown {
    /// Word count of the spoken transcript (tokenizer tokens, ≥ 3 chars).
    pub words: usize,
    /// Fillers counted (Gauntlet: discourse fillers + hesitation sounds).
    pub fillers: i64,
    /// Taboo terms (and the term itself, if named) the speaker uttered.
    pub violations: Vec<String>,
    /// Weak/over-used words still present (Besser sagen).
    pub weak: i64,
    /// Vague discourse crutches still present (Besser sagen).
    pub vague: i64,
    /// Elevated (rarity-collectible) words used (Besser sagen bonus source).
    pub elevated: i64,
    /// True when the take was too short to score (below the word/second floor).
    pub too_short: bool,
    /// Prompt-Golf only: the 5-criteria rubric booleans (goal/context/…). None
    /// for the spoken drills, which leave `fillers`/`violations`/… as their signal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rubric: Option<serde_json::Value>,
}

fn clamp_score(raw: i64) -> i64 {
    raw.clamp(0, 100)
}

/// Gauntlet: fluency under time. `filler_hits` = discourse fillers + stripped
/// hesitation sounds (the caller sums both — see `dojo_record_stop`). Below the
/// word floor OR an implausibly short clip ⇒ score 0 + `too_short`. Otherwise
/// 100 − 12 per filler.
pub fn score_gauntlet(tokens: &[String], filler_hits: i64, dur_s: f64) -> (i64, Breakdown) {
    let words = tokens.len();
    let too_short = words < GAUNTLET_MIN_WORDS || dur_s < MIN_PLAUSIBLE_SECONDS;
    let bd = Breakdown { words, fillers: filler_hits, too_short, ..Default::default() };
    if too_short {
        return (0, bd); // fillers already reported in bd
    }
    let score = clamp_score(100 - GAUNTLET_FILLER_PENALTY * filler_hits.max(0));
    (score, bd)
}

/// Tabu: describe `begriff` without naming it or any `taboo` word (all matched
/// INFLECTED, so "server" also catches "servern"). −40 per taboo word said,
/// −30 if the term itself slips out. Below the word floor ⇒ score 0.
pub fn score_tabu(tokens: &[String], begriff: &str, taboo: &[&str]) -> (i64, Breakdown) {
    let words = tokens.len();
    let mut violations: Vec<String> = Vec::new();
    for &t in taboo {
        let t_lc = t.to_lowercase();
        if tokens.iter().any(|tok| analysis::matches_inflected(&t_lc, tok)) {
            violations.push(t_lc);
        }
    }
    let begriff_lc = begriff.to_lowercase();
    let said_term = tokens.iter().any(|tok| analysis::matches_inflected(&begriff_lc, tok));
    if said_term {
        violations.push(begriff_lc);
    }

    let too_short = words < TABU_MIN_WORDS;
    let mut bd = Breakdown { words, violations: violations.clone(), too_short, ..Default::default() };
    if too_short {
        return (0, bd);
    }
    let taboo_hits = if said_term { violations.len() as i64 - 1 } else { violations.len() as i64 };
    let raw = 100 - TABU_VIOLATION_PENALTY * taboo_hits - if said_term { TABU_TERM_PENALTY } else { 0 };
    bd.too_short = false;
    (clamp_score(raw), bd)
}

/// Besser sagen: rephrase precisely. 100 − 15 per weak word − 10 per vague
/// crutch, +10 if ≥ 1 elevated (rarity-collectible, band ≥ 1) word is used.
/// Below the word floor ⇒ score 0. `elevated` is derived from the tokens here
/// (via `rarity::lookup`) so the whole rubric stays in one pure, tested place.
pub fn score_better(tokens: &[String], weak_hits: i64, vague_hits: i64) -> (i64, Breakdown) {
    let words = tokens.len();
    let elevated = tokens.iter().filter(|t| crate::rarity::lookup(t).is_some()).count() as i64;
    let too_short = words < BETTER_MIN_WORDS;
    let mut bd = Breakdown {
        words,
        weak: weak_hits,
        vague: vague_hits,
        elevated,
        too_short,
        ..Default::default()
    };
    if too_short {
        return (0, bd);
    }
    let mut raw = 100 - BETTER_WEAK_PENALTY * weak_hits.max(0) - BETTER_VAGUE_PENALTY * vague_hits.max(0);
    if elevated >= 1 {
        raw += BETTER_ELEVATED_BONUS;
    }
    bd.too_short = false;
    (clamp_score(raw), bd)
}

/// Below this many spoken words a golf prompt earns the brevity bonus.
const GOLF_TERSE_WORDS: usize = 40;
/// Above this many words the prompt is rambling — a length malus.
const GOLF_VERBOSE_WORDS: usize = 80;
const GOLF_TERSE_BONUS: i64 = 10;
const GOLF_VERBOSE_PENALTY: i64 = 20;

/// Prompt-Golf: score the SPOKEN prompt on the 5-criteria rubric (scaled to a
/// 90-point ceiling: ÷20 ×18) plus a brevity bonus (≤ 40 words +10) minus a
/// length malus (> 80 words −20), clamped 0..100. `fillers`/`violations`/… stay
/// neutral; the rubric booleans ride along in `Breakdown::rubric`.
pub fn score_golf(tokens: &[String], text: &str) -> (i64, Breakdown) {
    let words = tokens.len();
    let (rubric_score, rubric) = crate::prompt_coach::score_prompt(text); // 0..100, steps of 20
    let base = rubric_score / 20 * 18; // 0..90
    let mut raw = base;
    if words <= GOLF_TERSE_WORDS {
        raw += GOLF_TERSE_BONUS;
    }
    if words > GOLF_VERBOSE_WORDS {
        raw -= GOLF_VERBOSE_PENALTY;
    }
    let bd = Breakdown { words, rubric: Some(rubric), ..Default::default() };
    (clamp_score(raw), bd)
}

/// Score today's drill against the spoken transcript. Returns `(score, kind,
/// breakdown)`. Pure given the transcript + the day's exercise; the command
/// layer supplies the transcript and the filler-count inputs.
fn score_for(
    ex: &Exercise,
    text: &str,
    fillers_removed: i64,
    dur_s: f64,
) -> (i64, Breakdown) {
    let tokens = analysis::tokenize(text);
    match ex.kind {
        Kind::Gauntlet => {
            // Discourse fillers survive `run_opts` post-processing in `text`;
            // hesitation sounds ("äh"/"ähm"/"hmm") were already stripped and are
            // reported separately as `fillers_removed`. Total = both.
            let discourse = tokens.iter().filter(|t| analysis::is_discourse_filler(t)).count() as i64;
            score_gauntlet(&tokens, discourse + fillers_removed, dur_s)
        }
        Kind::Tabu => {
            let begriff = ex.term.unwrap_or("");
            let taboo = ex.taboo.unwrap_or([""; 3]);
            score_tabu(&tokens, begriff, &taboo)
        }
        Kind::Better => {
            let weak = tokens.iter().filter(|t| analysis::is_weak_word(t)).count() as i64;
            let vague = tokens.iter().filter(|t| analysis::is_discourse_filler(t)).count() as i64;
            score_better(&tokens, weak, vague)
        }
        Kind::Golf => score_golf(&tokens, text),
    }
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// The day's exercise + whether it's already done, for the Dojo home card.
#[tauri::command]
pub fn dojo_today(state: State<'_, AppState>) -> serde_json::Value {
    let account = crate::presets::account_key(&state.config.lock());
    let day = crate::store::today_local();
    let day_num = crate::commands::day_number(&day).unwrap_or(0);
    let ex = pick_exercise(&day, day_num);
    serde_json::json!({
        "kind": ex.kind.as_str(),
        "topic": ex.topic,
        "term": ex.term,
        "taboo": ex.taboo.map(|t| t.to_vec()),
        "weak_sentence": ex.weak_sentence,
        "seconds": DOJO_SECONDS,
        "xp": DOJO_XP,
        "done_today": crate::store::learning_event_exists(&account, &day, "dojo"),
    })
}

/// Begin a drill recording. Shares the recorder + `session_active` guard with
/// dictation/notes (refuses if busy) AND suspends the global hotkey so a
/// Toggle/Hold can't hijack the drill audio into the dictation pipeline.
#[tauri::command]
pub fn dojo_record_start(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
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
    // Recorder is ours — now lock out the hotkey pipeline for the drill's life.
    crate::hotkey::hotkey_set_suspended(app, true);
    if sound && start_id == "standard" {
        crate::sound::play_start(vol);
    }
    Ok(())
}

/// Current mic level (0..1) for the in-sheet drill meter. Polled while recording.
#[tauri::command]
pub fn dojo_record_level(state: State<'_, AppState>) -> f32 {
    state.recorder.level()
}

/// Abort the drill, discard the audio, ALWAYS lift the hotkey suspend + guard.
#[tauri::command]
pub fn dojo_record_cancel(app: AppHandle, state: State<'_, AppState>) {
    let _ = state.recorder.stop();
    state.session_active.store(false, Ordering::SeqCst);
    crate::hotkey::hotkey_set_suspended(app, false); // free the hotkey again
}

/// Stop + transcribe + score today's drill. `(async)`: transcription blocks on
/// the network (learning_suggestions rule). NO injection, NO history, NO
/// synapse — the transcript is handed straight back with the score. The hotkey
/// suspend + session guard are lifted the instant the mic is ours-and-stopped,
/// BEFORE the fallible transcribe step, so every error path leaves them free.
#[tauri::command(async)]
pub fn dojo_record_stop(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, EngineError> {
    // Take the capture while still holding the guard (a racing dictation gates on
    // session_active), then release guard + hotkey before anything fallible.
    let cap_result = state.recorder.stop();
    state.session_active.store(false, Ordering::SeqCst);
    crate::hotkey::hotkey_set_suspended(app.clone(), false);

    let cap = match cap_result {
        Some(c) if !c.samples.is_empty() => c,
        Some(_) => return Err(EngineError::new("empty", "leere Aufnahme")),
        None => return Err(EngineError::new("no_recording", "keine aktive Aufnahme")),
    };
    let dur_s = cap.samples.len() as f64 / cap.sample_rate.max(1) as f64;

    if state.config.lock().mode == "subunit" {
        crate::auth::ensure_fresh(&app);
    }
    let cfg = state.config.lock().clone();

    // Raw transcript ONLY — no cleanup (a drill is scored on what was actually
    // said; cleanup would smooth over the very fillers/weak words we grade).
    let r = transcribe::run_opts(&cfg, &cap.samples, cap.sample_rate, false, None)?;
    if r.text.trim().is_empty() {
        return Err(EngineError::new("empty", "Keine Sprache erkannt – Mikrofon prüfen?"));
    }

    let account = crate::presets::account_key(&cfg);
    let day = crate::store::today_local();
    let day_num = crate::commands::day_number(&day).unwrap_or(0);
    let ex = pick_exercise(&day, day_num);

    // Hesitation sounds stripped by run_opts (äh/ähm/hmm) — summed for Gauntlet.
    let fillers_removed: i64 = r.fillers_removed.iter().map(|(_, n)| *n).sum();
    let (score, bd) = score_for(&ex, &r.text, fillers_removed, dur_s);

    // XP once per day, only on a pass, only the first time (learning_award is
    // idempotent per account+day+kind+word ⇒ returns true only on first insert).
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut xp_awarded = 0i64;
    if score >= DOJO_PASS
        && crate::store::learning_award(&account, &day, "dojo", ex.kind.as_str(), DOJO_XP, now)
    {
        xp_awarded = DOJO_XP;
        let xp_total = crate::store::learning_xp(&account, None);
        let (level, _, _) = crate::commands::level_for_xp(xp_total);
        let _ = app.emit(
            "echo://learning-reward",
            serde_json::json!({
                "events": [{ "kind": "dojo", "word": ex.kind.as_str(), "xp": DOJO_XP }],
                "xp_total": xp_total,
                "level": level,
            }),
        );
        crate::commands::push_learning_score_detached(cfg.clone(), account.clone());
    }

    Ok(serde_json::json!({
        "transcript": r.text,
        "score": score,
        "xp_awarded": xp_awarded,
        "breakdown": bd,
    }))
}

/// Weekly quest progress (Monday-anchored calendar week, like the leaderboard).
#[tauri::command]
pub fn quests_get(state: State<'_, AppState>) -> serde_json::Value {
    let account = crate::presets::account_key(&state.config.lock());
    let today = crate::store::today_local();
    let week = crate::commands::week_monday(&today);
    let workouts = crate::store::learning_kind_days_since(&account, "dojo", &week);
    let coach = crate::store::learning_kind_count_since(&account, "coach_word", &week);
    let from_ts = crate::commands::day_number(&week).unwrap_or(0) * 86_400;
    let finds = crate::store::word_finds_between(&account, from_ts, i64::MAX);
    serde_json::json!({
        "quests": [
            { "id": "workouts_3", "progress": workouts, "target": 3 },
            { "id": "coach_5", "progress": coach, "target": 5 },
            { "id": "find_1", "progress": finds, "target": 1 },
        ]
    })
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    /// N filler-free content tokens for length gating.
    fn filler_words(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("wort{i:03}")).collect()
    }

    #[test]
    fn catalogs_have_at_least_20() {
        assert!(GAUNTLET_TOPICS.len() >= 20, "gauntlet {}", GAUNTLET_TOPICS.len());
        assert!(TABU_TASKS.len() >= 20, "tabu {}", TABU_TASKS.len());
        assert!(BETTER_TASKS.len() >= 20, "better {}", BETTER_TASKS.len());
        assert!(GOLF_TASKS.len() >= 15, "golf {}", GOLF_TASKS.len());
        for t in TABU_TASKS {
            assert_eq!(t.taboo.len(), 3);
            for w in t.taboo {
                assert!(w.chars().count() >= 3, "taboo word too short: {w}");
                assert_eq!(w, w.to_lowercase(), "taboo word must be lowercase: {w}");
            }
        }
    }

    #[test]
    fn gauntlet_three_fillers() {
        let mut tokens = filler_words(40);
        let (score, bd) = score_gauntlet(&tokens, 3, 45.0);
        assert_eq!(score, 100 - 36);
        assert_eq!(bd.words, 40);
        assert_eq!(bd.fillers, 3);
        assert!(!bd.too_short);
        // Zero fillers → perfect.
        tokens.push("noch".into());
        assert_eq!(score_gauntlet(&tokens, 0, 45.0).0, 100);
    }

    #[test]
    fn gauntlet_too_short_by_words_and_by_seconds() {
        let (score, bd) = score_gauntlet(&filler_words(39), 0, 45.0);
        assert_eq!(score, 0);
        assert!(bd.too_short);
        // Enough words but the clip is implausibly short.
        let (s2, bd2) = score_gauntlet(&filler_words(50), 0, 2.0);
        assert_eq!(s2, 0);
        assert!(bd2.too_short);
    }

    #[test]
    fn gauntlet_fillers_never_drive_below_zero() {
        let (score, _) = score_gauntlet(&filler_words(40), 20, 45.0);
        assert_eq!(score, 0); // 100 - 240 clamped
    }

    #[test]
    fn tabu_violation_inflected() {
        // "server" is taboo; the speaker says the inflected "servern" → violation.
        let mut tokens = filler_words(24); // + 1 below → 25 words, meets floor
        tokens.push("servern".into());
        let (score, bd) = score_tabu(&tokens, "Deployment", &["server", "code", "hochladen"]);
        assert_eq!(bd.words, 25);
        assert!(bd.violations.contains(&"server".to_string()));
        assert_eq!(score, 100 - 40);
        assert!(!bd.too_short);
    }

    #[test]
    fn tabu_clean_run_scores_full() {
        let tokens = filler_words(30);
        let (score, bd) = score_tabu(&tokens, "Deployment", &["server", "code", "hochladen"]);
        assert_eq!(score, 100);
        assert!(bd.violations.is_empty());
    }

    #[test]
    fn tabu_saying_the_term_itself() {
        let mut tokens = filler_words(30);
        tokens.push("deployment".into());
        let (score, bd) = score_tabu(&tokens, "Deployment", &["server", "code", "hochladen"]);
        assert_eq!(score, 100 - 30);
        assert!(bd.violations.contains(&"deployment".to_string()));
    }

    #[test]
    fn tabu_too_short() {
        let mut tokens = filler_words(10);
        tokens.push("server".into());
        let (score, bd) = score_tabu(&tokens, "Deployment", &["server", "code", "hochladen"]);
        assert_eq!(score, 0);
        assert!(bd.too_short);
        // Violations are still surfaced for feedback even when too short.
        assert!(bd.violations.contains(&"server".to_string()));
    }

    #[test]
    fn better_with_elevated_word_bonus() {
        // 10 content words incl. one rarity-collectible word ("diskrepanz"),
        // 1 weak word ("gut"), 0 vague → 100 - 15 + 10 = 95.
        let mut tokens = filler_words(8);
        tokens.push("gut".into());
        tokens.push("diskrepanz".into());
        let weak = 1;
        let vague = 0;
        let (score, bd) = score_better(&tokens, weak, vague);
        assert_eq!(bd.elevated, 1, "diskrepanz should be collectible");
        assert_eq!(score, 100 - 15 + 10);
        assert!(!bd.too_short);
    }

    #[test]
    fn better_weak_and_vague_penalties() {
        // No elevated word → no bonus. 2 weak, 1 vague → 100 - 30 - 10 = 60.
        let tokens = filler_words(10);
        let (score, bd) = score_better(&tokens, 2, 1);
        assert_eq!(score, 60);
        assert_eq!(bd.elevated, 0);
        assert_eq!(bd.weak, 2);
        assert_eq!(bd.vague, 1);
    }

    #[test]
    fn better_too_short() {
        let (score, bd) = score_better(&toks(&["das", "ist", "gut"]), 1, 0);
        assert_eq!(score, 0);
        assert!(bd.too_short);
    }

    #[test]
    fn pick_exercise_is_deterministic() {
        let a = pick_exercise("2026-07-14", 20648);
        let b = pick_exercise("2026-07-14", 20648);
        assert_eq!(a.kind, b.kind);
        assert_eq!(a.topic, b.topic);
        assert_eq!(a.term, b.term);
        assert_eq!(a.weak_sentence, b.weak_sentence);
    }

    #[test]
    fn pick_exercise_kind_rotates_daily() {
        // Four consecutive day numbers must cycle through all four kinds.
        let k0 = pick_exercise("2026-01-01", 0).kind;
        let k1 = pick_exercise("2026-01-02", 1).kind;
        let k2 = pick_exercise("2026-01-03", 2).kind;
        let k3 = pick_exercise("2026-01-04", 3).kind;
        let k4 = pick_exercise("2026-01-05", 4).kind;
        assert_eq!(k0, Kind::Gauntlet);
        assert_eq!(k1, Kind::Tabu);
        assert_eq!(k2, Kind::Better);
        assert_eq!(k3, Kind::Golf);
        assert_eq!(k4, Kind::Gauntlet); // wraps
        // Negative day numbers (rem_euclid) still land in-range.
        assert_eq!(pick_exercise("1969-12-31", -1).kind, Kind::Golf);
    }

    #[test]
    fn pick_exercise_populates_only_its_kind() {
        let g = pick_exercise("2026-01-01", 0);
        assert!(g.topic.is_some() && g.term.is_none() && g.weak_sentence.is_none());
        let t = pick_exercise("2026-01-02", 1);
        assert!(t.term.is_some() && t.taboo.is_some() && t.topic.is_none());
        let b = pick_exercise("2026-01-03", 2);
        assert!(b.weak_sentence.is_some() && b.term.is_none() && b.topic.is_none());
        // Golf carries its task in `topic`, everything else empty.
        let gf = pick_exercise("2026-01-04", 3);
        assert_eq!(gf.kind, Kind::Golf);
        assert!(gf.topic.is_some() && gf.term.is_none() && gf.weak_sentence.is_none());
    }

    #[test]
    fn golf_short_precise_beats_rambling() {
        // A short, precise prompt hits 4 rubric criteria (goal/constraints/format/
        // negative) → 80/100 → base 72 + brevity 10 = 82.
        let precise = "Erstelle eine Tabelle mit genau 3 Zeilen, nicht mehr.";
        let ptoks = analysis::tokenize(precise);
        let (s, bd) = score_golf(&ptoks, precise);
        assert!(s >= 70, "precise golf prompt should score high, was {s}");
        assert!(bd.rubric.is_some(), "golf breakdown carries the rubric");
        assert_eq!(bd.violations.len(), 0); // spoken-drill fields stay neutral
        assert_eq!(bd.fillers, 0);
        // A long, rambling prompt with no rubric markers → base low, length malus.
        let rambly_text = vec!["blah"; 85].join(" ");
        let rtoks = analysis::tokenize(&rambly_text);
        assert_eq!(rtoks.len(), 85);
        let (rs, _) = score_golf(&rtoks, &rambly_text);
        assert!(rs < 40, "rambling golf prompt should score low, was {rs}");
        assert!(rs < s, "precise must beat rambling");
    }
}
