//! Local text analysis for the Activity + Learning tabs.
//!
//! 100% on-device, zero network: tokenizer, DE/EN stop-word filtering, word
//! frequency, and a lexical-quality pass (type/token ratio, sentence length,
//! filler & discourse words, over-used content words, weak-word detection) plus
//! a curated German UPGRADE_MAP (weak word → richer alternatives) that powers
//! the Learning coach's default suggestions. The optional `/v1/word-upgrade`
//! LLM enrichment lives in `commands.rs` and only ever *augments* this — the
//! analysis here never touches the network, so the coach can't hang on it.

use std::collections::{HashMap, HashSet};

use once_cell::sync::Lazy;

// ── Tokenizer ───────────────────────────────────────────────────────────────

/// Unicode word tokens: lowercase, min length 3, pure-number tokens dropped.
/// Splits on any non-alphanumeric boundary; a token is kept only if it holds at
/// least one alphabetic character (so "2024" / "3" fall out, "gpt4" survives).
pub fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            for lc in ch.to_lowercase() {
                cur.push(lc);
            }
        } else {
            flush_token(&mut out, &mut cur);
        }
    }
    flush_token(&mut out, &mut cur);
    out
}

fn flush_token(out: &mut Vec<String>, cur: &mut String) {
    if cur.is_empty() {
        return;
    }
    let w = std::mem::take(cur);
    // min_len 3 (by char count) + must contain a letter (drops pure-number tokens).
    if w.chars().count() >= 3 && w.chars().any(|c| c.is_alphabetic()) {
        out.push(w);
    }
}

/// Lowercase + strip surrounding non-alphabetic punctuation ("ähm," → "ähm",
/// „also" → "also"). Used by the filler pass, which must see 2-char tokens the
/// main tokenizer drops.
fn normalize_word(raw: &str) -> String {
    let lowered: String = raw.chars().flat_map(|c| c.to_lowercase()).collect();
    lowered
        .trim_matches(|c: char| !c.is_alphabetic())
        .to_string()
}

