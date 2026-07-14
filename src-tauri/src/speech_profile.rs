//! Deterministic speech-analysis engine ("Sprechprofil").
//!
//! 100% on-device, zero network, zero latency. Turns the retained dictation
//! history into six rhetoric dimensions (0–100) plus sub-metrics and rule-based
//! insights. The heavy per-day computation is cached in `speech_daily` (see
//! store.rs); this module is the PURE engine: it never touches the DB. It takes
//! already-loaded text and returns raw metrics (`DayStats`), aggregates daily
//! rows into a window, and maps the aggregated raw values to scores via a single
//! calibratable `ANCHORS` table AT READ TIME — so re-tuning the anchors never
//! invalidates the cache (only a `SPEECH_METRICS_VERSION` bump does).
//!
//! Formulae follow the Sprechprofil metric contract (2026-07-14). MTLD is the
//! McCarthy & Jarvis (2010) length-robust diversity measure (factor threshold
//! 0.72, bidirectional mean, proportional remainder factor) — validated against
//! a Python reference in the golden-fixture tests below.

use std::collections::{HashMap, HashSet};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::analysis;
use crate::rarity;

/// Metric formula version. Bump on ANY change to a per-day formula → cached
/// `speech_daily` rows with a lower version are recomputed. The ANCHORS table is
/// deliberately NOT versioned: scores are mapped from raw metrics at read time,
/// so recalibrating anchors needs neither a bump nor a cache flush.
pub const SPEECH_METRICS_VERSION: i64 = 1;

/// Window needs at least this many words before the profile is meaningful; below
/// it the UI shows an empty state (and `ghost` is null).
pub const MIN_WORDS: f64 = 500.0;

// ── Word lists (whole-word, lowercase — tokenizer already lowercases + drops
//    tokens < 3 chars, so any marker shorter than 3 chars is intentionally
//    invisible here: "is"/"if"/"so" can never appear and are omitted). ─────────

/// Vague quantifiers / crutch nouns (contract §2).
const VAGUE: &[&str] = &[
    "irgendwie", "irgendwas", "irgendwo", "ziemlich", "relativ", "quasi", "halt", "eigentlich",
    "sozusagen", "dinge", "sachen", "zeug", "bisschen",
];

/// Single-token hedging markers (contract §2). The subjunctive modals appear in
/// the contract's own hedging example ("ich würde sagen wir sollten") in both
/// singular and plural, so both are counted.
const HEDGE_SINGLE: &[&str] = &[
    "würde", "würden", "könnte", "könnten", "sollte", "sollten", "vielleicht", "eventuell",
    "möglicherweise", "wahrscheinlich", "vermutlich", "evtl",
    // EN
    "maybe", "perhaps", "possibly", "probably",
];

/// Second token of a hedging bigram led by "ich": ich glaube / denke / meine.
const HEDGE_BIGRAM_2ND: &[&str] = &["glaube", "denke", "meine"];

/// werden-passive auxiliaries (DE) + is/was/been (EN, "is" < 3 chars is dropped).
const PASSIVE_AUX: &[&str] = &["wird", "werden", "wurde", "wurden", "worden", "was", "been"];

static VAGUE_SET: Lazy<HashSet<&'static str>> = Lazy::new(|| VAGUE.iter().copied().collect());
static HEDGE_SET: Lazy<HashSet<&'static str>> = Lazy::new(|| HEDGE_SINGLE.iter().copied().collect());
static HEDGE2_SET: Lazy<HashSet<&'static str>> =
    Lazy::new(|| HEDGE_BIGRAM_2ND.iter().copied().collect());
static PASSIVE_AUX_SET: Lazy<HashSet<&'static str>> =
    Lazy::new(|| PASSIVE_AUX.iter().copied().collect());

// Connector buckets → bit index. Density = connectors/sentence; variety = how
// many distinct buckets the window touches. DE + EN lists both active (mixed
// dictation), mapping onto the same six buckets.
const CONN_KAUSAL: &[&str] = &[
    "weil", "denn", "deshalb", "daher", "darum", "folglich", "somit", "because", "therefore",
    "thus", "hence", "consequently",
];
const CONN_ADVERSATIV: &[&str] =
    &["aber", "allerdings", "jedoch", "hingegen", "andererseits", "however", "whereas", "conversely"];
const CONN_KONZESSIV: &[&str] = &[
    "obwohl", "trotzdem", "dennoch", "gleichwohl", "although", "though", "nonetheless",
    "nevertheless", "despite",
];
const CONN_TEMPORAL: &[&str] = &[
    "dann", "danach", "zuerst", "anschließend", "schließlich", "währenddessen", "then",
    "afterwards", "first", "next", "finally", "meanwhile",
];
const CONN_KONDITIONAL: &[&str] = &["wenn", "falls", "sofern", "unless", "provided", "whether"];
const CONN_ADDITIV: &[&str] = &[
    "außerdem", "zudem", "ebenfalls", "obendrein", "moreover", "furthermore", "additionally",
    "besides",
];

static CONN_BUCKETS: Lazy<HashMap<&'static str, u8>> = Lazy::new(|| {
    let mut m = HashMap::new();
    for (bit, list) in [
        CONN_KAUSAL,
        CONN_ADVERSATIV,
        CONN_KONZESSIV,
        CONN_TEMPORAL,
        CONN_KONDITIONAL,
        CONN_ADDITIV,
    ]
    .iter()
    .enumerate()
    {
        for w in *list {
            m.insert(*w, bit as u8);
        }
    }
    m
});

