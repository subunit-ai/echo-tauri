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
    for (p, target) in pairs {
        // Whole-token, case-insensitive, with boundaries CAPTURED (the regex
        // crate has no lookaround). Handles patterns ending in punctuation
        // ("Echo.", "M.C.P.", "T.J.") that a plain \b…\b would miss.
        let pat = format!(r"(?i)(^|[^\w]){}([^\w]|$)", regex::escape(p));
        if let Ok(re) = Regex::new(&pat) {
            out = re
                .replace_all(&out, |caps: &regex::Captures| {
                    format!("{}{}{}", &caps[1], target, &caps[2])
                })
                .into_owned();
        }
    }
    out
}