/// Split on sentence terminators (. ! ? …) → trimmed non-empty sentences.
fn split_sentences(text: &str) -> Vec<String> {
    text.split(|c| c == '.' || c == '!' || c == '?' || c == '…')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

// ── Stop words (DE + EN) ─────────────────────────────────────────────────────

/// German function words (articles, pronouns, prepositions, conjunctions,
/// auxiliaries, common adverbs/particles) + discourse fillers, so word-frequency
/// and top-word views surface content, not glue.
const STOPWORDS_DE: &[&str] = &[
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "eines", "einem", "einen",
    "kein", "keine", "keiner", "keines", "keinem", "keinen", "dieser", "diese", "dieses", "diesem",
    "diesen", "jener", "jene", "jenes", "jeder", "jede", "jedes", "jedem", "jeden", "alle", "allen",
    "aller", "alles", "manche", "mancher", "solche", "welche", "welcher", "welches", "ich", "mich",
    "mir", "mein", "meine", "meiner", "meinem", "meinen", "meines", "der", "wir", "uns", "unser",
    "unsere", "unserer", "unserem", "unseren", "unseres", "ihr", "euch", "euer", "eure", "eurer",
    "du", "dich", "dir", "dein", "deine", "deiner", "deinem", "deinen", "deines", "sie", "ihn",
    "ihm", "ihnen", "ihre", "ihrer", "ihrem", "ihren", "ihres", "sein", "seine", "seiner", "seinem",
    "seinen", "seines", "man", "wer", "wen", "wem", "wessen", "was", "wo", "wie", "warum", "wann",
    "wieso", "weshalb", "und", "oder", "aber", "denn", "sondern", "doch", "weil", "dass", "ob",
    "wenn", "als", "damit", "sodass", "obwohl", "während", "bevor", "nachdem", "sowie", "sowohl",
    "beziehungsweise", "bzw", "aus", "bei", "mit", "nach", "seit", "von", "vom", "zu", "zur", "zum",
    "über", "unter", "vor", "hinter", "neben", "zwischen", "durch", "für", "gegen", "ohne", "um",
    "an", "am", "auf", "in", "im", "ins", "bis", "ab", "per", "pro", "gegenüber", "trotz", "wegen",
    "ist", "sind", "war", "waren", "bin", "bist", "sein", "hat", "haben", "habe", "hast", "hatte",
    "hatten", "wird", "werden", "wurde", "wurden", "worden", "geworden", "gewesen", "kann", "können",
    "konnte", "könnte", "muss", "müssen", "musste", "soll", "sollen", "sollte", "will", "wollen",
    "wollte", "darf", "dürfen", "mag", "mögen", "würde", "würden", "nicht", "nur", "auch", "noch",
    "schon", "mehr", "hier", "dort", "dann", "jetzt", "immer", "nie", "mal", "wieder", "etwa",
    "fast", "ganz", "eben", "so", "zwar", "ja", "nein", "nun", "hin", "her", "weg", "dabei", "dazu",
    "daran", "darauf", "darüber", "worden", "im", "gibt", "geht", "diese", "dieser", "einen",
    // discourse fillers (also counted separately by the filler pass)
    "halt", "quasi", "sozusagen", "eigentlich", "genau", "irgendwie", "also",
];

/// English function words (fallback locale is EN; many users dictate mixed
/// DE/EN) + EN discourse fillers.
const STOPWORDS_EN: &[&str] = &[
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "her", "was", "one",
    "our", "out", "day", "get", "has", "him", "his", "how", "its", "may", "new", "now", "old",
    "see", "two", "way", "who", "boy", "did", "she", "use", "her", "than", "that", "this", "with",
    "have", "from", "they", "will", "would", "there", "their", "what", "about", "which", "when",
    "make", "like", "time", "just", "know", "take", "into", "your", "some", "them", "then", "than",
    "were", "been", "being", "does", "doing", "done", "such", "very", "much", "more", "most",
    "many", "each", "every", "both", "either", "neither", "only", "also", "over", "under", "after",
    "before", "between", "through", "during", "again", "here", "because", "while", "where", "why",
    "how", "shall", "should", "could", "might", "must", "cannot", "onto", "upon", "off", "down",
    "out", "yes", "no", "not", "nor", "yet", "per", "via", "etc", "let", "got",
    // EN discourse fillers (also counted separately by the filler pass)
    "basically", "actually", "literally", "kinda", "sorta",
];

static STOPWORDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    STOPWORDS_DE
        .iter()
        .chain(STOPWORDS_EN.iter())
        .copied()
        .collect()
});

/// Single-token discourse fillers (DE + EN) — vague crutch words the coach
/// flags and the top-word view excludes. Multi-word "you know" is handled in
/// the filler pass as a bigram.
static DISCOURSE_FILLERS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "halt", "quasi", "sozusagen", "eigentlich", "genau", "irgendwie", "also", "basically",
        "actually", "like", "literally",
    ]
    .into_iter()
    .collect()
});

pub fn is_stopword(w: &str) -> bool {
    STOPWORDS.contains(w)
}

// ── Word frequency ───────────────────────────────────────────────────────────

/// Content-word frequency over `texts`, descending by count then alphabetically,
/// truncated to `limit`. Stop-word filtered (DE+EN), min length 3, no numbers.
pub fn word_frequency(texts: &[String], limit: usize) -> Vec<(String, i64)> {
    let mut counts: HashMap<String, i64> = HashMap::new();
    for t in texts {
        for w in tokenize(t) {
            if is_stopword(&w) {
                continue;
            }
            *counts.entry(w).or_insert(0) += 1;
        }
    }
    let mut v: Vec<(String, i64)> = counts.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v.truncate(limit);
    v
}

// ── Filler / hesitation detection ────────────────────────────────────────────

