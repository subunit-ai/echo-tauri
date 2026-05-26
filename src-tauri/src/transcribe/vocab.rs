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
    let mut out = text.to_string();
    for e in &cfg.vocabulary {
        let target = e.write_as.trim();
        if target.is_empty() {
            continue;
        }
        let mut patterns: Vec<&str> = Vec::new();
        let sl = e.sounds_like.trim();
        if !sl.is_empty() {
            patterns.push(sl);
        }
        for a in &e.aliases {
            let a = a.trim();
            if !a.is_empty() {
                patterns.push(a);
            }
        }
        for p in patterns {
            if p.eq_ignore_ascii_case(target) {
                continue;
            }
            let pat = format!(r"(?i)\b{}\b", regex::escape(p));
            if let Ok(re) = Regex::new(&pat) {
                out = re.replace_all(&out, target).into_owned();
            }
        }
    }
    out
}
