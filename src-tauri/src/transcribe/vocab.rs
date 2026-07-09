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

/// Curated bias list for the CLOUD paths (sent as `prompt`, server-side used as
/// Whisper `hotwords`): only capitalized terms (proper nouns, brands, German
/// nouns) — lowercase everyday words measurably HURT (WER harness 2026-07-09:
/// full list 13.7% WER / 15 of 20 jargon terms vs curated 10.4% / 16) — with
/// brand-ish terms (inner uppercase / multi-word / hyphen, e.g. OpenAI,
/// Claude Code, KI-Bilder) first so they survive faster-whisper's 223-token
/// head-truncation. The LOCAL whisper.cpp path keeps the full `vocab_prompt`
/// (initial_prompt there is unmeasured with this curation).
pub fn vocab_hotwords(cfg: &Config) -> String {
    if !cfg.vocab_enabled {
        return String::new();
    }
    let mut seen = HashSet::new();
    let mut caps: Vec<String> = Vec::new();
    for e in &cfg.vocabulary {
        let t = e.write_as.trim();
        if t.is_empty() || !t.chars().next().is_some_and(|c| c.is_uppercase()) {
            continue;
        }
        if !seen.insert(t.to_lowercase()) {
            continue;
        }
        caps.push(t.to_string());
    }
    let (brand, rest): (Vec<String>, Vec<String>) = caps
        .into_iter()
        .partition(|t| t.chars().skip(1).any(|c| c.is_uppercase()) || t.contains(' ') || t.contains('-'));
    brand.into_iter().chain(rest).collect::<Vec<_>>().join(" ")
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

/// True if `w` (the bare core, no surrounding punctuation) is an unambiguous
/// vocal filler — a hesitation sound that is NEVER a real word, so removing it
/// can't corrupt meaning. Precision-first: tokens that ARE real words are
/// deliberately excluded — "eh" ("das ist eh gut"), "um"/"er"/"man"/"also",
/// and "mm" (millimetre). Case-insensitive; tolerates repeated letters
/// ("ähhh", "hmmm", "ähmm").
fn is_filler(w: &str) -> bool {
    let cs: Vec<char> = w.to_lowercase().chars().collect();
    if cs.len() < 2 {
        return false; // single letters ("m", "ä") are too ambiguous to cut
    }
    match cs[0] {
        // äh, ähh, ähm, ähmm — a leading ä/ö like this never opens a real word.
        'ä' | 'ö' => hm_tail(&cs[1..], false),
        // ehm/ehmm ONLY — never "eh", which is a real word (require a trailing m).
        'e' => hm_tail(&cs[1..], true),
        // Pure hum clusters containing BOTH an h and an m: hm, mh, hmm, mhm, mmh.
        // Excludes "mm" (millimetre) and "hh" (not fillers).
        'h' | 'm' => {
            cs.iter().all(|c| *c == 'h' || *c == 'm')
                && cs.contains(&'h')
                && cs.contains(&'m')
        }
        _ => false,
    }
}

/// After the leading vowel, the tail must be `h`+ then `m`* (e.g. "h", "hm",
/// "hmm"). `require_m` forces at least one trailing 'm' (used for the 'e' lead so
/// "eh" is rejected but "ehm" accepted).
fn hm_tail(rest: &[char], require_m: bool) -> bool {
    let h = rest.iter().take_while(|c| **c == 'h').count();
    if h == 0 {
        return false;
    }
    let m = &rest[h..];
    if !m.iter().all(|c| *c == 'm') {
        return false;
    }
    !require_m || !m.is_empty()
}

/// Deterministic, zero-latency removal of hesitation fillers ("äh", "ähm",
/// "hmm", …) from raw dictation — the cheap "cleanup" that costs no round trip
/// (unlike the AI `/v1/cleanup`). Whole-word only, tolerates a trailing comma
/// (Whisper brackets fillers with commas: "…, ähm, …"), tidies the resulting
/// spacing/commas, and re-capitalizes the sentence if a leading filler was cut.
/// Precision-first: only `is_filler` tokens are ever touched, so real words are
/// never removed. Idempotent.
pub fn strip_fillers(text: &str) -> String {
    if text.trim().is_empty() {
        return text.to_string();
    }
    let toks: Vec<&str> = text.split_whitespace().collect();
    let mut kept: Vec<String> = Vec::with_capacity(toks.len());
    let mut removed_leading = false;
    for tok in &toks {
        // Test the core with one optional trailing comma stripped ("ähm," → "ähm").
        let had_comma = tok.ends_with(',');
        let core = tok.strip_suffix(',').unwrap_or(tok);
        if is_filler(core) {
            if kept.is_empty() {
                removed_leading = true;
            } else if had_comma {
                // Parenthetical filler "X, äh, Y": also drop the comma that opened
                // it so the two clauses rejoin cleanly ("X Y"), not "X, Y".
                if let Some(last) = kept.last_mut() {
                    if let Some(stripped) = last.strip_suffix(',') {
                        *last = stripped.to_string();
                    }
                }
            }
            continue; // drop the filler (and its own trailing comma)
        }
        kept.push((*tok).to_string());
    }
    let mut out = kept.join(" ");
    // Tidy artifacts: a comma left dangling where a filler sat ("ist, gut" ← "ist, äh, gut"),
    // a doubled comma, and a leading comma from a cut sentence-initial filler.
    out = out.replace(" ,", ",").replace(",,", ",");
    let trimmed = out.trim_start_matches([',', ' ']).to_string();
    out = trimmed;
    if removed_leading {
        // The sentence lost its capitalized opener — re-capitalize the new first word.
        let mut chars = out.chars();
        if let Some(first) = chars.next() {
            out = first.to_uppercase().collect::<String>() + chars.as_str();
        }
    }
    out
}

/// The full deterministic post-transcription pass shared by EVERY engine path
/// (cloud / local / streaming final). All zero-latency, no LLM, no network:
/// vocabulary replace → comma de-spam → optional filler strip. Keeping it in one
/// place means the three paths can never drift (the streaming path historically
/// missed some of these).
pub fn post_process(text: &str, cfg: &Config) -> String {
    let t = apply_vocab_replace(text, cfg);
    let t = despam_commas(&t);
    if cfg.filler_removal_enabled {
        strip_fillers(&t)
    } else {
        t
    }
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

    #[test]
    fn strip_fillers_removes_hesitations_only() {
        // Leading filler cut → sentence re-capitalized.
        assert_eq!(
            strip_fillers("Ähm, ich denke, äh, das ist gut."),
            "Ich denke das ist gut."
        );
        // Mid-sentence bare filler.
        assert_eq!(strip_fillers("das ist hmm interessant"), "das ist interessant");
        // Parenthetical filler rejoins cleanly (both commas gone).
        assert_eq!(strip_fillers("Ich glaube, ähm, das passt"), "Ich glaube das passt");
        // Repeated letters.
        assert_eq!(strip_fillers("Also ähhh warte öhm ja"), "Also warte ja");
        // Idempotent.
        let s = "Ähm, na klar, äh, machen wir.";
        assert_eq!(strip_fillers(&strip_fillers(s)), strip_fillers(s));
    }

    #[test]
    fn strip_fillers_never_touches_real_words() {
        // "eh"/"um"/"er"/"man"/"also"/"mm" are real words, NOT fillers.
        let real = "Das ist eh gut, um zehn, er kommt, ein mm Abstand.";
        assert_eq!(strip_fillers(real), real);
        // Whole-word only: "ähnlich" starts with "äh" but must stay intact.
        assert_eq!(strip_fillers("etwas ähnliches"), "etwas ähnliches");
        assert!(!is_filler("eh") && !is_filler("um") && !is_filler("mm") && !is_filler("ohm"));
        assert!(is_filler("äh") && is_filler("ähm") && is_filler("hmm") && is_filler("mhm") && is_filler("ehm"));
    }

    #[test]
    fn post_process_filler_gated_by_toggle() {
        let mut cfg = Config::default();
        assert!(cfg.filler_removal_enabled); // on by default as of v0.5.84
        // On: fillers stripped, still zero-latency (no network).
        assert_eq!(post_process("Ähm das ist gut", &cfg), "Das ist gut");
        // Explicit opt-out: fillers survive the deterministic pass untouched.
        cfg.filler_removal_enabled = false;
        assert_eq!(post_process("Ähm das ist gut", &cfg), "Ähm das ist gut");
    }
}