fn connector_bucket(w: &str) -> Option<u8> {
    CONN_BUCKETS.get(w).copied()
}

/// Nominalstil suffix (bureaucratic nominalization), min 6 chars to avoid noise.
fn is_nominal(w: &str) -> bool {
    if w.chars().count() < 6 {
        return false;
    }
    const SUF: &[&str] = &["ung", "heit", "keit", "tion", "sion", "ismus", "nahme"];
    SUF.iter().any(|s| w.ends_with(s))
}

/// Partizip-II candidate (contract §5 heuristic): DE ge-...-t/-en (≥6 chars) or
/// -iert (≥6), or EN -ed (≥4). Consistent → trend-valid even if imperfect.
fn is_partizip(w: &str) -> bool {
    let n = w.chars().count();
    if n >= 6 && w.starts_with("ge") && (w.ends_with('t') || w.ends_with("en")) {
        return true;
    }
    if n >= 6 && w.ends_with("iert") {
        return true;
    }
    if n >= 4 && w.ends_with("ed") {
        return true;
    }
    false
}

fn is_passive_sentence(tokens: &[String]) -> bool {
    let aux = tokens.iter().any(|t| PASSIVE_AUX_SET.contains(t.as_str()));
    let part = tokens.iter().any(|t| is_partizip(t));
    aux && part
}

// ── MTLD (McCarthy & Jarvis 2010) ────────────────────────────────────────────

const MTLD_THRESHOLD: f64 = 0.72;

/// One-directional MTLD: walk the tokens accumulating a running TTR; each time it
/// falls to/below the threshold, close a factor and reset. The leftover segment
/// contributes a proportional partial factor `(1 - TTR) / (1 - threshold)`.
fn mtld_unidirectional<'a, I: Iterator<Item = &'a String>>(it: I) -> f64 {
    let mut factors = 0.0_f64;
    let mut types: HashSet<&str> = HashSet::new();
    let mut n = 0usize;
    let mut total = 0usize;
    for w in it {
        total += 1;
        n += 1;
        types.insert(w.as_str());
        let ttr = types.len() as f64 / n as f64;
        if ttr <= MTLD_THRESHOLD {
            factors += 1.0;
            types.clear();
            n = 0;
        }
    }
    if n > 0 {
        let ttr = types.len() as f64 / n as f64;
        factors += (1.0 - ttr) / (1.0 - MTLD_THRESHOLD);
    }
    if factors <= 0.0 {
        // Perfectly diverse with a clean boundary → MTLD equals the length.
        return total as f64;
    }
    total as f64 / factors
}

/// Bidirectional MTLD (mean of forward + backward passes). Tokens follow the
/// `analysis::tokenize` rules.
pub fn mtld(tokens: &[String]) -> f64 {
    if tokens.is_empty() {
        return 0.0;
    }
    let fwd = mtld_unidirectional(tokens.iter());
    let bwd = mtld_unidirectional(tokens.iter().rev());
    (fwd + bwd) / 2.0
}

// ── Per-day raw metrics (the cached payload) ─────────────────────────────────

/// Raw per-day statistics — the `speech_daily.payload`. Everything is stored as
/// counts / moment sums (NEVER scores) so a window is the plain SUM of its days
/// (token-weighted by construction); `mtld_wsum` carries `mtld * tokens` so the
/// window MTLD is the token-weighted mean `mtld_wsum / tokens`. `conn_mask` is
/// OR-combined across days.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DayStats {
    pub words: f64,          // human words (split_whitespace) — the enough-data + display count
    pub tokens: f64,         // tokenize() tokens — weight + rate denominator
    pub content_tokens: f64, // non-stopword tokens
    pub elig: f64,           // non-stopword AND ≥5 chars (Gehoben denominator)
    pub elevated: f64,       // elig tokens with a rarity band ≥1
    pub weak: f64,
    pub vague: f64,
    pub hedge: f64,
    pub filler: f64, // kept discourse fillers + stripped hesitations
    pub nominal: f64,
    pub conn: f64,
    pub conn_mask: i64,
    pub sent_n: f64,   // qualifying sentences (≥3 tokens)
    pub sent_sum: f64, // Σ sentence length (tokens)
    pub sent_sq: f64,  // Σ length²
    pub sent_long: f64, // sentences > 25 tokens
    pub long_words: f64, // tokens > 6 chars (LIX)
    pub passive_sent: f64,
    pub wpm_n: f64,
    pub wpm_sum: f64,
    pub wpm_sq: f64,
    pub mtld_wsum: f64, // mtld(day) * tokens(day)
}

