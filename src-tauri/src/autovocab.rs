//! Auto-vocabulary DETECTION.
//!
//! Mines the local dictation history for terms that recur AND are written
//! inconsistently — the signature of a word the ASR keeps mis-hearing (a name,
//! brand, or piece of jargon). Those are exactly what the vocabulary fixes, yet
//! nobody adds them by hand — so we surface them automatically (see the hybrid
//! flow in `vocab_suggest.rs`: high-confidence → silent add, else → ask).
//!
//! The KILLER signal is a CLUSTER of near-identical rare variants
//! ("Jedlischka" / "Jedletschka" / "Jedlitschka"). Consistently-spelled common
//! words never form such a cluster, so the multi-variant requirement is largely
//! self-filtering — the small `COMMON` stop-set only guards the single-variant
//! high-frequency path. Everything here is pure + local (no network, no I/O), so
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
/// A cluster needs at least this many total occurrences to surface.
const MIN_TOTAL: usize = 3;
/// A SINGLE-variant cluster (consistent spelling) needs a higher bar — it might
/// just be a correctly-spelled name the user uses often. Multi-variant clusters
/// (the real mis-hear signal) qualify at `MIN_TOTAL`.
const MIN_TOTAL_SINGLE: usize = 5;
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
}

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
        let multi = cl.len() >= 2;
        let qualifies = if multi { total >= MIN_TOTAL } else { total >= MIN_TOTAL_SINGLE };
        if !qualifies {
            continue;
        }
        // variants already sorted (tokens were sorted desc before clustering).
        let key = cl[0].0.clone();
        out.push(Candidate { key, variants: cl, total });
    }
    out.sort_by(|a, b| b.total.cmp(&a.total).then(a.key.cmp(&b.key)));
    out
}

// ── Hybrid learn flow (detect → suggest → silent-add | ask) ────────────────

/// How many recent transcripts to mine each scan.
const HISTORY_WINDOW: u32 = 500;
/// Server-suggestion confidence at/above which we SILENTLY add (revertable);
/// below it we keep the candidate pending and ask the user.
const HIGH_CONFIDENCE: f64 = 0.8;

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
    for cand in detect(&texts, &known) {
        let prior = crate::store::vcand_status(&cand.key);
        // Skip what the user/auto-flow already settled.
        if matches!(prior.as_deref(), Some("ignored") | Some("added")) {
            continue;
        }
        let words: Vec<String> = cand.variants.iter().map(|(v, _)| v.clone()).collect();
        let variants_json = serde_json::to_string(&cand.variants).unwrap_or_else(|_| "[]".into());
        crate::store::upsert_vcand_pending(&cand.key, &variants_json, cand.total as i64, now);
        changed = true;
        // Already pending from a previous scan → don't re-call the backend; just
        // the refreshed counts above. Only brand-new candidates get a suggestion.
        if prior.is_some() {
            continue;
        }

        match crate::vocab_suggest::suggest(&cfg, &words) {
            Some(s) if s.confidence >= HIGH_CONFIDENCE => {
                let (sounds_like, aliases) = split_variants(&words, &s.spelling);
                add_vocab_entry(app, sounds_like, aliases, &s.spelling);
                crate::store::set_vcand(&cand.key, Some(&s.spelling), Some(s.confidence), "added", Some(&s.spelling), now);
                let _ = app.emit("echo://vocab-learned", serde_json::json!({ "term": s.spelling }));
            }
            Some(s) => {
                crate::store::set_vcand(&cand.key, Some(&s.spelling), Some(s.confidence), "pending", None, now);
            }
            None => {
                crate::store::set_vcand(&cand.key, None, None, "pending", None, now);
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

/// Push a `category:"auto"` vocab entry into the live config, rebuild the regex
/// cache, persist, and tell the UI. (The new term biases Whisper + post-replaces.)
fn add_vocab_entry<R: Runtime>(app: &AppHandle<R>, sounds_like: String, aliases: Vec<String>, spelling: &str) {
    {
        let state = app.state::<AppState>();
        let mut cfg = state.config.lock();
        cfg.vocabulary.push(VocabEntry {
            sounds_like,
            write_as: spelling.to_string(),
            aliases,
            category: "auto".to_string(),
        });
        cfg.build_vocab_regex_cache();
        let _ = cfg.save();
    }
    let _ = app.emit("echo://config-changed", ());
}

/// Variant words stored for a candidate key (for confirm/undo).
fn candidate_words(key: &str) -> Vec<String> {
    let Some(row) = crate::store::get_vcand(key) else { return Vec::new() };
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

/// Undo an auto-added term: remove its `auto` vocab entry and mark the candidate
/// ignored (so the scan won't re-add it).
pub fn undo<R: Runtime>(app: &AppHandle<R>, key: &str) {
    let added_term = crate::store::get_vcand(key)
        .and_then(|r| r.get("added_term").and_then(|v| v.as_str()).map(String::from));
    if let Some(term) = added_term {
        let state = app.state::<AppState>();
        let mut cfg = state.config.lock();
        cfg.vocabulary
            .retain(|e| !(e.category == "auto" && e.write_as.eq_ignore_ascii_case(&term)));
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
    fn single_rare_token_needs_higher_bar() {
        // A consistently-spelled rare token 3× does NOT qualify (could be a
        // correct name); 5× does.
        let three = vec!["Kubernetes".to_string(); 3];
        assert!(detect(&three, &known_empty()).is_empty());
        let five = vec!["Kubernetes".to_string(); 5];
        let c = detect(&five, &known_empty());
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].key, "kubernetes");
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
