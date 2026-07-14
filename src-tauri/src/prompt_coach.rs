//! Prompt-Coach (Welle 5) — deterministic, offline, post-hoc scoring of the
//! dictations that landed in a KI/prompt surface, plus a "Prompt-Pattern of the
//! day" the user learns like the words of the day.
//!
//! Nothing here touches the network or the hot dictation path's latency: a
//! prompt is scored AFTER it was already delivered (see the hook in
//! `commands::do_transcribe`), against a fixed 5-criteria rubric (20 points
//! each). The pattern-of-the-day rides the exact same `learning_award` ledger +
//! `echo://learning-reward` event as the vocabulary coach, so the UI needs no
//! new reward plumbing.
//!
//! Matching is whole-word (token-boundary respecting), NOT substring — so "nur"
//! never fires inside "Nürnberg" and "code" never inside "codieren". Two-word
//! markers ("step by step") and apostrophes ("don't") are matched literally.

use crate::config::Config;

/// XP for applying the day's prompt pattern (once per local day). Between a coach
/// word (20) and the word of the day (50): a pattern is a deliberate craft rep.
pub const PROMPT_PATTERN_XP: i64 = 30;

// ── Rubric marker tables (DE + EN, all lowercase) ────────────────────────────

/// Imperative verbs that mark a clear ASK. Prefix-matched against the first
/// tokens (stems like "schreib" catch "schreibe"/"schreibst"); a plain question
/// (`?`) also satisfies the goal criterion.
const GOAL_VERBS: &[&str] = &[
    "schreib", "erstelle", "baue", "erkläre", "analysiere", "fasse", "generiere", "gib", "liste",
    "übersetze", "implementiere", "fixe", "refactor", "write", "create", "build", "explain",
    "summarize", "generate", "list", "implement", "fix",
];

/// Background / reasoning markers — the prompt says WHY, giving the model context.
const CONTEXT_MARKERS: &[&str] =
    &["weil", "damit", "kontext", "hintergrund", "because", "context", "background"];

/// Bound / limit markers — a concrete number in the text also counts.
const CONSTRAINT_MARKERS: &[&str] = &[
    "maximal", "mindestens", "genau", "höchstens", "nur", "limit", "max", "min", "exactly", "only",
];

/// Explicit output-shape markers.
const FORMAT_MARKERS: &[&str] = &[
    "liste", "tabelle", "json", "markdown", "stichpunkte", "schritte", "absatz", "code", "list",
    "table", "bullet", "steps", "paragraph", "format",
];

/// "Don't / avoid / without" markers — steering the model away from something.
const NEGATIVE_MARKERS: &[&str] =
    &["nicht", "keine", "ohne", "vermeide", "niemals", "don't", "avoid", "never", "without", "no"];

// ── Whole-word matcher ───────────────────────────────────────────────────────

/// True when `needle` (lowercase) occurs in `hay` (lowercase) as a WHOLE word —
/// flanked by a non-alphanumeric char or a string edge on both sides. Handles
/// multi-word markers ("step by step") and apostrophes ("don't") literally, and,
/// unlike substring matching, keeps "nur" out of "Nürnberg" and "code" out of
/// "codieren". Unicode-correct (checks the flanking *chars*, not bytes).
fn has_word(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let mut from = 0;
    while let Some(rel) = hay[from..].find(needle) {
        let start = from + rel;
        let end = start + needle.len();
        let before_ok = start == 0
            || !hay[..start]
                .chars()
                .next_back()
                .map(|c| c.is_alphanumeric())
                .unwrap_or(false);
        let after_ok = end == hay.len()
            || !hay[end..].chars().next().map(|c| c.is_alphanumeric()).unwrap_or(false);
        if before_ok && after_ok {
            return true;
        }
        from = end; // advance past this occurrence (a char boundary)
    }
    false
}

/// Any of `needles` present as a whole word in `hay` (lowercase).
fn has_any(hay: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| has_word(hay, n))
}

// ── Rubric scoring ───────────────────────────────────────────────────────────

