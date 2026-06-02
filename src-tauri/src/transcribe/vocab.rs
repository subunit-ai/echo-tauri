//! Vocabulary bias + post-replace (port of `_vocab_prompt` / `apply_vocab_replace`).

use std::collections::HashSet;

use regex::Regex;

use crate::config::Config;

/// Comma-joined `write_as` terms, fed to Whisper as the `prompt`/initial_prompt
/// so it biases toward correct spellings of brand/tech/proper nouns.
pub fn vocab_prompt(cfg: &Config) -> String {
    let mut seen = HashSet::new();
    let mut terms = Vec::new();
    for e in &cfg.vocabulary {
        let t = e.write_as.trim();
        if !t.is_empty() && seen.insert(t.to_lowercase()) {
            terms.push(t.to_string());
        }
    }
    terms.join(", ")
}

/// Post-process: replace each `sounds_like`/alias with its `write_as`
/// (whole-word, case-insensitive) to fix persistent mishears.
pub fn apply_vocab_replace(text: &str, cfg: &Config) -> String {
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
}
