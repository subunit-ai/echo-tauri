//! Auto-vocabulary DETECTION (local candidate-finder, NOT the decider).
//!
//! Mines the local dictation history for terms that recur AND are written
//! inconsistently — the signature of a word the ASR keeps mis-hearing (a name,
//! brand, or piece of jargon). Those are exactly what the vocabulary fixes, yet
//! nobody adds them by hand — so we surface them automatically.
//!
//! THE DIVISION OF LABOUR (this is the whole design):
//!   * This file is a cheap, local PRE-FILTER. It clusters near-identical rare
//!     variants ("Jedlischka" / "Jedletschka" / "Jedlitschka") and throws out
//!     the obvious non-mis-hears (common words, and — crucially in an inflected
//!     language like German — normal grammatical inflection: "Projekt /
//!     Projekte / Projekten", "Kunde / Kunden". Those differ only by an ENDING,
//!     not internally, so they are NOT mis-hears, see `is_inflection`).
//!   * The actual DECISION ("is this a real vocab-worthy term — a name / brand /
//!     tech word the STT plausibly garbles — or just an ordinary word?") is made
//!     by the AI gatekeeper in `vocab_suggest.rs::curate`, WITH sentence context.
//!     Frequency/edit-distance only NOMINATES; the model JUDGES. This is what
//!     stops ordinary words from ever being suggested (TJ: not by frequency —
//!     the AI must itself notice "this could be mis-spelled").
//!
//! Everything in the detection half is pure + local (no network, no I/O), so
//! it's cheap to run in the background and unit-testable.
//!
//! v1 scope: SINGLE-token variants. Multi-word mis-hears ("Jed Litschka") are a
//! harder problem left for later; single-token spelling drift covers most cases.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::AppState;
use crate::config::VocabEntry;

/// Minimum length for a token to be considered (skip short function words).
const MIN_LEN: usize = 4;
/// A (multi-variant) cluster needs at least this many total occurrences to surface.
const MIN_TOTAL: usize = 3;
/// Max edit distance (absolute) to treat two tokens as variants of one word.
const MAX_LEV: usize = 2;
/// Max normalized edit distance (lev / longer length) to cluster.
const MAX_LEV_NORM: f32 = 0.34;

/// A detected candidate: one cluster of near-identical variants of a term.
#[derive(Debug, Clone)]
pub struct Candidate {
    /// Stable key for dedup/storage — the most frequent variant, lowercased.
    pub key: String,
    /// Variants (lowercased) with their occurrence counts, most frequent first.
    pub variants: Vec<(String, usize)>,
    /// Total occurrences across all variants.
    pub total: usize,
    /// A few example sentences (verbatim from history) that contain a variant —
    /// the CONTEXT the AI gatekeeper needs to tell a real term from an ordinary
    /// word / inflection. Empty if none could be gathered.
    pub context: Vec<String>,
}

/// How many example sentences to capture per candidate for the AI to judge.
const MAX_CONTEXT: usize = 3;
/// Max chars of a context sentence we keep (keep the prompt small).
const MAX_CONTEXT_CHARS: usize = 200;

/// Most frequent DE + EN words — the only stop-set we need (the multi-variant
/// rule filters the rest). Kept compact on purpose.
fn common_words() -> &'static HashSet<&'static str> {
    use std::sync::OnceLock;
    static COMMON: OnceLock<HashSet<&'static str>> = OnceLock::new();
    COMMON.get_or_init(|| {
        [
            // German
            "und", "oder", "aber", "dass", "weil", "wenn", "denn", "doch", "auch", "noch",
            "schon", "nur", "sehr", "hier", "dort", "dann", "also", "eine", "einen", "einem",
            "einer", "eines", "der", "die", "das", "den", "dem", "des", "ich", "du", "er",
            "sie", "wir", "ihr", "mir", "mich", "dich", "uns", "euch", "ihnen", "sein",
            "haben", "hat", "habe", "hast", "wird", "werden", "wurde", "kann", "kannst",
            "könnte", "muss", "soll", "will", "möchte", "machen", "macht", "gemacht", "nicht",
            "kein", "keine", "mehr", "viel", "viele", "alle", "alles", "etwas", "nichts",
            "über", "unter", "gegen", "ohne", "durch", "nach", "vor", "bei", "mit", "von",
            "zum", "zur", "aus", "ins", "diese", "dieser", "dieses", "jetzt", "immer", "wieder",
            "heute", "morgen", "gestern", "bitte", "danke", "gut", "gute", "guten",
            // English
            "the", "and", "but", "that", "this", "with", "from", "have", "has", "had",
            "will", "would", "should", "could", "shall", "can", "may", "might", "must",
            "for", "not", "are", "was", "were", "been", "being", "you", "your", "yours",
            "they", "them", "their", "what", "when", "where", "which", "while", "about",
            "into", "over", "under", "after", "before", "because", "there", "here", "then",
            "than", "also", "just", "very", "much", "many", "more", "most", "some", "such",
            "make", "made", "want", "need", "like", "please", "thanks", "good", "okay",
        ]
        .into_iter()
        .collect()
    })
}