impl DayStats {
    pub fn to_payload(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
    pub fn from_payload(s: &str) -> Option<DayStats> {
        serde_json::from_str(s).ok()
    }
}

/// Compute one day's raw metrics from its dictations (`(text, duration_s)`) and
/// the day's stripped-hesitation total (from `filler_removed`).
pub fn compute_day(texts: &[(String, f64)], stripped_filler: f64) -> DayStats {
    let mut s = DayStats {
        filler: stripped_filler,
        ..Default::default()
    };
    // Fillers still present in the (already cleaned) text.
    let just_texts: Vec<String> = texts.iter().map(|(t, _)| t.clone()).collect();
    let kept: f64 = analysis::filler_counts(&just_texts)
        .iter()
        .map(|(_, c)| *c as f64)
        .sum();
    s.filler += kept;

    let mut day_tokens: Vec<String> = Vec::new();
    for (text, dur) in texts {
        let toks = analysis::tokenize(text);
        let wc = text.split_whitespace().count() as f64;
        s.words += wc;
        if *dur >= 8.0 {
            let wpm = wc / *dur * 60.0;
            s.wpm_n += 1.0;
            s.wpm_sum += wpm;
            s.wpm_sq += wpm * wpm;
        }
        for w in &toks {
            s.tokens += 1.0;
            let sw = analysis::is_stopword(w);
            let clen = w.chars().count();
            if !sw {
                s.content_tokens += 1.0;
            }
            if clen > 6 {
                s.long_words += 1.0;
            }
            if !sw && clen >= 5 {
                s.elig += 1.0;
                if rarity::lookup(w).is_some() {
                    s.elevated += 1.0;
                }
            }
            if analysis::is_weak_word(w) {
                s.weak += 1.0;
            }
            if VAGUE_SET.contains(w.as_str()) {
                s.vague += 1.0;
            }
            if HEDGE_SET.contains(w.as_str()) {
                s.hedge += 1.0;
            }
            if is_nominal(w) {
                s.nominal += 1.0;
            }
            if let Some(b) = connector_bucket(w) {
                s.conn += 1.0;
                s.conn_mask |= 1 << b;
            }
        }
        for pair in toks.windows(2) {
            if pair[0] == "ich" && HEDGE2_SET.contains(pair[1].as_str()) {
                s.hedge += 1.0;
            }
        }
        for sent in analysis::split_sentences(text) {
            let st = analysis::tokenize(&sent);
            if st.len() < 3 {
                continue; // ignore dictation fragments (contract §Datenbasis)
            }
            let len = st.len() as f64;
            s.sent_n += 1.0;
            s.sent_sum += len;
            s.sent_sq += len * len;
            if st.len() > 25 {
                s.sent_long += 1.0;
            }
            if is_passive_sentence(&st) {
                s.passive_sent += 1.0;
            }
        }
        day_tokens.extend(toks);
    }
    let m = mtld(&day_tokens);
    s.mtld_wsum = m * day_tokens.len() as f64;
    s
}

/// Token-weighted aggregation over daily rows: additive fields sum, `conn_mask`
/// OR-combines, and the window MTLD falls out of `mtld_wsum / tokens`.
pub fn aggregate<'a, I: Iterator<Item = &'a DayStats>>(it: I) -> DayStats {
    let mut a = DayStats::default();
    for d in it {
        a.words += d.words;
        a.tokens += d.tokens;
        a.content_tokens += d.content_tokens;
        a.elig += d.elig;
        a.elevated += d.elevated;
        a.weak += d.weak;
        a.vague += d.vague;
        a.hedge += d.hedge;
        a.filler += d.filler;
        a.nominal += d.nominal;
        a.conn += d.conn;
        a.conn_mask |= d.conn_mask;
        a.sent_n += d.sent_n;
        a.sent_sum += d.sent_sum;
        a.sent_sq += d.sent_sq;
        a.sent_long += d.sent_long;
        a.long_words += d.long_words;
        a.passive_sent += d.passive_sent;
        a.wpm_n += d.wpm_n;
        a.wpm_sum += d.wpm_sum;
        a.wpm_sq += d.wpm_sq;
        a.mtld_wsum += d.mtld_wsum;
    }
    a
}

// ── Derived metric values ────────────────────────────────────────────────────

/// The metric VALUES (contract sub-metrics) derived from raw stats — identical
/// path for a single day or an aggregated window.
#[derive(Debug, Clone, Default)]
pub struct Metrics {
    pub mtld: f64,
    pub elegance_rate: f64, // %
    pub weak_rate: f64,     // per 1000 content tokens
    pub vague_rate: f64,    // per 1000 tokens
    pub hedge_rate: f64,    // per 1000 tokens
    pub lix: f64,
    pub nested_share: f64,   // fraction
    pub avg_sentence: f64,   // tokens
    pub p90_sentence: f64,   // tokens (normal-approx estimate from mean+SD)
    pub conn_density: f64,   // connectors/sentence
    pub conn_buckets: f64,   // 0..6
    pub passive_share: f64,  // fraction
    pub nominal_rate: f64,   // per 100 tokens
    pub filler_rate: f64,    // %
    pub wpm_cv: f64,
    pub rhythm_sd: f64,
}

fn safe_div(a: f64, b: f64) -> f64 {
    if b > 0.0 {
        a / b
    } else {
        0.0
    }
}

pub fn metrics(s: &DayStats) -> Metrics {
    let avg_sentence = safe_div(s.sent_sum, s.sent_n);
    let rhythm_var = safe_div(s.sent_sq, s.sent_n) - avg_sentence * avg_sentence;
    let rhythm_sd = rhythm_var.max(0.0).sqrt();
    let wpm_mean = safe_div(s.wpm_sum, s.wpm_n);
    let wpm_cv = if s.wpm_n >= 2.0 && wpm_mean > 0.0 {
        let var = safe_div(s.wpm_sq, s.wpm_n) - wpm_mean * wpm_mean;
        var.max(0.0).sqrt() / wpm_mean
    } else {
        0.0
    };
    Metrics {
        mtld: safe_div(s.mtld_wsum, s.tokens),
        elegance_rate: safe_div(s.elevated, s.elig) * 100.0,
        weak_rate: safe_div(s.weak, s.content_tokens) * 1000.0,
        vague_rate: safe_div(s.vague, s.tokens) * 1000.0,
        hedge_rate: safe_div(s.hedge, s.tokens) * 1000.0,
        lix: avg_sentence + safe_div(s.long_words, s.tokens) * 100.0,
        nested_share: safe_div(s.sent_long, s.sent_n),
        avg_sentence,
        p90_sentence: avg_sentence + 1.2816 * rhythm_sd,
        conn_density: safe_div(s.conn, s.sent_n),
        conn_buckets: (s.conn_mask.count_ones()) as f64,
        passive_share: safe_div(s.passive_sent, s.sent_n),
        nominal_rate: safe_div(s.nominal, s.tokens) * 100.0,
        filler_rate: safe_div(s.filler, s.tokens) * 100.0,
        wpm_cv,
        rhythm_sd,
    }
}

// ── ANCHORS — the single calibratable table (scores mapped at read time) ─────

/// Piecewise-linear anchor tables (x ascending). One central, calibratable
/// place; changing these needs NO cache invalidation (see module docs).
pub struct Anchors {
    pub mtld: &'static [(f64, f64)],
    pub elegance_bonus: &'static [(f64, f64)],
    pub weak: &'static [(f64, f64)],
    pub vague: &'static [(f64, f64)],
    pub hedge: &'static [(f64, f64)],
    pub lix: &'static [(f64, f64)],
    pub nested_pct: &'static [(f64, f64)],
    pub conn_density: &'static [(f64, f64)],
    pub conn_buckets_bonus: &'static [(f64, f64)],
    pub passive_pct: &'static [(f64, f64)],
    pub nominal: &'static [(f64, f64)],
    pub filler: &'static [(f64, f64)],
    pub wpm_cv: &'static [(f64, f64)],
    pub rhythm: &'static [(f64, f64)],
}

pub const ANCHORS: Anchors = Anchors {
    mtld: &[(40.0, 25.0), (70.0, 55.0), (100.0, 80.0), (130.0, 95.0)],
    elegance_bonus: &[(0.0, 0.0), (2.0, 5.0), (5.0, 10.0)],
    weak: &[(0.0, 100.0), (8.0, 75.0), (20.0, 45.0), (40.0, 15.0)],
    vague: &[(0.0, 100.0), (8.0, 75.0), (20.0, 45.0), (40.0, 15.0)],
    hedge: &[(0.0, 95.0), (10.0, 80.0), (25.0, 55.0), (50.0, 25.0)],
    lix: &[(30.0, 70.0), (38.0, 90.0), (48.0, 90.0), (58.0, 55.0), (70.0, 25.0)],
    nested_pct: &[(0.0, 100.0), (10.0, 75.0), (25.0, 45.0), (40.0, 20.0)],
    conn_density: &[(0.0, 30.0), (0.25, 85.0), (0.7, 85.0), (1.2, 50.0)],
    conn_buckets_bonus: &[(0.0, 0.0), (4.0, 15.0)],
    passive_pct: &[(0.0, 95.0), (8.0, 80.0), (20.0, 50.0), (35.0, 25.0)],
    nominal: &[(2.0, 90.0), (5.0, 70.0), (9.0, 45.0), (14.0, 25.0)],
    filler: &[(0.5, 95.0), (1.5, 80.0), (3.0, 55.0), (6.0, 25.0)],
    wpm_cv: &[(0.15, 90.0), (0.3, 70.0), (0.5, 45.0)],
    rhythm: &[(3.0, 60.0), (7.0, 90.0), (14.0, 60.0)],
};

/// Piecewise-linear map with end clamping. Handles rising, falling and plateau
/// tables; below the first anchor → first y, above the last → last y.
pub fn map_pw(x: f64, pts: &[(f64, f64)]) -> f64 {
    if pts.is_empty() {
        return 0.0;
    }
    if x <= pts[0].0 {
        return pts[0].1;
    }
    let last = pts[pts.len() - 1];
    if x >= last.0 {
        return last.1;
    }
    for w in pts.windows(2) {
        let (x0, y0) = w[0];
        let (x1, y1) = w[1];
        if x <= x1 {
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
        }
    }
    last.1
}

fn clamp100(x: f64) -> f64 {
    x.clamp(0.0, 100.0)
}

/// Six dimension scores + overall, from raw stats (single day OR window).
#[derive(Debug, Clone, Default)]
pub struct Scored {
    pub metrics: Metrics,
    pub variety: f64,
    pub precision: f64,
    pub clarity: f64,
    pub structure: f64,
    pub active: f64,
    pub fluency: f64,
    pub overall: f64,
}

pub fn score(s: &DayStats) -> Scored {
    let m = metrics(s);
    let variety = clamp100(map_pw(m.mtld, ANCHORS.mtld) + map_pw(m.elegance_rate, ANCHORS.elegance_bonus));
    let precision = (map_pw(m.weak_rate, ANCHORS.weak)
        + map_pw(m.vague_rate, ANCHORS.vague)
        + map_pw(m.hedge_rate, ANCHORS.hedge))
        / 3.0;
    let clarity =
        0.6 * map_pw(m.lix, ANCHORS.lix) + 0.4 * map_pw(m.nested_share * 100.0, ANCHORS.nested_pct);
    let structure = clamp100(
        map_pw(m.conn_density, ANCHORS.conn_density)
            + map_pw(m.conn_buckets, ANCHORS.conn_buckets_bonus),
    );
    let active = 0.6 * map_pw(m.passive_share * 100.0, ANCHORS.passive_pct)
        + 0.4 * map_pw(m.nominal_rate, ANCHORS.nominal);
    let fluency = 0.5 * map_pw(m.filler_rate, ANCHORS.filler)
        + 0.25 * map_pw(m.wpm_cv, ANCHORS.wpm_cv)
        + 0.25 * map_pw(m.rhythm_sd, ANCHORS.rhythm);
    let overall = 0.20 * precision
        + 0.20 * variety
        + 0.175 * clarity
        + 0.175 * fluency
        + 0.125 * active
        + 0.125 * structure;
    Scored {
        metrics: m,
        variety: clamp100(variety),
        precision: clamp100(precision),
        clarity: clamp100(clarity),
        structure: clamp100(structure),
        active: clamp100(active),
        fluency: clamp100(fluency),
        overall: clamp100(overall),
    }
}

// ── Rounding + JSON assembly ─────────────────────────────────────────────────

fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}
fn r2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}
fn ri(x: f64) -> i64 {
    x.round() as i64
}

