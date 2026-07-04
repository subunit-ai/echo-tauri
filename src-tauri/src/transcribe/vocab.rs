//! Vocabulary bias + post-replace (port of `_vocab_prompt` / `apply_vocab_replace`).

use std::collections::HashSet;

use regex::Regex;

use crate::config::Config;

/// Space-joined `write_as` terms, fed to Whisper as the `prompt`/initial_prompt
/// so it biases toward correct spellings of brand/tech/proper nouns. SPACE, not
/// comma: `initial_prompt` also sets Whisper's punctuation STYLE, and a
/// comma-separated list ("Claude, OpenAI, …") makes it sprinkle commas across the
/// real transcription — the tokens still bias spelling either way (measured:
/// space-join yields materially fewer spurious commas). See `despam_commas`.
pub fn vocab_prompt(cfg: &Config) -> String {
    if !cfg.vocab_enabled {
        return String::new();
    }
    let mut seen = HashSet::new();
    let mut terms = Vec::new();
    for e in &cfg.vocabulary {
        let t = e.write_as.trim();
        if !t.is_empty() && seen.insert(t.to_lowercase()) {
            terms.push(t.to_string());
        }
    }
    terms.join(" ")
}

/// Post-process: replace each `sounds_like`/alias with its `write_as`
/// (whole-word, case-insensitive) to fix persistent mishears.
pub fn apply_vocab_replace(text: &str, cfg: &Config) -> String {
    if !cfg.vocab_enabled {
        return text.to_string();
    }
    // Gather every (pattern → target) pair across ALL entries, then apply the
    // longest patterns first. This is global, not per-entry, so a multi-word
    // term ("Klod Koud" → "Claude Code", "Open Claw" → "OpenClaw") wins over a
    // shorter sub-token from another entry ("Klod" → "Claude") that would
    // otherwise corrupt it into "Claude Koud".
    let mut pairs: Vec<(&str, &str)> = Vec::new();
    for e in &cfg.vocabulary {
        let target = e.write_as.trim();
        if target.is_empty() {
            continue;
        }
        let sl = e.sounds_like.trim();
        if !sl.is_empty() && !sl.eq_ignore_ascii_case(target) {
            pairs.push((sl, target));
        }
        for a in &e.aliases {
            let a = a.trim();
            if !a.is_empty() && !a.eq_ignore_ascii_case(target) {
                pairs.push((a, target));
            }
        }
    }
    // Longest pattern first (by char count, so multi-word/punctuated win).
    pairs.sort_by_key(|(p, _)| std::cmp::Reverse(p.chars().count()));

    let mut out = text.to_string();
    let cache = cfg.vocab_regex_cache.lock().unwrap();

    for (p, target) in pairs {
        if let Some(re) = cache.get(p) {
            out = re
                .replace_all(&out, |caps: &regex::Captures| {
                    format!("{}{}{}", &caps[1], target, &caps[2])
                })
                .into_owned();
        } else {
            // Fallback for patterns that weren't built at config time, should be rare
            let pat = format!(r"(?i)(^|[^\w]){}([^\w]|$)", regex::escape(p));
            #[allow(clippy::regex_creation_in_loops)]
            if let Ok(re) = Regex::new(&pat) {
                out = re
                    .replace_all(&out, |caps: &regex::Captures| {
                        format!("{}{}{}", &caps[1], target, &caps[2])
                    })
                    .into_owned();
            }
        }
    }

    out
}

/// Global comma/word ratio above which text is treated as pathological.
const DESPAM_GATE: f64 = 0.45;
/// Min consecutive single-word comma-tokens collapsed inside flagged text.
const DESPAM_RUN_MIN: usize = 2;