/// Split text into candidate word tokens (letters, with internal `-`/`'`).
fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in text.chars() {
        if c.is_alphabetic() || ((c == '-' || c == '\'') && !cur.is_empty()) {
            cur.push(c);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Is this token even a candidate? (length, alphabetic-ish, not common.)
fn is_candidate(lower: &str) -> bool {
    if lower.chars().count() < MIN_LEN {
        return false;
    }
    // Must be mostly letters (allow internal hyphen/apostrophe already filtered in).
    if !lower.chars().next().map(|c| c.is_alphabetic()).unwrap_or(false) {
        return false;
    }
    if common_words().contains(lower) {
        return false;
    }
    true
}

/// Classic Levenshtein edit distance (small strings — DP is fine).
fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// Two tokens are variants of one word if they're close enough.
fn similar(a: &str, b: &str) -> bool {
    let la = a.chars().count();
    let lb = b.chars().count();
    let longer = la.max(lb);
    if longer == 0 {
        return false;
    }
    let lev = levenshtein(a, b);
    lev <= MAX_LEV && (lev as f32 / longer as f32) <= MAX_LEV_NORM
}

/// Typical DE/EN inflectional endings (≤3 chars) — the tail an ordinary word
/// grows when it's declined/conjugated/pluralized. NOT exhaustive grammar; just
/// enough to recognize "one word in several forms".
fn inflection_endings() -> &'static HashSet<&'static str> {
    use std::sync::OnceLock;
    static ENDS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    ENDS.get_or_init(|| {
        [
            // German declension/conjugation
            "e", "en", "er", "es", "em", "et", "n", "ns", "s", "st", "t", "te", "ten", "nen",
            // English
            "d", "ed", "ing", "est", "ly", "ies",
        ]
        .into_iter()
        .collect()
    })
}

/// Are these variants just grammatical INFLECTIONS of one ordinary word rather
/// than mis-hearings of a term? The distinction is WHERE they differ:
///   * mis-hears differ INTERNALLY — "jedli·schka" vs "jedli·tschka"
///   * inflections differ only at the END — "projekt" → "projekt·e" → "projekt·en"
/// So if the variants share a real common stem (≥3 chars) and every divergent
/// tail is empty or a known short inflection ending, it's normal inflection — a
/// declined/conjugated everyday word, NOT something the ASR mis-heard. This is
/// the cheap local guard that keeps the bulk of German "Standardbegriffe" (the
/// old false positives) from ever surfacing, with zero round-trips.
fn is_inflection(variants: &[String]) -> bool {
    // Distinct, lowercased forms as char vectors.
    let mut seen = HashSet::new();
    let forms: Vec<Vec<char>> = variants
        .iter()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty() && seen.insert(v.clone()))
        .map(|v| v.chars().collect())
        .collect();
    if forms.len() < 2 {
        return false;
    }
    // Longest common prefix (in chars) across all forms.
    let min_len = forms.iter().map(|f| f.len()).min().unwrap_or(0);
    let mut lcp = 0usize;
    'p: for i in 0..min_len {
        let c = forms[0][i];
        for f in &forms[1..] {
            if f[i] != c {
                break 'p;
            }
        }
        lcp = i + 1;
    }
    if lcp < 3 {
        return false; // no real shared stem → divergence is internal → a mis-hear
    }
    let ends = inflection_endings();
    forms.iter().all(|f| {
        let tail: String = f[lcp..].iter().collect();
        tail.is_empty() || (tail.chars().count() <= 3 && ends.contains(tail.as_str()))
    })
}