fn metric(key: &str, value: f64) -> Value {
    json!({ "key": key, "value": value })
}

fn scores_obj(sc: &Scored) -> Value {
    json!({
        "variety": ri(sc.variety),
        "precision": ri(sc.precision),
        "clarity": ri(sc.clarity),
        "structure": ri(sc.structure),
        "active": ri(sc.active),
        "fluency": ri(sc.fluency),
    })
}

/// Full `speech_profile` payload for one window. `window_texts` are only used
/// for the exact `distinctWords` + `hapaxRate` display sub-metrics (a cheap type
/// pass — union counts aren't reconstructable from daily rows). `recent7` /
/// `prev30` drive the insight deltas.
#[allow(clippy::too_many_arguments)]
pub fn build_profile(
    window: &DayStats,
    window_texts: &[String],
    ghost: Option<&DayStats>,
    recent7: &DayStats,
    prev30: &DayStats,
    days: u32,
) -> Value {
    let sc = score(window);
    let m = &sc.metrics;
    let (distinct, hapax) = window_type_stats(window_texts);

    let dimensions = json!([
        { "key": "variety", "score": ri(sc.variety), "metrics": [
            metric("mtld", r1(m.mtld)),
            metric("eleganceRate", r1(m.elegance_rate)),
            metric("distinctWords", distinct as f64),
            metric("hapaxRate", r2(hapax)),
        ]},
        { "key": "precision", "score": ri(sc.precision), "metrics": [
            metric("weakRate", r1(m.weak_rate)),
            metric("vagueRate", r1(m.vague_rate)),
            metric("hedgeRate", r1(m.hedge_rate)),
        ]},
        { "key": "clarity", "score": ri(sc.clarity), "metrics": [
            metric("lix", r1(m.lix)),
            metric("nestedShare", r2(m.nested_share)),
            metric("avgSentence", r1(m.avg_sentence)),
            metric("p90Sentence", r1(m.p90_sentence)),
        ]},
        { "key": "structure", "score": ri(sc.structure), "metrics": [
            metric("connDensity", r2(m.conn_density)),
            metric("connBuckets", r1(m.conn_buckets)),
        ]},
        { "key": "active", "score": ri(sc.active), "metrics": [
            metric("passiveShare", r2(m.passive_share)),
            metric("nominalRate", r1(m.nominal_rate)),
        ]},
        { "key": "fluency", "score": ri(sc.fluency), "metrics": [
            metric("fillerRate", r1(m.filler_rate)),
            metric("wpmCv", r2(m.wpm_cv)),
            metric("rhythmSd", r1(m.rhythm_sd)),
        ]},
    ]);

    let ghost_val = match ghost {
        Some(g) if g.words >= MIN_WORDS => {
            let gs = score(g);
            json!({ "overall": ri(gs.overall), "scores": scores_obj(&gs) })
        }
        _ => Value::Null,
    };

    json!({
        "window_days": days,
        "total_words": window.words as i64,
        "enough_data": window.words >= MIN_WORDS,
        "overall": ri(sc.overall),
        "dimensions": dimensions,
        "ghost": ghost_val,
        "insights": insights(recent7, prev30),
    })
}