/// Score `text` against the 5-criteria prompt rubric (20 points each, 0..100).
/// Returns the score plus the per-criterion booleans (`goal`/`context`/
/// `constraints`/`format`/`negative`) — the field names ARE the wire contract.
/// Pure, deterministic, allocation-light (< 1 ms) — safe to call inline.
pub fn score_prompt(text: &str) -> (i64, serde_json::Value) {
    let lc = text.to_lowercase();
    let tokens = crate::analysis::tokenize(text);
    let words = text.split_whitespace().count();
    let has_digit = text.chars().any(|c| c.is_ascii_digit());

    // goal: an imperative verb among the first 8 tokens, OR the prompt asks a
    // question. Prefix match so "schreib" catches "schreibe".
    let goal = text.contains('?')
        || tokens
            .iter()
            .take(8)
            .any(|t| GOAL_VERBS.iter().any(|v| t.starts_with(v)));
    // context: enough words to carry background, OR an explicit reason marker.
    let context = words >= 25 || has_any(&lc, CONTEXT_MARKERS);
    // constraints: a concrete number, OR a bound/limit marker.
    let constraints = has_digit || has_any(&lc, CONSTRAINT_MARKERS);
    // format: an explicit output-shape marker.
    let format = has_any(&lc, FORMAT_MARKERS);
    // negative: an explicit "don't / without" instruction.
    let negative = has_any(&lc, NEGATIVE_MARKERS);

    let score = 20
        * (goal as i64 + context as i64 + constraints as i64 + format as i64 + negative as i64);
    (
        score,
        serde_json::json!({
            "goal": goal,
            "context": context,
            "constraints": constraints,
            "format": format,
            "negative": negative,
        }),
    )
}

// ── Prompt patterns (the "of the day" catalog) ───────────────────────────────

/// One learnable prompt pattern: an id (also the ledger `word` + the UI i18n key)
/// and a pure check over the LOWERCASE prompt text.
pub struct Pattern {
    pub id: &'static str,
    pub check: fn(&str) -> bool,
}

fn chk_role(t: &str) -> bool {
    has_any(
        t,
        &["du bist", "you are", "act as", "in der rolle", "als experte", "agiere als", "handle als"],
    )
}
fn chk_context_anchor(t: &str) -> bool {
    t.split_whitespace().count() >= 25 || has_any(t, CONTEXT_MARKERS)
}
fn chk_constraints_first(t: &str) -> bool {
    // A bound/limit stated up front (first 12 words) — constraints where they
    // steer the whole answer, not buried at the end.
    let head: String = t.split_whitespace().take(12).collect::<Vec<_>>().join(" ");
    head.chars().any(|c| c.is_ascii_digit()) || has_any(&head, CONSTRAINT_MARKERS)
}
fn chk_output_format(t: &str) -> bool {
    has_any(t, FORMAT_MARKERS)
}
fn chk_negative(t: &str) -> bool {
    has_any(t, NEGATIVE_MARKERS)
}
fn chk_few_shot(t: &str) -> bool {
    has_any(
        t,
        &["zum beispiel", "beispiel", "beispiele", "beispielsweise", "example", "for example", "e.g."],
    )
}
fn chk_step_by_step(t: &str) -> bool {
    has_any(
        t,
        &[
            "schritt für schritt",
            "step by step",
            "denk zuerst",
            "think step by step",
            "überlege dir zuerst",
            "zuerst nachdenken",
        ],
    )
}
fn chk_audience(t: &str) -> bool {
    has_any(
        t,
        &[
            "zielgruppe",
            "für anfänger",
            "für einsteiger",
            "für ein publikum",
            "for beginners",
            "for a beginner",
            "audience",
            "laienverständlich",
        ],
    )
}
fn chk_tone(t: &str) -> bool {
    has_any(t, &["ton", "stil", "tone", "style", "förmlich", "locker"])
}
fn chk_iterate(t: &str) -> bool {
    has_any(
        t,
        &["frag nach", "stell rückfragen", "stelle rückfragen", "ask me", "ask clarifying", "rückfragen", "frag zuerst"],
    )
}
fn chk_sources(t: &str) -> bool {
    has_any(t, &["quellen", "belege", "sources", "cite", "zitiere", "quellenangaben"])
}
fn chk_length(t: &str) -> bool {
    has_any(
        t,
        &["kurz", "knapp", "words", "sentences", "briefly", "sätzen", "wörtern", "in einem satz"],
    )
}