/// Up to `MAX_CONTEXT` example sentences from `transcripts` that contain a
/// variant — the in-situ context the AI gatekeeper needs to tell a real term
/// from an ordinary word. Each trimmed to `MAX_CONTEXT_CHARS` (windowed around
/// the match if long) so the batch prompt stays small.
fn gather_context(transcripts: &[String], variants: &[String]) -> Vec<String> {
    let needles: Vec<String> = variants.iter().map(|v| v.to_lowercase()).collect();
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for t in transcripts {
        let lower = t.to_lowercase();
        if !needles.iter().any(|n| lower.contains(n.as_str())) {
            continue;
        }
        let snippet = snippet_around(t, &needles);
        if snippet.is_empty() || !seen.insert(snippet.to_lowercase()) {
            continue;
        }
        out.push(snippet);
        if out.len() >= MAX_CONTEXT {
            break;
        }
    }
    out
}

/// The transcript trimmed to `MAX_CONTEXT_CHARS`, windowed around the first
/// needle hit (with ellipses) when it's longer.
fn snippet_around(text: &str, needles: &[String]) -> String {
    let trimmed = text.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= MAX_CONTEXT_CHARS {
        return trimmed.to_string();
    }
    let lower: String = trimmed.to_lowercase();
    let mut at = 0usize;
    for n in needles {
        if let Some(byte_idx) = lower.find(n.as_str()) {
            at = lower[..byte_idx].chars().count();
            break;
        }
    }
    let half = MAX_CONTEXT_CHARS / 2;
    let end = (at + half).min(chars.len()).max(MAX_CONTEXT_CHARS.min(chars.len()));
    let start = end.saturating_sub(MAX_CONTEXT_CHARS);
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s = format!("…{s}");
    }
    if end < chars.len() {
        s = format!("{s}…");
    }
    s
}

/// Detect auto-vocab candidates from transcript history.
///
/// `transcripts`: recent transcript texts (any order).
/// `known`: lowercased terms already in the vocab OR ignored — skipped entirely
/// (so we never re-surface what the user already handled).
pub fn detect(transcripts: &[String], known: &HashSet<String>) -> Vec<Candidate> {
    // 1. Count candidate tokens by lowercased form; keep the most common display
    //    casing for presentation.
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut display: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for t in transcripts {
        for tok in tokenize(t) {
            let lower = tok.to_lowercase();
            if !is_candidate(&lower) || known.contains(&lower) {
                continue;
            }
            *counts.entry(lower.clone()).or_default() += 1;
            *display.entry(lower).or_default().entry(tok).or_default() += 1;
        }
    }
    if counts.is_empty() {
        return Vec::new();
    }

    // 2. Greedy similarity clustering over the distinct tokens (most frequent
    //    first, so the representative key is the dominant spelling).
    let mut tokens: Vec<(String, usize)> = counts.into_iter().collect();
    tokens.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));

    let mut clusters: Vec<Vec<(String, usize)>> = Vec::new();
    'tok: for (tok, n) in tokens {
        for cl in clusters.iter_mut() {
            if cl.iter().any(|(m, _)| similar(&tok, m)) {
                cl.push((tok, n));
                continue 'tok;
            }
        }
        clusters.push(vec![(tok, n)]);
    }

    // 3. Qualify + build candidates.
    let mut out: Vec<Candidate> = Vec::new();
    for cl in clusters {
        let total: usize = cl.iter().map(|(_, n)| *n).sum();
        // ONLY multi-variant clusters qualify: a term the ASR spelled ≥2 DIFFERENT
        // ways is a genuine mis-hear (real "Verwechslungsgefahr"). A consistently-
        // spelled recurring token — even a rare one — is NOT a mis-hear and is very
        // often just an ordinary word ("können", "eigentlich", …); surfacing those
        // is pure noise. So a single consistent spelling never qualifies. (TJ)
        if cl.len() < 2 || total < MIN_TOTAL {
            continue;
        }
        // variants already sorted (tokens were sorted desc before clustering).
        let variant_strs: Vec<String> = cl.iter().map(|(v, _)| v.clone()).collect();
        // Drop normal grammatical inflection (German declension/conjugation,
        // plurals): these differ only by an ending, are NOT mis-hears, and were
        // the bulk of the old false positives. The AI gatekeeper never even sees
        // them — they're filtered locally, for free.
        if is_inflection(&variant_strs) {
            continue;
        }
        let key = cl[0].0.clone();
        let context = gather_context(transcripts, &variant_strs);
        out.push(Candidate { key, variants: cl, total, context });
    }
    out.sort_by(|a, b| b.total.cmp(&a.total).then(a.key.cmp(&b.key)));
    out
}

// ── Hybrid learn flow (detect → suggest → silent-add | ask) ────────────────