/// Per-day trend series (ascending, only days ≥ 50 words).
pub fn build_trend(days_rows: &[(String, DayStats)]) -> Value {
    let mut sorted: Vec<&(String, DayStats)> = days_rows.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let out: Vec<Value> = sorted
        .iter()
        .filter(|(_, s)| s.words >= 50.0)
        .map(|(day, s)| {
            let sc = score(s);
            json!({
                "day": day,
                "overall": ri(sc.overall),
                "scores": scores_obj(&sc),
                "words": s.words as i64,
            })
        })
        .collect();
    json!({ "days": out })
}

/// Exact window vocabulary breadth: distinct word forms + hapax rate (fraction of
/// types occurring exactly once). Not reconstructable from daily rows (union),
/// so computed here from the window texts.
pub fn window_type_stats(texts: &[String]) -> (i64, f64) {
    let mut counts: HashMap<String, i64> = HashMap::new();
    for t in texts {
        for w in analysis::tokenize(t) {
            *counts.entry(w).or_insert(0) += 1;
        }
    }
    let distinct = counts.len() as i64;
    let hapax = counts.values().filter(|&&c| c == 1).count() as f64;
    let rate = if distinct > 0 {
        hapax / distinct as f64
    } else {
        0.0
    };
    (distinct, rate)
}