/// The 12 patterns rotated one-per-day. Order fixed (the date hash picks the
/// index) so a given day always teaches the same pattern.
pub static PATTERNS: [Pattern; 12] = [
    Pattern { id: "role", check: chk_role },
    Pattern { id: "context_anchor", check: chk_context_anchor },
    Pattern { id: "constraints_first", check: chk_constraints_first },
    Pattern { id: "output_format", check: chk_output_format },
    Pattern { id: "negative", check: chk_negative },
    Pattern { id: "few_shot", check: chk_few_shot },
    Pattern { id: "step_by_step", check: chk_step_by_step },
    Pattern { id: "audience", check: chk_audience },
    Pattern { id: "tone", check: chk_tone },
    Pattern { id: "iterate", check: chk_iterate },
    Pattern { id: "sources", check: chk_sources },
    Pattern { id: "length", check: chk_length },
];

/// djb2 — same stable date-hash the vocabulary/dojo pickers use, so the mapping
/// day → pattern is deterministic across builds and platforms.
fn djb2(s: &str) -> u64 {
    s.bytes()
        .fold(5381u64, |h, b| h.wrapping_shl(5).wrapping_add(h).wrapping_add(b as u64))
}

/// The pattern taught on `day` ('YYYY-MM-DD') — date-hashed like the word of the
/// day.
pub fn pick_pattern(day: &str) -> &'static Pattern {
    let idx = (djb2(day) % PATTERNS.len() as u64) as usize;
    &PATTERNS[idx]
}

// ── Pattern reward (mirrors commands::maybe_award_vocab) ──────────────────────

/// Recognize the day's pattern in a prompt dictation and reward it once per local
/// day: the same `learning_award` ledger, `echo://learning-reward` event and
/// native notification the vocabulary coach uses (so the reward toast is
/// identical). Only ever called for `is_prompt` dictations; inline + deterministic
/// (< 1 ms). Returns the awarded pattern id, or None (no match / already earned).
pub fn maybe_award_pattern(
    app: &tauri::AppHandle,
    cfg: &Config,
    account: &str,
    text: &str,
    now: i64,
) -> Option<String> {
    if text.trim().is_empty() {
        return None;
    }
    let day = crate::store::today_local();
    if day.is_empty() {
        return None;
    }
    let pat = pick_pattern(&day);
    let lc = text.to_lowercase();
    if !(pat.check)(&lc) {
        return None;
    }
    // Idempotent per (account, day, "prompt_pattern", id) — true only on first insert.
    if !crate::store::learning_award(account, &day, "prompt_pattern", pat.id, PROMPT_PATTERN_XP, now)
    {
        return None;
    }
    let xp_total = crate::store::learning_xp(account, None);
    let (level, _, _) = crate::commands::level_for_xp(xp_total);
    let events =
        vec![serde_json::json!({ "kind": "prompt_pattern", "word": pat.id, "xp": PROMPT_PATTERN_XP })];
    use tauri::Emitter;
    let _ = app.emit(
        "echo://learning-reward",
        serde_json::json!({ "events": events, "xp_total": xp_total, "level": level }),
    );
    notify_pattern(app, &cfg.ui_language);
    crate::commands::push_learning_score_detached(cfg.clone(), account.to_string());
    Some(pat.id.to_string())
}