/// Map a hesitation sound onto its canonical label ("äh" / "ähm" / "hmm"), or
/// None if `w` isn't one. Mirrors the spirit of `transcribe::vocab::is_filler`
/// but returns a stable bucket for counting. `w` must already be normalized.
fn hesitation(w: &str) -> Option<&'static str> {
    if w.len() < 2 {
        return None;
    }
    // Pure hum cluster: only h/m, needs BOTH (excludes "mm"=millimetre, "hh").
    if w.chars().all(|c| c == 'h' || c == 'm') && w.contains('h') && w.contains('m') {
        return Some("hmm");
    }
    let first = w.chars().next().unwrap();
    // ä-/ö-lead hesitation: äh, ähh, ähm, ähmm, öh, öhm.
    if (first == 'ä' || first == 'ö') && w.chars().skip(1).all(|c| matches!(c, 'h' | 'm' | 'ä' | 'ö'))
    {
        return Some(if w.contains('m') { "ähm" } else { "äh" });
    }
    // e-lead ONLY with a trailing m (ehm/ehmm) — never bare "eh" (a real word).
    if first == 'e' && w.contains('m') && w.chars().all(|c| matches!(c, 'e' | 'h' | 'm')) {
        return Some("ähm");
    }
    None
}

/// A normalized token's canonical filler label, or None. Combines hesitation
/// sounds with the single-word discourse fillers.
fn canonical_filler(w: &str) -> Option<String> {
    if DISCOURSE_FILLERS.contains(w) {
        return Some(w.to_string());
    }
    hesitation(w).map(|s| s.to_string())
}

/// Count filler / hesitation / discourse words across `texts`, descending by
/// count. Runs over raw whitespace tokens (not the main tokenizer) so 2-char
/// hesitations like "äh" are seen. Also detects the "you know" bigram.
pub fn filler_counts(texts: &[String]) -> Vec<(String, i64)> {
    let mut counts: HashMap<String, i64> = HashMap::new();
    for t in texts {
        let words: Vec<String> = t.split_whitespace().map(normalize_word).collect();
        for (i, w) in words.iter().enumerate() {
            if w.is_empty() {
                continue;
            }
            if let Some(c) = canonical_filler(w) {
                *counts.entry(c).or_insert(0) += 1;
            }
            if w == "you" && words.get(i + 1).map(|n| n == "know").unwrap_or(false) {
                *counts.entry("you know".to_string()).or_insert(0) += 1;
            }
        }
    }
    let mut v: Vec<(String, i64)> = counts.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v
}

// ── Weak words + upgrade map ─────────────────────────────────────────────────

/// Curated over-used / weak German words the coach flags when they actually
/// occur. A superset of the UPGRADE_MAP keys plus a few vague crutch words.
const WEAK_WORDS: &[&str] = &[
    "gut", "schön", "machen", "sache", "sagen", "wichtig", "groß", "schlecht", "viel", "toll",
    "ding", "dinge", "tun", "schnell", "langsam", "wenig", "neu", "alt", "einfach", "schwierig",
    "problem", "interessant", "denken", "finden", "zeigen", "bekommen", "geben", "nehmen", "gehen",
    "kommen", "bringen", "stellen", "nutzen", "brauchen", "helfen", "verbessern", "ändern",
    "erklären", "wirklich", "richtig", "klar", "nett", "super", "cool", "spannend", "leicht",
    "teuer", "billig", "etwas", "sowas", "krass", "mega", "voll", "echt", "total", "ziemlich",
];