/// How many recent transcripts to mine each scan.
const HISTORY_WINDOW: u32 = 500;
/// Minimum gatekeeper confidence for a candidate to be OFFERED as a suggestion at
/// all. Nothing is ever auto-applied anymore (every accepted candidate lands in
/// the user-confirmed `pending` list), so this only governs whether a term is
/// worth showing — a firm floor keeps wild guesses out of the suggestion list.
const SUGGEST_MIN_CONFIDENCE: f64 = 0.6;

/// Proper-noun-ish kinds the gatekeeper may return. ONLY these are ever offered
/// as vocabulary suggestions — a name / brand / product / tech word / place /
/// abbreviation / foreign term the STT plausibly garbles. Everything else
/// (ordinary word, verb, adjective, adverb, inflection, …) is dropped. Matched
/// case-insensitively; a few synonyms are accepted for server-vocabulary drift.
fn is_proper_noun_kind(kind: &str) -> bool {
    matches!(
        kind.trim().to_lowercase().as_str(),
        "person" | "name" | "company" | "org" | "organization" | "brand" | "product"
            | "tech" | "technology" | "place" | "location" | "abbrev" | "abbreviation"
            | "acronym" | "foreign"
    )
}

/// Is `spelling` merely an inflected form of a word we ALREADY track (any
/// write_as / sounds_like / alias in the vocabulary)? Reuses the detection-side
/// inflection test: same stem, differing only by a short grammatical ending. Such
/// a candidate is not a new term — it's the declined/conjugated form of one we
/// have — so never propose it.
fn is_inflection_of_existing(spelling: &str, cfg: &crate::config::Config) -> bool {
    let s = spelling.trim().to_lowercase();
    if s.is_empty() {
        return false;
    }
    for e in &cfg.vocabulary {
        for w in std::iter::once(&e.write_as)
            .chain(std::iter::once(&e.sounds_like))
            .chain(e.aliases.iter())
        {
            let w = w.trim().to_lowercase();
            if w.is_empty() || w == s {
                continue;
            }
            if is_inflection(&[w, s.clone()]) {
                return true;
            }
        }
    }
    false
}

/// STRICT acceptance test for a gatekeeper verdict: is this candidate a genuine
/// proper noun / term worth OFFERING to the user (as a pending suggestion — never
/// auto-applied)? All of:
///   * judged a real term (`is_term`),
///   * with a non-empty spelling and enough confidence,
///   * carrying a proper-noun `kind` from the server — a decision WITHOUT a
///     `kind` is rejected (fail-closed). The old fallback ("any uppercase letter
///     → proper-noun-ish") let every capitalized ordinary GERMAN noun through
///     (Mitarbeiter, Rechnung, Ordner …), which is how trivial everyday words
///     flooded the suggestion list; our server always classifies `kind`,
///   * NOT a mere inflection of a word we already track.
/// Anything failing this is dropped, so ordinary words / verbs / adjectives /
/// adverbs / inflections can never reach the suggestion list.
fn accept_suggestion(d: &crate::vocab_suggest::Decision, cfg: &crate::config::Config) -> bool {
    if !d.is_term || d.confidence < SUGGEST_MIN_CONFIDENCE {
        return false;
    }
    let spelling = d.spelling.trim();
    if spelling.is_empty() {
        return false;
    }
    if !is_proper_noun_kind(&d.kind) {
        return false;
    }
    !is_inflection_of_existing(spelling, cfg)
}

/// What to do with a candidate given the gatekeeper's verdict. There is NO
/// "add" variant on purpose — the scan can only ever suggest (pending) or drop,
/// never silently mutate the active vocabulary.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Offer it as a pending suggestion (the user confirms). Carries the best
    /// spelling to pre-fill, if the gatekeeper had one.
    Suggest(Option<String>),
    /// Drop it for good — not a proper-noun term (ordinary word / inflection / …).
    Drop,
    /// No verdict came back (offline / old server) — leave it pending so the user
    /// still sees the raw candidate; nothing is ever auto-added on a non-answer.
    LeavePending,
}

/// Pure routing: map a gatekeeper decision (or its absence) to a `Verdict`. Kept
/// side-effect-free so it's unit-testable and can NEVER auto-add.
pub fn route_decision(d: Option<&crate::vocab_suggest::Decision>, cfg: &crate::config::Config) -> Verdict {
    match d {
        Some(d) if accept_suggestion(d, cfg) => {
            Verdict::Suggest((!d.spelling.trim().is_empty()).then(|| d.spelling.trim().to_string()))
        }
        Some(_) => Verdict::Drop,
        None => Verdict::LeavePending,
    }
}

/// Minimum seconds between background scans (throttle for the per-dictation hook).
const SCAN_MIN_INTERVAL_SECS: i64 = 90;
static LAST_SCAN: AtomicI64 = AtomicI64::new(0);