/// Native "pattern applied" toast — DE for German UIs, EN otherwise (the backend
/// ships no i18n catalog; the concrete pattern name is localized in the webview).
fn notify_pattern(app: &tauri::AppHandle, ui_language: &str) {
    let de = ui_language.to_lowercase().starts_with("de");
    let (title, body) = if de {
        ("Prompt-Pattern angewendet!", format!("+{PROMPT_PATTERN_XP} XP"))
    } else {
        ("Prompt pattern applied!", format!("+{PROMPT_PATTERN_XP} XP"))
    };
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn rub(text: &str) -> (i64, serde_json::Value) {
        score_prompt(text)
    }
    fn hit(v: &serde_json::Value, k: &str) -> bool {
        v[k].as_bool().unwrap_or(false)
    }
    /// Run one named pattern's check over `text`.
    fn pat(id: &str, text: &str) -> bool {
        let p = PATTERNS.iter().find(|p| p.id == id).expect("pattern id");
        (p.check)(&text.to_lowercase())
    }

    #[test]
    fn full_prompt_scores_100() {
        let text = "Erstelle eine Tabelle mit genau 3 Spalten, weil ich einen klaren \
                    Überblick brauche, und nutze nur belegte Zahlen, aber nicht mehr als nötig.";
        let (score, r) = rub(text);
        assert!(hit(&r, "goal"), "goal");
        assert!(hit(&r, "context"), "context");
        assert!(hit(&r, "constraints"), "constraints");
        assert!(hit(&r, "format"), "format");
        assert!(hit(&r, "negative"), "negative");
        assert_eq!(score, 100);
    }

    #[test]
    fn bare_command_scores_low() {
        let (score, _) = rub("Schreib mir das.");
        assert!((20..=40).contains(&score), "bare command should be 20..40, was {score}");
    }

    #[test]
    fn each_criterion_isolated_is_20() {
        // goal only (imperative verb, nothing else).
        let (s, r) = rub("Erkläre das.");
        assert_eq!(s, 20);
        assert!(hit(&r, "goal") && !hit(&r, "context") && !hit(&r, "constraints"));
        // context only (reason marker, no verb/digit/format/negation).
        let (s, r) = rub("Der Grund liegt darin, weil das Team es so entschieden hat.");
        assert_eq!(s, 20);
        assert!(hit(&r, "context") && !hit(&r, "goal"));
        // constraints only (a digit, no verb/marker elsewhere).
        let (s, r) = rub("Die Menge liegt bei 5.");
        assert_eq!(s, 20);
        assert!(hit(&r, "constraints") && !hit(&r, "goal") && !hit(&r, "context"));
        // format only.
        let (s, r) = rub("Am besten als Tabelle.");
        assert_eq!(s, 20);
        assert!(hit(&r, "format") && !hit(&r, "goal"));
        // negative only.
        let (s, r) = rub("Bitte ohne Füllwörter.");
        assert_eq!(s, 20);
        assert!(hit(&r, "negative") && !hit(&r, "goal"));
    }

    #[test]
    fn question_satisfies_goal() {
        // No imperative verb, but a question mark → goal.
        let (_, r) = rub("Wie hoch ist der Umsatz dieses Jahr im Vergleich?");
        assert!(hit(&r, "goal"));
    }

    #[test]
    fn whole_word_not_substring() {
        // "nur" (constraint) must NOT fire inside "Nürnberg"; "code" (format) must
        // NOT fire inside "codieren".
        let (_, r) = rub("Ein Text über Nürnberg und das Codieren von Software.");
        assert!(!hit(&r, "constraints"), "nur inside Nürnberg must not count");
        assert!(!hit(&r, "format"), "code inside codieren must not count");
    }

    #[test]
    fn pattern_checks_positive_and_negative() {
        // role
        assert!(pat("role", "Du bist ein erfahrener Anwalt."));
        assert!(!pat("role", "Fasse den Text zusammen."));
        // output_format
        assert!(pat("output_format", "Gib mir eine Tabelle."));
        assert!(!pat("output_format", "Erzähl mir eine Geschichte."));
        // negative
        assert!(pat("negative", "Antworte ohne Fachjargon."));
        assert!(!pat("negative", "Antworte ausführlich."));
        // step_by_step
        assert!(pat("step_by_step", "Denk schritt für schritt."));
        assert!(!pat("step_by_step", "Antworte schnell."));
    }

    #[test]
    fn pick_pattern_deterministic_and_in_range() {
        let a = pick_pattern("2026-07-14");
        let b = pick_pattern("2026-07-14");
        assert_eq!(a.id, b.id);
        // A different day can map to a different pattern; all ids are non-empty.
        assert!(!a.id.is_empty());
        assert!(PATTERNS.iter().any(|p| p.id == a.id));
    }
}