/// weak German word → richer alternatives (curated). This is the DEFAULT source
/// for the Learning coach; the LLM hook only ever augments it.
fn upgrade_map() -> &'static [(&'static str, &'static [&'static str])] {
    &[
        ("gut", &["hervorragend", "ausgezeichnet", "solide"]),
        ("schön", &["ansprechend", "elegant", "gelungen"]),
        ("machen", &["umsetzen", "realisieren", "gestalten"]),
        ("sache", &["Angelegenheit", "Aspekt", "Thema"]),
        ("sagen", &["erläutern", "darlegen", "betonen"]),
        ("wichtig", &["entscheidend", "maßgeblich", "zentral"]),
        ("groß", &["umfangreich", "beträchtlich", "erheblich"]),
        ("schlecht", &["mangelhaft", "unzureichend", "fehlerhaft"]),
        ("viel", &["zahlreich", "erheblich", "umfangreich"]),
        ("toll", &["großartig", "herausragend", "beeindruckend"]),
        ("ding", &["Element", "Gegenstand", "Aspekt"]),
        ("dinge", &["Elemente", "Aspekte", "Faktoren"]),
        ("tun", &["handeln", "unternehmen", "bewirken"]),
        ("schnell", &["zügig", "rasch", "umgehend"]),
        ("langsam", &["behäbig", "träge", "gemächlich"]),
        ("wenig", &["gering", "spärlich", "begrenzt"]),
        ("neu", &["innovativ", "aktuell", "modern"]),
        ("alt", &["bewährt", "etabliert", "traditionell"]),
        ("einfach", &["unkompliziert", "mühelos", "verständlich"]),
        ("schwierig", &["anspruchsvoll", "komplex", "herausfordernd"]),
        ("problem", &["Herausforderung", "Hürde", "Schwierigkeit"]),
        ("interessant", &["aufschlussreich", "bemerkenswert", "spannend"]),
        ("denken", &["erwägen", "annehmen", "vermuten"]),
        ("finden", &["erachten", "beurteilen", "einschätzen"]),
        ("zeigen", &["verdeutlichen", "aufzeigen", "demonstrieren"]),
        ("bekommen", &["erhalten", "beziehen", "erlangen"]),
        ("geben", &["bereitstellen", "liefern", "gewähren"]),
        ("nehmen", &["aufnehmen", "beziehen", "wählen"]),
        ("gehen", &["verlaufen", "funktionieren", "voranschreiten"]),
        ("kommen", &["gelangen", "eintreffen", "resultieren"]),
        ("bringen", &["liefern", "herbeiführen", "einbringen"]),
        ("stellen", &["platzieren", "positionieren", "bereitstellen"]),
        ("nutzen", &["verwenden", "einsetzen", "gebrauchen"]),
        ("brauchen", &["benötigen", "erfordern", "voraussetzen"]),
        ("helfen", &["unterstützen", "fördern", "begünstigen"]),
        ("verbessern", &["optimieren", "steigern", "veredeln"]),
        ("ändern", &["anpassen", "modifizieren", "überarbeiten"]),
        ("erklären", &["erläutern", "darlegen", "verdeutlichen"]),
        ("wirklich", &["tatsächlich", "nachweislich", "ausgesprochen"]),
        ("richtig", &["korrekt", "angemessen", "zutreffend"]),
        ("klar", &["eindeutig", "verständlich", "unmissverständlich"]),
        ("nett", &["freundlich", "zuvorkommend", "angenehm"]),
        ("super", &["hervorragend", "ausgezeichnet", "erstklassig"]),
        ("cool", &["beeindruckend", "gelungen", "überzeugend"]),
        ("spannend", &["fesselnd", "packend", "mitreißend"]),
        ("leicht", &["mühelos", "unkompliziert", "einfach"]),
        ("teuer", &["kostspielig", "hochpreisig", "aufwendig"]),
        ("billig", &["preiswert", "günstig", "erschwinglich"]),
    ]
}

// ── Learning analysis ────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct WordCount {
    pub word: String,
    pub count: i64,
}

#[derive(serde::Serialize)]
pub struct OverusedWord {
    pub word: String,
    pub count: i64,
    pub ratio: f64,
}

#[derive(serde::Serialize)]
pub struct LearningStats {
    pub total_words: i64,
    pub unique_words: i64,
    pub type_token_ratio: f64,
    pub avg_sentence_length: f64,
    pub filler_counts: Vec<WordCount>,
    pub top_words: Vec<WordCount>,
    pub overused_words: Vec<OverusedWord>,
    pub weak_words: Vec<WordCount>,
}