// ── Insights (recent 7 days vs previous 30) ──────────────────────────────────

/// Minimum tokens on both sides before delta-based insights fire (noise guard).
const INSIGHT_MIN_RECENT: f64 = 100.0;
const INSIGHT_MIN_BASE: f64 = 300.0;
/// Relative-change magnitude that triggers a delta insight.
const INSIGHT_DELTA: f64 = 0.15;

fn rel(cur: f64, base: f64) -> Option<f64> {
    if base > 1e-9 {
        Some((cur - base) / base)
    } else {
        None
    }
}

/// severity: 1 = praise/info (improvements), 2 = hint, 3 = pronounced (|Δ|>0.5).
fn severity(delta: f64, improvement: bool) -> i64 {
    if improvement {
        1
    } else if delta.abs() > 0.5 {
        3
    } else {
        2
    }
}

pub fn insights(recent7: &DayStats, prev30: &DayStats) -> Value {
    let mut out: Vec<(f64, Value)> = Vec::new(); // (|delta|*severity, json)
    let cur = metrics(recent7);
    let base = metrics(prev30);
    let have_delta = recent7.tokens >= INSIGHT_MIN_RECENT && prev30.tokens >= INSIGHT_MIN_BASE;

    let mut push = |id: &str, delta: f64, improvement: bool| {
        let sev = severity(delta, improvement);
        out.push((
            delta.abs() * sev as f64,
            json!({ "id": id, "severity": sev, "delta": r2(delta) }),
        ));
    };

    if have_delta {
        // Worsening (up = bad).
        if let Some(d) = rel(cur.hedge_rate, base.hedge_rate) {
            if d >= INSIGHT_DELTA {
                push("hedging_up", d, false);
            }
        }
        if let Some(d) = rel(cur.weak_rate, base.weak_rate) {
            if d >= INSIGHT_DELTA {
                push("weak_up", d, false);
            }
        }
        if let Some(d) = rel(cur.passive_share, base.passive_share) {
            if d >= INSIGHT_DELTA {
                push("passive_up", d, false);
            }
        }
        if let Some(d) = rel(cur.nested_share, base.nested_share) {
            if d >= INSIGHT_DELTA {
                push("nesting_up", d, false);
            }
        }
        // Filler both ways.
        if let Some(d) = rel(cur.filler_rate, base.filler_rate) {
            if d >= INSIGHT_DELTA {
                push("filler_up", d, false);
            } else if d <= -INSIGHT_DELTA {
                push("filler_down", d, true);
            }
        }
        // Improvements (up = good).
        if let Some(d) = rel(cur.mtld, base.mtld) {
            if d >= INSIGHT_DELTA {
                push("variety_up", d, true);
            }
        }
        if let Some(d) = rel(cur.elegance_rate, base.elegance_rate) {
            if d >= INSIGHT_DELTA {
                push("elegance_up", d, true);
            }
        }
    }

    // Absolute-state hints (need enough recent signal, no baseline required).
    if recent7.sent_n >= 5.0 && cur.rhythm_sd < 3.0 {
        let d = (3.0 - cur.rhythm_sd) / 3.0;
        out.push((
            d.abs() * 2.0,
            json!({ "id": "monotone_rhythm", "severity": 2, "delta": r2(d) }),
        ));
    }
    if recent7.sent_n >= 5.0 && cur.conn_density < 0.15 {
        let d = (0.25 - cur.conn_density) / 0.25;
        out.push((
            d.abs() * 2.0,
            json!({ "id": "connectors_low", "severity": 2, "delta": r2(d) }),
        ));
    }

    // Rank by |delta|·severity, keep the four strongest.
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(4);
    Value::Array(out.into_iter().map(|(_, v)| v).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(s: &str) -> Vec<String> {
        analysis::tokenize(s)
    }

    // ── MTLD golden fixtures (vs. Python reference; ±0.5) ────────────────────

    #[test]
    fn mtld_fixture_low() {
        let one = "das ist gut und das ist auch gut denn gut ist gut";
        let joined = std::iter::repeat(one).take(8).collect::<Vec<_>>().join(" ");
        let t = toks(&joined);
        assert_eq!(t.len(), 96, "FIX_LOW token count");
        assert!((mtld(&t) - 6.000).abs() < 0.5, "FIX_LOW MTLD = {}", mtld(&t));
    }

    #[test]
    fn mtld_fixture_mid() {
        let one = "wir haben heute über das neue projekt gesprochen und dabei einige wichtige entscheidungen getroffen die uns im nächsten quartal deutlich schneller machen sollten außerdem planen wir eine überarbeitung der internen abläufe damit alle teams besser zusammenarbeiten können und weniger zeit mit abstimmung verlieren ";
        let joined = one.repeat(3);
        let t = toks(&joined);
        assert_eq!(t.len(), 126, "FIX_MID token count");
        assert!((mtld(&t) - 63.000).abs() < 0.5, "FIX_MID MTLD = {}", mtld(&t));
    }

    #[test]
    fn mtld_fixture_high() {
        let s = "die einzigartige komplexität moderner sprachverarbeitung erfordert differenzierte analytische betrachtungsweisen wobei unterschiedliche linguistische dimensionen wie lexikalische vielfalt syntaktische eleganz rhetorische präzision und pragmatische kohärenz jeweils eigenständige metriken verdienen deren sorgfältige kalibrierung empirische validierung gegen authentische korpora voraussetzt gleichzeitig offenbaren neuronale transkriptionssysteme bemerkenswerte fortschritte hinsichtlich akustischer robustheit phonetischer treffsicherheit sowie kontextueller disambiguierung was wiederum völlig neuartige anwendungsfelder eröffnet etwa gesprächsanalytische werkzeuge rhetorische trainingsumgebungen oder adaptive lernbegleiter deren pädagogischer nutzen empirisch überprüfbar bleibt und deshalb kontinuierliche wissenschaftliche begleitung verdient";
        let t = toks(s);
        assert_eq!(t.len(), 76, "FIX_HIGH token count");
        assert!(
            (mtld(&t) - 539.093).abs() < 0.5,
            "FIX_HIGH MTLD = {}",
            mtld(&t)
        );
    }

    // ── Construction fixtures ────────────────────────────────────────────────

    #[test]
    fn passive_quote_fixture() {
        // 10 sentences, 8 passive (werden + ge-Partizip per the contract's
        // ^ge.+(t|en)$ heuristic), 2 active.
        let text = "der bericht wurde gestern geschrieben. \
                    die entscheidung wurde vom team getroffen. \
                    das projekt wird nächste woche gestartet. \
                    die daten werden sorgfältig geprüft. \
                    der brief wurde schnell geschrieben. \
                    die aufgabe wird heute gemacht. \
                    das lied wurde laut gesungen. \
                    die software wird derzeit getestet. \
                    wir gehen heute ins büro. \
                    ich mag diesen sonnigen tag.";
        let s = compute_day(&[(text.to_string(), 0.0)], 0.0);
        let m = metrics(&s);
        assert!(
            (m.passive_share - 0.8).abs() < 0.05,
            "passive share = {}",
            m.passive_share
        );
    }

    #[test]
    fn monotone_rhythm_fixture() {
        // Every sentence exactly 8 tokens → SD ≈ 0.
        let sent = "alpha beta gamma delta epsilon zeta eta theta";
        let text = std::iter::repeat(sent)
            .take(6)
            .collect::<Vec<_>>()
            .join(". ")
            + ".";
        let s = compute_day(&[(text, 0.0)], 0.0);
        let m = metrics(&s);
        assert_eq!(s.sent_n, 6.0, "sentence count");
        assert!(m.rhythm_sd < 0.001, "rhythm SD = {}", m.rhythm_sd);
    }

    #[test]
    fn connectors_and_buckets_fixture() {
        // Touches ≥4 buckets: kausal(weil), adversativ(aber), konzessiv(obwohl),
        // temporal(danach), additiv(außerdem).
        let text = "wir starten weil es dringend ist. aber wir bleiben ruhig. \
                    obwohl es schwer war blieb das team. danach kam die pause. \
                    außerdem planen wir mehr zeit.";
        let s = compute_day(&[(text.to_string(), 0.0)], 0.0);
        let m = metrics(&s);
        assert!(m.conn_buckets >= 4.0, "buckets = {}", m.conn_buckets);
        assert!(m.conn_density > 0.0, "density = {}", m.conn_density);

        let bare = compute_day(
            &[("heute war das wetter angenehm und mild".to_string(), 0.0)],
            0.0,
        );
        assert_eq!(metrics(&bare).conn_buckets, 0.0, "no connectors → 0 buckets");
    }

    #[test]
    fn hedging_fixture() {
        let text = "vielleicht sollten wir das machen. ich glaube das könnte gut sein. \
                    möglicherweise ist es besser. ich denke wir würden gewinnen.";
        let s = compute_day(&[(text.to_string(), 0.0)], 0.0);
        // Markers: vielleicht, sollten, könnte, möglicherweise, würden (5 single)
        // + "ich glaube" + "ich denke" (2 bigrams) = 7.
        assert_eq!(s.hedge, 7.0, "hedge count = {}", s.hedge);
    }

    #[test]
    fn nested_and_lix_fixture() {
        // One long sentence (> 25 tokens) among short ones → nested_share > 0.
        let long = (0..30).map(|i| format!("wort{i}")).collect::<Vec<_>>().join(" ");
        let text = format!("{long}. kurzer satz hier. noch ein satz dazu.");
        let s = compute_day(&[(text, 0.0)], 0.0);
        let m = metrics(&s);
        assert_eq!(s.sent_n, 3.0);
        assert!((m.nested_share - 1.0 / 3.0).abs() < 1e-9, "nested = {}", m.nested_share);
    }

    // ── Anchor mapping ───────────────────────────────────────────────────────

    #[test]
    fn anchor_mapping_exact_linear_clamp() {
        // Exact anchor points.
        assert_eq!(map_pw(70.0, ANCHORS.mtld), 55.0);
        assert_eq!(map_pw(100.0, ANCHORS.mtld), 80.0);
        // Linear midpoint between (70,55) and (100,80): 85 → 67.5.
        assert!((map_pw(85.0, ANCHORS.mtld) - 67.5).abs() < 1e-9);
        // Clamp both ends.
        assert_eq!(map_pw(5.0, ANCHORS.mtld), 25.0);
        assert_eq!(map_pw(500.0, ANCHORS.mtld), 95.0);
        // LIX plateau: anywhere in [38,48] → 90.
        assert_eq!(map_pw(38.0, ANCHORS.lix), 90.0);
        assert_eq!(map_pw(43.0, ANCHORS.lix), 90.0);
        assert_eq!(map_pw(48.0, ANCHORS.lix), 90.0);
        // Below plateau clamps to first anchor.
        assert_eq!(map_pw(20.0, ANCHORS.lix), 70.0);
    }

    #[test]
    fn scores_stay_in_range_and_degenerate_is_safe() {
        let empty = DayStats::default();
        let sc = score(&empty);
        for v in [sc.variety, sc.precision, sc.clarity, sc.structure, sc.active, sc.fluency, sc.overall] {
            assert!((0.0..=100.0).contains(&v), "score out of range: {v}");
            assert!(!v.is_nan(), "score is NaN");
        }
    }

    #[test]
    fn payload_shape_matches_contract() {
        let mut window = DayStats {
            words: 600.0,
            ..Default::default()
        };
        window.tokens = 600.0;
        let texts = vec!["die vielfalt der sprache ist bemerkenswert".to_string()];
        let empty = DayStats::default();

        // Ghost with too little data → null.
        let v = build_profile(&window, &texts, Some(&empty), &empty, &empty, 30);
        assert_eq!(v["window_days"], 30);
        assert_eq!(v["total_words"], 600);
        assert_eq!(v["enough_data"], true);
        assert!(v["overall"].is_i64());
        assert!(v["ghost"].is_null(), "ghost < 500 words must be null");
        assert!(v["insights"].is_array());
        let dims = v["dimensions"].as_array().unwrap();
        let order = ["variety", "precision", "clarity", "structure", "active", "fluency"];
        assert_eq!(dims.len(), 6);
        for (d, key) in dims.iter().zip(order) {
            assert_eq!(d["key"], key, "dimension order");
            assert!(d["score"].is_i64());
            assert!(d["metrics"].is_array());
        }
        // Exact sub-metric keys per dimension (the UI reads these).
        let mkeys = |i: usize| -> Vec<String> {
            dims[i]["metrics"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["key"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(mkeys(0), ["mtld", "eleganceRate", "distinctWords", "hapaxRate"]);
        assert_eq!(mkeys(1), ["weakRate", "vagueRate", "hedgeRate"]);
        assert_eq!(mkeys(2), ["lix", "nestedShare", "avgSentence", "p90Sentence"]);
        assert_eq!(mkeys(3), ["connDensity", "connBuckets"]);
        assert_eq!(mkeys(4), ["passiveShare", "nominalRate"]);
        assert_eq!(mkeys(5), ["fillerRate", "wpmCv", "rhythmSd"]);

        // Ghost with enough data → object with overall + six scores.
        let ghost = DayStats { words: 600.0, ..Default::default() };
        let v2 = build_profile(&window, &texts, Some(&ghost), &empty, &empty, 7);
        assert!(v2["ghost"]["overall"].is_i64());
        for key in order {
            assert!(v2["ghost"]["scores"][key].is_i64(), "ghost score {key}");
        }

        // Below the word threshold → enough_data false.
        let small = DayStats { words: 100.0, tokens: 100.0, ..Default::default() };
        let v3 = build_profile(&small, &texts, Some(&empty), &empty, &empty, 30);
        assert_eq!(v3["enough_data"], false);
    }

    #[test]
    fn trend_shape_and_threshold() {
        let day_big = DayStats { words: 120.0, tokens: 120.0, ..Default::default() };
        let day_small = DayStats { words: 20.0, tokens: 20.0, ..Default::default() };
        let rows = vec![
            ("2026-07-02".to_string(), day_big.clone()),
            ("2026-07-01".to_string(), day_small), // < 50 words → dropped
            ("2026-07-03".to_string(), day_big),
        ];
        let v = build_trend(&rows);
        let days = v["days"].as_array().unwrap();
        assert_eq!(days.len(), 2, "only days ≥ 50 words");
        assert_eq!(days[0]["day"], "2026-07-02"); // ascending
        assert_eq!(days[1]["day"], "2026-07-03");
        assert!(days[0]["overall"].is_i64());
        assert!(days[0]["scores"]["variety"].is_i64());
        assert_eq!(days[0]["words"], 120);
    }

    #[test]
    fn aggregate_is_token_weighted() {
        // Two days: a big diverse day and a tiny day → window MTLD is pulled
        // toward the big day (token-weighted, not a plain mean of day values).
        let big_text = "die vielfältige sprache zeigt zahlreiche unterschiedliche facetten und nuancen";
        let big = compute_day(&[(big_text.to_string(), 0.0)], 0.0);
        let small = compute_day(&[("gut gut gut gut".to_string(), 0.0)], 0.0);
        let agg = aggregate([&big, &small].into_iter());
        assert!((agg.tokens - (big.tokens + small.tokens)).abs() < 1e-9);
        let mw = metrics(&agg).mtld;
        assert!(mw > metrics(&small).mtld, "window MTLD should exceed the tiny monotone day");
    }
}