/// Collapse Whisper's "comma after every word" on DISFLUENT speech — every
/// prosodic pause becomes a comma, so hesitant dictation ("okay, ähm, Enden,
/// auf, E-Mail, Mitarbeiter, der, alles,") decodes comma-per-word. AI cleanup
/// smooths this, but raw/no-cleanup users get it unfiltered. Deterministic
/// (no LLM), so it applies even in raw mode; the cloud server runs the same pass,
/// this covers the LOCAL engine and is a belt-and-suspenders for the cloud text.
///
/// Precision-first, verified against real transcripts:
///  1. Global gate — only text whose comma/word ratio exceeds `DESPAM_GATE` is
///     touched. Normal prose sits at 0.15–0.31, disfluency spam at 0.66–0.90, so
///     ordinary dictation and legitimate short lists are NEVER altered.
///  2. Inside flagged text, collapse runs of ≥ `DESPAM_RUN_MIN` consecutive
///     single-word comma-chunks (the "word, word, word," pattern) to spaces.
/// Idempotent: a second pass is a no-op (the first drops k/w below the gate).
pub fn despam_commas(text: &str) -> String {
    let word_count = text.split_whitespace().count();
    if word_count == 0 {
        return text.to_string();
    }
    let comma_count = text.matches(',').count();
    if comma_count as f64 / word_count as f64 <= DESPAM_GATE {
        return text.to_string();
    }
    let toks: Vec<&str> = text.split(' ').collect();
    let n = toks.len();
    let mut out: Vec<String> = Vec::with_capacity(n);
    let mut i = 0;
    while i < n {
        // A maximal run of single-word tokens that each end in a comma.
        let mut j = i;
        while j < n && toks[j].chars().count() > 1 && toks[j].ends_with(',') && !toks[j].contains(' ') {
            j += 1;
        }
        if j - i >= DESPAM_RUN_MIN {
            // Drop the trailing comma (1 ASCII byte) from each word in the run.
            for t in &toks[i..j] {
                out.push(t[..t.len() - 1].to_string());
            }
            i = j;
        } else {
            out.push(toks[i].to_string());
            i += 1;
        }
    }
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, VocabEntry};

    #[test]
    fn test_apply_vocab_replace_empty_text() {
        let cfg = Config::default();
        let result = apply_vocab_replace("", &cfg);
        assert_eq!(result, "");
    }

    #[test]
    fn test_apply_vocab_replace_empty_vocab_entry() {
        let mut cfg = Config::default();
        // create a vocab entry that is basically empty
        cfg.vocabulary.push(VocabEntry {
            sounds_like: "".to_string(),
            write_as: "".to_string(),
            aliases: vec![],
            category: "test".to_string(),
        });

        let text = "Hello world";
        let result = apply_vocab_replace(text, &cfg);
        assert_eq!(result, text);
    }

    #[test]
    fn test_apply_vocab_replace_basic() {
        let mut cfg = Config::default();
        cfg.vocabulary.push(VocabEntry {
            sounds_like: "Klod Koud".to_string(),
            write_as: "Claude Code".to_string(),
            aliases: vec!["Clod Code".to_string()],
            category: "test".to_string(),
        });

        // Match sounds like
        let result = apply_vocab_replace("I use Klod Koud.", &cfg);
        assert_eq!(result, "I use Claude Code.");

        // Match alias
        let result2 = apply_vocab_replace("It is Clod Code", &cfg);
        assert_eq!(result2, "It is Claude Code");

        // Match with punctuation
        let result3 = apply_vocab_replace("Klod Koud, really?", &cfg);
        assert_eq!(result3, "Claude Code, really?");

        // Case insensitive
        let result4 = apply_vocab_replace("i use klod koud", &cfg);
        assert_eq!(result4, "i use Claude Code");

        // Not matching sub-word
        let result5 = apply_vocab_replace("I use Klod Kouding", &cfg);
        assert_eq!(result5, "I use Klod Kouding");
    }

    #[test]
    fn test_vocab_disabled_is_passthrough() {
        let mut cfg = Config::default();
        cfg.vocabulary.push(VocabEntry {
            sounds_like: "Sky".to_string(),
            write_as: "SCAI".to_string(),
            aliases: vec![],
            category: "Company".to_string(),
        });

        // Enabled (default): the whole-word replace fires.
        assert_eq!(apply_vocab_replace("ich nutze Sky", &cfg), "ich nutze SCAI");
        assert_eq!(vocab_prompt(&cfg), "SCAI");

        // Disabled: both the bias prompt AND the post-replace go dark, so the
        // master toggle is authoritative on every engine path.
        cfg.vocab_enabled = false;
        assert_eq!(apply_vocab_replace("ich nutze Sky", &cfg), "ich nutze Sky");
        assert_eq!(vocab_prompt(&cfg), "");
    }

    #[test]
    fn despam_collapses_disfluency_spam_but_keeps_normal_text() {
        // Real disfluency spam (comma after nearly every word) → collapsed.
        let spam = "okay, ähm, Enden, auf, E-Mail, Mitarbeiter, der, alles, und, äh";
        assert_eq!(despam_commas(spam), "okay ähm Enden auf E-Mail Mitarbeiter der alles und äh");

        // Normal prose (below the gate) is untouched — commas preserved verbatim.
        let normal = "Okay, ich habe dir den Ordner erstellt, dort ist ein Bild drin, arbeite es sauber ein.";
        assert_eq!(despam_commas(normal), normal);

        // A legitimate short list survives (it doesn't cross the ratio gate).
        let list = "Mach die Farben bitte rot, grün, blau und gelb.";
        assert_eq!(despam_commas(list), list);

        // Idempotent: a second pass changes nothing.
        assert_eq!(despam_commas(&despam_commas(spam)), despam_commas(spam));
    }
}