/// Full lexical-quality pass over `texts` (all local, no network).
pub fn learning(texts: &[String]) -> LearningStats {
    // All tokens (incl. ≥3-char stop words) → totals + type/token ratio.
    let mut all_counts: HashMap<String, i64> = HashMap::new();
    let mut total_words: i64 = 0;
    for t in texts {
        for w in tokenize(t) {
            total_words += 1;
            *all_counts.entry(w).or_insert(0) += 1;
        }
    }
    let unique_words = all_counts.len() as i64;
    let type_token_ratio = if total_words > 0 {
        unique_words as f64 / total_words as f64
    } else {
        0.0
    };

    // Average sentence length (words per sentence, split on . ! ? …).
    let (mut sent_words, mut sent_count) = (0i64, 0i64);
    for t in texts {
        for s in split_sentences(t) {
            let wc = s.split_whitespace().count() as i64;
            if wc > 0 {
                sent_words += wc;
                sent_count += 1;
            }
        }
    }
    let avg_sentence_length = if sent_count > 0 {
        sent_words as f64 / sent_count as f64
    } else {
        0.0
    };

    // Content words (stop-word + discourse-filler filtered).
    let mut content_counts: HashMap<String, i64> = HashMap::new();
    let mut total_content: i64 = 0;
    for (w, c) in &all_counts {
        if is_stopword(w) || DISCOURSE_FILLERS.contains(w.as_str()) {
            continue;
        }
        content_counts.insert(w.clone(), *c);
        total_content += *c;
    }

    // Top content words.
    let mut top: Vec<(String, i64)> = content_counts.iter().map(|(k, v)| (k.clone(), *v)).collect();
    top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let top_words = top
        .iter()
        .take(15)
        .map(|(w, c)| WordCount {
            word: w.clone(),
            count: *c,
        })
        .collect();

    // Over-used content words: a single lemma taking a notable share (≥3% of all
    // content words) with at least a handful of hits. `ratio` = share of ALL words.
    let mut overused: Vec<OverusedWord> = Vec::new();
    if total_content > 0 && total_words > 0 {
        for (w, c) in &content_counts {
            let share = *c as f64 / total_content as f64;
            if *c >= 4 && share >= 0.03 {
                overused.push(OverusedWord {
                    word: w.clone(),
                    count: *c,
                    ratio: *c as f64 / total_words as f64,
                });
            }
        }
        overused.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.word.cmp(&b.word)));
        overused.truncate(12);
    }

    // Fillers.
    let filler_counts = filler_counts(texts)
        .into_iter()
        .map(|(word, count)| WordCount { word, count })
        .collect();

    // Weak words that actually occur.
    let mut weak: Vec<WordCount> = WEAK_WORDS
        .iter()
        .filter_map(|w| {
            all_counts.get(*w).map(|c| WordCount {
                word: (*w).to_string(),
                count: *c,
            })
        })
        .collect();
    weak.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.word.cmp(&b.word)));
    weak.truncate(20);

    LearningStats {
        total_words,
        unique_words,
        type_token_ratio,
        avg_sentence_length,
        filler_counts,
        top_words,
        overused_words: overused,
        weak_words: weak,
    }
}

// ── Upgrade suggestions (local default) ──────────────────────────────────────

#[derive(serde::Serialize)]
pub struct Suggestion {
    pub word: String,
    pub count: i64,
    pub alternatives: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,
}