/// Throttled scan to call after each dictation: skips if one ran within the last
/// interval, else runs `scan_and_learn` off-thread. Cheap no-op most of the time.
pub fn maybe_scan<R: Runtime>(app: &AppHandle<R>) {
    let now = now_secs();
    if now - LAST_SCAN.load(Ordering::Relaxed) < SCAN_MIN_INTERVAL_SECS {
        return;
    }
    LAST_SCAN.store(now, Ordering::Relaxed);
    let app = app.clone();
    std::thread::spawn(move || scan_and_learn(&app));
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Lowercased set of every term already in the vocab — `detect` skips these so
/// we never re-surface a word the user already has.
fn known_vocab_terms(cfg: &crate::config::Config) -> HashSet<String> {
    let mut known = HashSet::new();
    for e in &cfg.vocabulary {
        for s in std::iter::once(&e.write_as)
            .chain(std::iter::once(&e.sounds_like))
            .chain(e.aliases.iter())
        {
            let s = s.trim().to_lowercase();
            if !s.is_empty() {
                known.insert(s);
            }
        }
    }
    known
}

/// Background scan: mine history → for each fresh candidate, ask the backend for
/// the correct spelling → HIGH confidence silently learns it (revertable), else
/// it lands as a pending suggestion for the user to confirm. Best-effort; safe to
/// call often (debounced by the caller). Already-handled (added/ignored) terms are
/// skipped via the candidate store.
pub fn scan_and_learn<R: Runtime>(app: &AppHandle<R>) {
    let cfg = app.state::<AppState>().config.lock().clone();
    let known = known_vocab_terms(&cfg);

    let rows = crate::store::list_history("", HISTORY_WINDOW, 0);
    let texts: Vec<String> = rows
        .iter()
        .filter_map(|r| r.get("text").and_then(|v| v.as_str()).map(String::from))
        .collect();
    if texts.is_empty() {
        return;
    }

    let now = now_secs();
    let mut changed = false;

    // Prune stale PENDING candidates that no longer qualify: a single spelling
    // (one variant = no mis-hear, e.g. "können" surfaced before that rule) OR
    // normal inflection (variants differ only by an ending — "Projekt/Projekte",
    // the old "Standardbegriffe" noise). Retire them so they stop nagging and the
    // old garbage clears itself out on the next scan.
    for c in crate::store::list_vcand("pending") {
        let words = vcand_variant_words(&c);
        let stale = words.len() < 2 || is_inflection(&words);
        if stale {
            if let Some(key) = c.get("key").and_then(|v| v.as_str()) {
                crate::store::set_vcand(key, None, None, "ignored", None, now);
                changed = true;
            }
        }
    }

    // Upsert every detected candidate as pending (refreshing counts) and collect
    // the ones needing a gatekeeper verdict in ONE batch: brand-NEW candidates
    // (no prior status) AND pending ones still without a decision (their earlier
    // curate call failed — offline / limit / old server). Without the retry those
    // sat undecided forever; since undecided candidates are never displayed
    // (vocab_candidates gates on `suggestion`), they'd be stuck invisible.
    // Candidates with a positive verdict keep it — we don't re-bill for them.
    let mut fresh: Vec<Candidate> = Vec::new();
    for cand in detect(&texts, &known) {
        let prior = crate::store::vcand_status(&cand.key);
        if matches!(prior.as_deref(), Some("ignored") | Some("added")) {
            continue; // already settled by the user / a prior auto-add
        }
        let undecided = prior.as_deref() == Some("pending")
            && crate::store::get_vcand(&cand.key)
                .and_then(|c| c.get("suggestion").and_then(|s| s.as_str()).map(String::from))
                .is_none();
        let variants_json = serde_json::to_string(&cand.variants).unwrap_or_else(|_| "[]".into());
        crate::store::upsert_vcand_pending(&cand.key, &variants_json, cand.total as i64, now);
        changed = true;
        if prior.is_none() || undecided {
            fresh.push(cand);
        }
    }

    // The AI gatekeeper judges the whole batch at once: per candidate, is it a
    // REAL, proper-noun-ish term (name/brand/product/tech/place the STT garbles)
    // or just an ordinary word / inflection? Only its verdict — gated by the
    // STRICT `accept_suggestion` (is_term + proper-noun kind/heuristic + enough
    // confidence + not an inflection of an existing term) — decides. NOTHING is
    // ever silently added: an accepted candidate becomes a PENDING suggestion the
    // user must confirm; anything rejected is retired for good so ordinary words
    // never surface. Best-effort: if the call fails (offline / old server), the
    // candidate is left pending so the user still sees the raw find.
    if !fresh.is_empty() {
        let decisions = crate::vocab_suggest::curate(&cfg, &fresh);
        for cand in &fresh {
            let decision = decisions.iter().find(|d| d.key == cand.key);
            match route_decision(decision, &cfg) {
                Verdict::Suggest(sug) => {
                    let conf = decision.map(|d| d.confidence);
                    crate::store::set_vcand(&cand.key, sug.as_deref(), conf, "pending", None, now);
                }
                Verdict::Drop => {
                    crate::store::set_vcand(&cand.key, None, None, "ignored", None, now);
                }
                Verdict::LeavePending => {
                    crate::store::set_vcand(&cand.key, None, None, "pending", None, now);
                }
            }
        }
    }
    if changed {
        let _ = app.emit("echo://vocab-candidates-changed", ());
    }
}

/// (sounds_like, aliases) from a variant list, excluding the chosen spelling
/// itself (it's the `write_as`, never its own alias).
fn split_variants(variants: &[String], spelling: &str) -> (String, Vec<String>) {
    let filtered: Vec<String> = variants
        .iter()
        .filter(|v| !v.trim().eq_ignore_ascii_case(spelling.trim()))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect();
    let sounds_like = filtered.first().cloned().unwrap_or_default();
    let aliases = filtered.into_iter().skip(1).collect();
    (sounds_like, aliases)
}

/// Push a vocab entry the USER confirmed into the live config, rebuild the regex
/// cache, persist, and tell the UI. (The new term biases Whisper + post-replaces.)
/// Tagged `category:"Other"` — a real, APPLIED, user-visible/-editable entry — NOT
/// the inert `"auto"` category, which is skipped on every path (see
/// transcribe::vocab). This is only ever reached from `confirm()`; the background
/// scan never adds silently.
fn add_vocab_entry<R: Runtime>(app: &AppHandle<R>, sounds_like: String, aliases: Vec<String>, spelling: &str) {
    {
        let state = app.state::<AppState>();
        let mut cfg = state.config.lock();
        cfg.vocabulary.push(VocabEntry {
            sounds_like,
            write_as: spelling.to_string(),
            aliases,
            category: "Other".to_string(),
        });
        cfg.build_vocab_regex_cache();
        let _ = cfg.save();
    }
    let _ = app.emit("echo://config-changed", ());
}

/// Pull the variant words out of a stored candidate row (`variants` is a JSON
/// array of `[word, count]` pairs).
fn vcand_variant_words(row: &serde_json::Value) -> Vec<String> {
    row.get("variants")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| p.as_array().and_then(|t| t.first()).and_then(|s| s.as_str()))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Variant words stored for a candidate key (for confirm/undo).
fn candidate_words(key: &str) -> Vec<String> {
    match crate::store::get_vcand(key) {
        Some(row) => vcand_variant_words(&row),
        None => Vec::new(),
    }
}

/// User confirmed a pending suggestion (possibly edited the spelling) → learn it.
pub fn confirm<R: Runtime>(app: &AppHandle<R>, key: &str, spelling: &str) {
    let spelling = spelling.trim();
    if spelling.is_empty() {
        return;
    }
    let words = candidate_words(key);
    let (sounds_like, aliases) = split_variants(&words, spelling);
    // Fall back to the key itself as sounds_like if the cluster collapsed.
    let sounds_like = if sounds_like.is_empty() { key.to_string() } else { sounds_like };
    add_vocab_entry(app, sounds_like, aliases, spelling);
    crate::store::set_vcand(key, Some(spelling), Some(1.0), "added", Some(spelling), now_secs());
    let _ = app.emit("echo://vocab-candidates-changed", ());
}

/// User dismissed a candidate → never surface it again.
pub fn ignore<R: Runtime>(app: &AppHandle<R>, key: &str) {
    crate::store::set_vcand(key, None, None, "ignored", None, now_secs());
    let _ = app.emit("echo://vocab-candidates-changed", ());
}

/// Undo a confirmed suggestion: remove the vocab entry it created and mark the
/// candidate ignored (so the scan won't re-surface it). Matches by the stored
/// `added_term` (the confirmed `write_as`) — confirmed entries live under the
/// real "Other" category now, not "auto".
pub fn undo<R: Runtime>(app: &AppHandle<R>, key: &str) {
    let added_term = crate::store::get_vcand(key)
        .and_then(|r| r.get("added_term").and_then(|v| v.as_str()).map(String::from));
    if let Some(term) = added_term {
        let state = app.state::<AppState>();
        let mut cfg = state.config.lock();
        cfg.vocabulary
            .retain(|e| !e.write_as.eq_ignore_ascii_case(&term));
        cfg.build_vocab_regex_cache();
        let _ = cfg.save();
        drop(cfg);
        let _ = app.emit("echo://config-changed", ());
    }
    crate::store::set_vcand(key, None, None, "ignored", None, now_secs());
    let _ = app.emit("echo://vocab-candidates-changed", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known_empty() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn clusters_misheard_variants() {
        // Same name, three spellings the ASR drifted between → one candidate.
        let h = vec![
            "ich habe mit Jedlischka gesprochen".to_string(),
            "das war Jedletschka der das sagte".to_string(),
            "Jedlitschka hat zugestimmt".to_string(),
        ];
        let c = detect(&h, &known_empty());
        assert_eq!(c.len(), 1, "the three variants should form ONE cluster");
        assert_eq!(c[0].total, 3);
        assert!(c[0].variants.len() >= 2);
    }

    #[test]
    fn ignores_consistent_common_text() {
        let h = vec![
            "ich habe das gemacht und es war gut".to_string(),
            "wir haben das auch so gemacht".to_string(),
            "das war wieder sehr gut und schnell".to_string(),
        ];
        assert!(detect(&h, &known_empty()).is_empty());
    }

    #[test]
    fn consistent_single_spelling_never_qualifies() {
        // A consistently-spelled token NEVER qualifies, no matter how often it
        // recurs — one spelling = no mis-hear. This is the guard against ordinary
        // words ("können", "eigentlich", a correctly-spelled name) being surfaced.
        assert!(detect(&vec!["Kubernetes".to_string(); 5], &known_empty()).is_empty());
        assert!(detect(&vec!["können".to_string(); 12], &known_empty()).is_empty());
    }

    #[test]
    fn inflection_is_dropped_not_surfaced() {
        // Normal German declension: same ordinary word, three endings. The old
        // edit-distance rule wrongly clustered these as "mis-heard variants"; the
        // inflection guard drops them so they never reach the AI. (TJ: the bug.)
        let h = vec![
            "wir starten ein neues Projekt".to_string(),
            "an dem Projekt arbeiten drei Leute".to_string(),
            "die anderen Projekte laufen auch".to_string(),
            "in allen Projekten gibt es Termine".to_string(),
            "der Termin steht, mehrere Termine offen".to_string(),
            "mit dem Kunden und weiteren Kunden gesprochen".to_string(),
        ];
        let cands = detect(&h, &known_empty());
        for c in &cands {
            assert!(
                !["projekt", "termin", "kunde", "kunden", "projekte", "termine"].contains(&c.key.as_str()),
                "ordinary inflected word leaked through: {} ({:?})",
                c.key,
                c.variants
            );
        }
    }

    #[test]
    fn is_inflection_distinguishes_ending_from_internal() {
        // Differ only at the ending → inflection.
        assert!(is_inflection(&["projekt".into(), "projekte".into(), "projekten".into()]));
        assert!(is_inflection(&["kunde".into(), "kunden".into()]));
        assert!(is_inflection(&["termin".into(), "termine".into(), "terminen".into()]));
        assert!(is_inflection(&["arbeite".into(), "arbeitet".into(), "arbeiten".into()]));
        // Differ INTERNALLY → a real mis-hear, NOT inflection.
        assert!(!is_inflection(&["jedlischka".into(), "jedletschka".into(), "jedlitschka".into()]));
        assert!(!is_inflection(&["vollack".into(), "vollak".into(), "volak".into()]));
        // Short / no shared stem → not inflection.
        assert!(!is_inflection(&["claude".into(), "cloud".into()]));
    }

    #[test]
    fn candidate_carries_context() {
        let h = vec![
            "ich habe mit Jedlischka gesprochen".to_string(),
            "das war Jedletschka der das sagte".to_string(),
            "Jedlitschka hat zugestimmt".to_string(),
        ];
        let c = detect(&h, &known_empty());
        assert_eq!(c.len(), 1);
        assert!(!c[0].context.is_empty(), "the AI needs example sentences as context");
    }

    #[test]
    fn skips_known_terms() {
        let h = vec![
            "Jedlischka".to_string(),
            "Jedletschka".to_string(),
            "Jedlitschka".to_string(),
        ];
        let mut known = HashSet::new();
        known.insert("jedlischka".to_string());
        known.insert("jedletschka".to_string());
        known.insert("jedlitschka".to_string());
        assert!(detect(&h, &known).is_empty(), "known/ignored variants must be skipped");
    }

    // ── Strict acceptance / never-silent-add (the suggestion gatekeeping) ──────

    use crate::config::{Config, VocabEntry};
    use crate::vocab_suggest::Decision;

    fn decision(key: &str, is_term: bool, kind: &str, spelling: &str, confidence: f64) -> Decision {
        Decision {
            key: key.to_string(),
            is_term,
            kind: kind.to_string(),
            spelling: spelling.to_string(),
            confidence,
        }
    }

    #[test]
    fn ordinary_word_is_rejected() {
        let cfg = Config::default();
        // A lowercase everyday word — even if the model wrongly calls it a term —
        // is never proper-noun-ish (no server kind → client heuristic drops it).
        let d = decision("selber", true, "", "selber", 0.99);
        assert_eq!(route_decision(Some(&d), &cfg), Verdict::Drop);
        // Explicit non-term.
        let d2 = decision("richtig", false, "", "richtig", 0.99);
        assert_eq!(route_decision(Some(&d2), &cfg), Verdict::Drop);
        // An upgraded server that DOES classify: a non-proper-noun kind is dropped
        // even when capitalized and highly confident.
        let d3 = decision("gebaut", true, "verb", "Gebaut", 0.99);
        assert_eq!(route_decision(Some(&d3), &cfg), Verdict::Drop);
        // Low confidence is dropped regardless.
        let d4 = decision("firma", true, "company", "Firma", 0.2);
        assert_eq!(route_decision(Some(&d4), &cfg), Verdict::Drop);
    }

    #[test]
    fn proper_noun_passes_to_pending_and_never_auto_adds() {
        let cfg = Config::default();
        // Server classifies it as a person + confident → offered as a PENDING
        // suggestion (never applied). `route_decision` has no add variant at all,
        // so a high-confidence proper noun can only ever become a suggestion.
        let d = decision("jedlischka", true, "person", "Jedlischka", 0.95);
        assert_eq!(
            route_decision(Some(&d), &cfg),
            Verdict::Suggest(Some("Jedlischka".to_string()))
        );
        // No server kind → FAIL-CLOSED: even a proper-noun-looking spelling is
        // dropped. German capitalizes every noun, so any spelling-based fallback
        // waves ordinary words through — kind-less decisions are not trusted.
        let d2 = decision("klodkoud", true, "", "Claude Code", 0.9);
        assert_eq!(route_decision(Some(&d2), &cfg), Verdict::Drop);
    }

    #[test]
    fn inflection_of_existing_word_is_rejected() {
        let mut cfg = Config::default();
        // We already track "Projekt"; "Projekte" is just its plural inflection —
        // a real term (capitalized) by the heuristic, but not a NEW one.
        cfg.vocabulary.push(VocabEntry {
            sounds_like: String::new(),
            write_as: "Projekt".to_string(),
            aliases: vec![],
            category: "Other".to_string(),
        });
        // Real server kind, so the drop below comes from the INFLECTION gate,
        // not the fail-closed kind gate.
        let d = decision("projekte", true, "product", "Projekte", 0.9);
        assert_eq!(route_decision(Some(&d), &cfg), Verdict::Drop);
    }

    #[test]
    fn no_verdict_leaves_pending_never_adds() {
        let cfg = Config::default();
        assert_eq!(route_decision(None, &cfg), Verdict::LeavePending);
    }

    #[test]
    fn kindless_decisions_never_suggest() {
        // FAIL-CLOSED: without a server `kind` no candidate reaches the
        // suggestion list — capitalized ordinary German nouns are exactly what
        // the old uppercase heuristic waved through.
        let cfg = Config::default();
        for spelling in ["Mitarbeiter", "Rechnung", "Ordner", "Anthropic", "Claude Code"] {
            let d = decision("x", true, "", spelling, 0.95);
            assert_eq!(route_decision(Some(&d), &cfg), Verdict::Drop, "{spelling}");
        }
    }

    #[test]
    fn levenshtein_basic() {
        assert_eq!(levenshtein("kitten", "sitting"), 3);
        assert_eq!(levenshtein("flaw", "lawn"), 2);
        assert_eq!(levenshtein("same", "same"), 0);
    }

    #[test]
    fn similar_groups_close_not_far() {
        assert!(similar("jedlischka", "jedlitschka"));
        assert!(!similar("hamburg", "stuttgart"));
    }
}
