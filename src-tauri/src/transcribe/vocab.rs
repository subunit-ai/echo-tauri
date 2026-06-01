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

    // Instead of an external crate like `lru` or a static cache, we just use a small
    // thread-local HashMap to cache the compiled patterns since the vocabulary list
    // changes very rarely.
    thread_local! {
        static REGEX_CACHE: std::cell::RefCell<std::collections::HashMap<String, Regex>> =
            std::cell::RefCell::new(std::collections::HashMap::new());
    }

    let mut out = text.to_string();
    REGEX_CACHE.with(|cache| {
        let mut cache_mut = cache.borrow_mut();

        // Prevent unbounded memory growth if the user is wildly adding terms over weeks
        // without restarting, though normally this is bounded by their vocabulary size.
        if cache_mut.len() > 1024 {
            cache_mut.clear();
        }

        for (p, target) in pairs {
            // Whole-token, case-insensitive, with boundaries CAPTURED (the regex
            // crate has no lookaround). Handles patterns ending in punctuation
            // ("Echo.", "M.C.P.", "T.J.") that a plain \b…\b would miss.
            let pat = format!(r"(?i)(^|[^\w]){}([^\w]|$)", regex::escape(p));

            // regex::escape guarantees the pattern is valid, so Ok is effectively guaranteed.
            #[allow(clippy::regex_creation_in_loops)]
            if let Some(re) = cache_mut.get(&pat).cloned().or_else(|| {
                #[allow(clippy::manual_inspect)]
                Regex::new(&pat).ok().map(|r| {
                    cache_mut.insert(pat, r.clone());
                    r
                })
            }) {
                out = re
                    .replace_all(&out, |caps: &regex::Captures| {
                        format!("{}{}{}", &caps[1], target, &caps[2])
                    })
                    .into_owned();
            }
        }
    });
    out
}