/// A short example sentence from `texts` that uses `word` (whole-word,
/// case-insensitive), truncated for display. None if never used in a sentence.
fn example_sentence(texts: &[String], word: &str) -> Option<String> {
    for t in texts {
        for s in split_sentences(t) {
            if tokenize(&s).iter().any(|w| w == word) {
                let trimmed = s.trim();
                if trimmed.chars().count() > 160 {
                    let mut x: String = trimmed.chars().take(157).collect();
                    x.push('…');
                    return Some(x);
                }
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Local upgrade suggestions: every UPGRADE_MAP weak word that actually occurs
/// in `texts`, with its count, alternatives, and an example sentence. Descending
/// by count, capped at 20. This is the coach's guaranteed non-empty default.
pub fn local_suggestions(texts: &[String]) -> Vec<Suggestion> {
    let mut all_counts: HashMap<String, i64> = HashMap::new();
    for t in texts {
        for w in tokenize(t) {
            *all_counts.entry(w).or_insert(0) += 1;
        }
    }
    let mut out: Vec<Suggestion> = Vec::new();
    for (key, alts) in upgrade_map() {
        if let Some(c) = all_counts.get(*key) {
            if *c >= 1 {
                out.push(Suggestion {
                    word: (*key).to_string(),
                    count: *c,
                    alternatives: alts.iter().map(|s| (*s).to_string()).collect(),
                    example: example_sentence(texts, key),
                });
            }
        }
    }
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.word.cmp(&b.word)));
    out.truncate(20);
    out
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizer_lowercases_min_len_and_drops_numbers() {
        let toks = tokenize("Das ist EIN Test 2024, mit ä-Wort und 42!");
        // "das","ist","ein","test","mit","wort","und" — "42"/"2024" dropped, "ä" too short.
        assert!(toks.contains(&"test".to_string()));
        assert!(toks.contains(&"wort".to_string()));
        assert!(toks.iter().all(|t| t.chars().count() >= 3));
        assert!(!toks.iter().any(|t| t == "2024" || t == "42"));
        // lowercase
        assert!(!toks.iter().any(|t| t.chars().any(|c| c.is_uppercase())));
    }

    #[test]
    fn stopword_filter_removes_function_words() {
        assert!(is_stopword("der"));
        assert!(is_stopword("und"));
        assert!(is_stopword("the"));
        assert!(is_stopword("with"));
        assert!(!is_stopword("projekt"));
        assert!(!is_stopword("hervorragend"));
    }

    #[test]
    fn word_frequency_desc_and_stopword_free() {
        let texts = vec![
            "Das Projekt Projekt ist das Projekt".to_string(),
            "Ein neues Projekt und ein Team".to_string(),
        ];
        let freq = word_frequency(&texts, 10);
        // "projekt" (4×) leads; stop words (das/ist/ein/und) are gone.
        assert_eq!(freq[0].0, "projekt");
        assert_eq!(freq[0].1, 4);
        assert!(!freq.iter().any(|(w, _)| is_stopword(w)));
        // limit is honoured
        assert!(word_frequency(&texts, 1).len() == 1);
    }

    #[test]
    fn filler_detection_counts_hesitations_and_discourse() {
        let texts = vec![
            "Also ähm das ist halt, äh, quasi genau so. Hmm.".to_string(),
            "You know, this is basically like that.".to_string(),
        ];
        let f: std::collections::HashMap<String, i64> = filler_counts(&texts).into_iter().collect();
        assert_eq!(f.get("ähm").copied().unwrap_or(0), 1);
        assert_eq!(f.get("äh").copied().unwrap_or(0), 1);
        assert_eq!(f.get("hmm").copied().unwrap_or(0), 1);
        assert_eq!(f.get("also").copied().unwrap_or(0), 1);
        assert_eq!(f.get("halt").copied().unwrap_or(0), 1);
        assert_eq!(f.get("quasi").copied().unwrap_or(0), 1);
        assert_eq!(f.get("genau").copied().unwrap_or(0), 1);
        assert_eq!(f.get("you know").copied().unwrap_or(0), 1);
        assert_eq!(f.get("basically").copied().unwrap_or(0), 1);
    }

    #[test]
    fn hesitation_excludes_real_words() {
        // "eh" (bare), "mm" (millimetre), "hallo" must NOT be fillers.
        assert!(hesitation("eh").is_none());
        assert!(hesitation("mm").is_none());
        assert!(hesitation("hallo").is_none());
        assert_eq!(hesitation("hmm"), Some("hmm"));
        assert_eq!(hesitation("mhm"), Some("hmm"));
        assert_eq!(hesitation("ähm"), Some("ähm"));
        assert_eq!(hesitation("äh"), Some("äh"));
    }

    #[test]
    fn learning_and_local_suggestions_are_populated() {
        let texts = vec![
            "Das ist gut und die Sache ist gut. Das Projekt ist gut.".to_string(),
            "Wir machen das Projekt. Das Projekt ist schön.".to_string(),
        ];
        let st = learning(&texts);
        assert!(st.total_words > 0);
        assert!(st.unique_words > 0);
        assert!(st.type_token_ratio > 0.0 && st.type_token_ratio <= 1.0);
        assert!(st.avg_sentence_length > 0.0);
        // "gut" (weak) actually occurs → present in weak_words.
        assert!(st.weak_words.iter().any(|w| w.word == "gut"));
        // Upgrade coach must yield real suggestions for occurring weak words.
        let sug = local_suggestions(&texts);
        assert!(sug.iter().any(|s| s.word == "gut" && !s.alternatives.is_empty()));
        assert!(sug.iter().any(|s| s.word == "machen"));
    }
}
