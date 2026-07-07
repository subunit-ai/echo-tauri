//! Deterministic German comma insertion — the zero-latency sibling of
//! `dach.rs`. Whisper drops most commas in German dictation; the AI cleanup
//! that would fix them is off for privacy/latency, so this pass inserts the
//! high-confidence ones by rule (Duden):
//!
//!   - comma before subordinating conjunctions mid-sentence
//!     ("das geht nicht weil …" → "das geht nicht, weil …"), shifting the
//!     comma in front of a modifier ("… auch wenn …" → "…, auch wenn …")
//!   - comma before "sondern"
//!   - comma before "um … zu <Infinitiv>" groups
//!   - misheard "das" → "dass" after verbs of saying/thinking and "ohne"
//!     ("er hat gesagt das er kommt" → "er hat gesagt, dass er kommt")
//!
//! Precision-first like `dach.rs`: every rule has guards and anything
//! ambiguous is left alone ("während des Meetings", "wir sind damit fertig",
//! "und dass", modal-particle positions). Only UNINTRODUCED subordinate
//! clauses ("Ich glaube[,] wir sollten …") are out of reach — those need a
//! parser (LLM cleanup territory). Idempotent; whitespace runs are collapsed
//! (same as `strip_fillers`), which `dach_format` normalises anyway.

/// Subordinating conjunctions that (almost) always open a comma-separated
/// subordinate clause when they appear lowercase mid-sentence.
const SUBJUNCTIONS: &[&str] = &[
    "dass", "weil", "obwohl", "sodass", "sobald", "solange", "sofern",
    "falls", "bevor", "nachdem", "wobei", "ob", "wenn",
];

/// Words that pull the comma in front of themselves when they directly
/// precede a subjunction ("…, auch wenn", "…, erst als", "…, egal ob").
const MODIFIERS: &[&str] = &[
    "auch", "selbst", "erst", "nur", "immer", "gerade", "besonders", "egal",
];

/// A word directly before a trigger that forbids the comma: coordinations
/// ("und dass"), correlates and comparison particles ("wie wenn", "als ob").
const BLOCKERS: &[&str] = &[
    "und", "oder", "bzw", "beziehungsweise", "sowie", "entweder", "weder",
    "noch", "aber", "sondern", "denn", "wie", "als", "doch", "außer",
    "statt", "anstatt", "sowohl", "je", "umso", "desto",
];

/// Tokens that plausibly start a subject — used to tell conjunction-"damit"
/// ("damit wir reisen können") from pronoun-adverb "damit" ("wir sind damit
/// fertig"), and to confirm a dass-clause in the das→dass repair.
const SUBJECT_STARTERS: &[&str] = &[
    "ich", "du", "er", "sie", "es", "wir", "ihr", "man", "der", "die",
    "das", "den", "dem", "ein", "eine", "einer", "alle", "jeder", "jede",
    "jedes", "niemand", "jemand", "keiner", "keine", "nichts", "etwas",
    "mein", "meine", "dein", "deine", "sein", "seine", "unser", "unsere",
    "euer", "eure", "ihre", "diese", "dieser", "dieses", "viele", "wenige",
    "beide", "mehrere",
];

/// Articles/pronouns after "während" that mark prepositional use ("während
/// des Meetings") — no comma there.
const GENITIVE_DATIVE_AFTER_WAEHREND: &[&str] = &[
    "des", "der", "dem", "den", "eines", "einer", "einem", "dieses",
    "dieser", "diesem", "meines", "meiner", "meinem", "seines", "seiner",
    "seinem", "ihres", "ihrer", "ihrem", "unseres", "unserer", "unserem",
    "eures", "eurer", "eurem", "deines", "deiner", "deinem",
];

/// Words after "zu" that rule OUT an infinitive ("um drei Uhr zu einem
/// Termin") even though they end in -en/-em.
const ZU_NON_INFINITIVE: &[&str] = &[
    "einem", "einen", "einer", "seinem", "seinen", "seiner", "ihrem",
    "ihren", "ihrer", "meinem", "meinen", "meiner", "deinem", "deinen",
    "deiner", "unserem", "unseren", "unserer", "eurem", "euren", "eurer",
    "dem", "den", "denen", "allen", "diesen", "diesem", "dieser", "jedem",
    "jeden", "wem", "wen",
];

/// Verbs of saying/thinking (plus predicates) after which a lowercase "das
/// <subject>" is virtually always a misheard "dass" clause.
const SAY_VERBS: &[&str] = &[
    "gesagt", "sagt", "sagte", "sagen", "sage", "denke", "denkt", "dachte",
    "gedacht", "glaube", "glaubt", "glaubte", "geglaubt", "meine", "meint",
    "meinte", "gemeint", "finde", "findet", "fand", "hoffe", "hofft",
    "hoffte", "gehofft", "weiß", "wusste", "gewusst", "wissen", "bedeutet",
    "heißt", "hieß", "zeigt", "zeigte", "gezeigt", "sicher", "klar",
    "wichtig", "möglich", "schade", "gut",
];

/// How many tokens after "um" we scan for the "zu <Infinitiv>" tail.
const UM_ZU_LOOKAHEAD: usize = 12;

/// Lowercase word core: token stripped of surrounding punctuation.
fn core(tok: &str) -> String {
    tok.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()
}

/// True when the token ends in clause punctuation — a comma there is either
/// present already or grammatically impossible.
fn ends_punctuated(tok: &str) -> bool {
    tok.ends_with([',', ';', ':', '.', '!', '?', '(', '—', '–'])
}

/// True when `tok` starts with a lowercase letter (triggers must — a
/// capitalized "Dass"/"Wenn" is a sentence start, never a comma site).
fn starts_lowercase(tok: &str) -> bool {
    tok.chars().next().is_some_and(|c| c.is_lowercase())
}

fn is_infinitive_after_zu(tok: &str) -> bool {
    let c = core(tok);
    if c.is_empty() || !starts_lowercase(tok) || ZU_NON_INFINITIVE.contains(&c.as_str()) {
        return false;
    }
    c == "tun" || c == "sein" || c.ends_with("en") || c.ends_with("ern") || c.ends_with("eln")
}

/// May a comma be appended to `toks[idx]` to separate it from what follows?
fn can_take_comma(toks: &[String], idx: usize) -> bool {
    let prev = &toks[idx];
    if ends_punctuated(prev) || prev.ends_with('„') || prev.ends_with('(') {
        return false;
    }
    !BLOCKERS.contains(&core(prev).as_str())
}

/// "um <…> zu <Infinitiv>" within the lookahead window?
fn um_zu_group(toks: &[String], um_idx: usize) -> bool {
    let end = (um_idx + 1 + UM_ZU_LOOKAHEAD).min(toks.len());
    for j in (um_idx + 1)..end {
        if core(&toks[j]) == "zu" && !ends_punctuated(&toks[j]) {
            if let Some(next) = toks.get(j + 1) {
                if is_infinitive_after_zu(next) {
                    return true;
                }
            }
        }
        // A clause boundary before the "zu" kills the group.
        if ends_punctuated(&toks[j]) {
            return false;
        }
    }
    false
}

/// Insert high-confidence German commas (and das→dass repairs). Pure and
/// idempotent; safe on non-German text (triggers are German function words).
pub fn insert_commas(text: &str) -> String {
    if text.trim().is_empty() {
        return text.to_string();
    }
    text.split('\n')
        .map(process_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn process_line(line: &str) -> String {
    if line.trim().is_empty() {
        return line.to_string();
    }
    let mut toks: Vec<String> = line.split_whitespace().map(str::to_string).collect();

    let mut i = 1;
    while i < toks.len() {
        let tok_core = core(&toks[i]);
        let lowercase_trigger = starts_lowercase(&toks[i]);

        // ── das → dass after say-verbs / "ohne", confirmed by a lowercase
        // subject right after. Runs before the subjunction rule so the fixed
        // "dass" would not be double-processed (we insert the comma here).
        if lowercase_trigger && tok_core == "das" {
            let prev_core = core(&toks[i - 1]);
            let followed_by_subject = toks
                .get(i + 1)
                .is_some_and(|n| starts_lowercase(n) && SUBJECT_STARTERS.contains(&core(n).as_str()));
            if followed_by_subject && (SAY_VERBS.contains(&prev_core.as_str()) || prev_core == "ohne")
            {
                // Repair the word even when the comma is already there
                // ("gesagt, das er…"); sentence-final "gesagt." blocks it.
                if !toks[i - 1].ends_with(['.', '!', '?', ';', ':']) {
                    toks[i] = toks[i].replacen("das", "dass", 1);
                    let target = if prev_core == "ohne" { i - 1 } else { i };
                    if target > 0 && can_take_comma(&toks, target - 1) {
                        toks[target - 1].push(',');
                    }
                    i += 1;
                    continue;
                }
            }
        }

        if !lowercase_trigger {
            i += 1;
            continue;
        }

        // ── comma before "sondern"
        if tok_core == "sondern" {
            if can_take_comma(&toks, i - 1) {
                toks[i - 1].push(',');
            }
            i += 1;
            continue;
        }

        // ── comma before "um … zu <Infinitiv>"
        if tok_core == "um" && um_zu_group(&toks, i) {
            if can_take_comma(&toks, i - 1) {
                toks[i - 1].push(',');
            }
            i += 1;
            continue;
        }

        // ── guarded conjunctions
        let is_trigger = if SUBJUNCTIONS.contains(&tok_core.as_str()) {
            true
        } else if tok_core == "während" {
            // prepositional "während des Meetings" → no comma
            !toks
                .get(i + 1)
                .is_some_and(|n| GENITIVE_DATIVE_AFTER_WAEHREND.contains(&core(n).as_str()))
        } else if tok_core == "damit" {
            // conjunction only when a subject follows ("damit wir …");
            // pronoun-adverb "wir sind damit fertig" stays untouched
            toks.get(i + 1)
                .is_some_and(|n| starts_lowercase(n) && SUBJECT_STARTERS.contains(&core(n).as_str()))
        } else {
            false
        };

        if is_trigger {
            // "auch/erst/nur/… wenn" → the comma belongs before the modifier.
            let target = if i >= 2 && MODIFIERS.contains(&core(&toks[i - 1]).as_str()) {
                i - 1
            } else {
                i
            };
            if target > 0 && can_take_comma(&toks, target - 1) {
                toks[target - 1].push(',');
            }
        }
        i += 1;
    }
    toks.join(" ")
}

#[cfg(test)]
mod tests {
    use super::insert_commas;

    #[test]
    fn subjunction_commas() {
        assert_eq!(
            insert_commas("das funktioniert nicht weil der server down ist"),
            "das funktioniert nicht, weil der server down ist"
        );
        assert_eq!(insert_commas("er sagt dass es geht"), "er sagt, dass es geht");
        assert_eq!(
            insert_commas("wir wissen nicht ob das klappt"),
            "wir wissen nicht, ob das klappt"
        );
        assert_eq!(
            insert_commas("die app stürzt ab wenn man das meeting startet"),
            "die app stürzt ab, wenn man das meeting startet"
        );
    }

    #[test]
    fn sentence_start_and_coordination_stay() {
        // Capitalized trigger = sentence start; "und dass" never takes the comma.
        assert_eq!(insert_commas("Wenn es regnet bleiben wir"), "Wenn es regnet bleiben wir");
        assert_eq!(
            insert_commas("er weiß dass wir kommen und dass wir bleiben"),
            "er weiß, dass wir kommen und dass wir bleiben"
        );
        assert_eq!(insert_commas("es klingt wie wenn es regnet"), "es klingt wie wenn es regnet");
        assert_eq!(insert_commas("es sieht aus als ob es geht"), "es sieht aus als ob es geht");
    }

    #[test]
    fn modifier_pulls_comma() {
        assert_eq!(
            insert_commas("wir gehen raus auch wenn es regnet"),
            "wir gehen raus, auch wenn es regnet"
        );
        assert_eq!(
            insert_commas("das gilt egal ob es passt"),
            "das gilt, egal ob es passt"
        );
    }

    #[test]
    fn um_zu_infinitive() {
        assert_eq!(
            insert_commas("wir treffen uns um das projekt zu besprechen"),
            "wir treffen uns, um das projekt zu besprechen"
        );
        // plain time/preposition "um" stays
        assert_eq!(insert_commas("wir treffen uns um drei uhr"), "wir treffen uns um drei uhr");
        assert_eq!(
            insert_commas("ich gehe um drei uhr zu einem termin"),
            "ich gehe um drei uhr zu einem termin"
        );
    }

    #[test]
    fn sondern() {
        assert_eq!(insert_commas("nicht heute sondern morgen"), "nicht heute, sondern morgen");
    }

    #[test]
    fn das_becomes_dass_after_say_verbs() {
        assert_eq!(
            insert_commas("er hat gesagt das er das angebot braucht"),
            "er hat gesagt, dass er das angebot braucht"
        );
        // already-present comma: word still repaired, no double comma
        assert_eq!(
            insert_commas("er hat gesagt, das er kommt"),
            "er hat gesagt, dass er kommt"
        );
        // capitalized noun after "das" = article, hands off
        assert_eq!(
            insert_commas("er hat gesagt das Buch ist gut"),
            "er hat gesagt das Buch ist gut"
        );
        assert_eq!(
            insert_commas("das geht nicht ohne das ein mikrofon angeschlossen ist"),
            "das geht nicht, ohne dass ein mikrofon angeschlossen ist"
        );
    }

    #[test]
    fn waehrend_and_damit_guards() {
        assert_eq!(insert_commas("das kam während des meetings"), "das kam während des meetings");
        assert_eq!(
            insert_commas("er schlief während wir arbeiteten"),
            "er schlief, während wir arbeiteten"
        );
        assert_eq!(insert_commas("wir sind damit fertig"), "wir sind damit fertig");
        assert_eq!(
            insert_commas("wir sparen damit wir reisen können"),
            "wir sparen, damit wir reisen können"
        );
    }

    #[test]
    fn idempotent_and_clean_text_untouched() {
        let clean = "Ich denke, dass es geht, weil wir vorbereitet sind.";
        assert_eq!(insert_commas(clean), clean);
        let once = insert_commas("das geht nicht weil es regnet");
        assert_eq!(insert_commas(&once), once);
    }

    #[test]
    fn non_german_text_untouched() {
        let en = "I think we should meet before we start building";
        assert_eq!(insert_commas(en), en);
    }

    #[test]
    fn eval_samples_end_to_end() {
        assert_eq!(
            insert_commas("der kunde hat gesagt das er das angebot bis freitag braucht"),
            "der kunde hat gesagt, dass er das angebot bis freitag braucht"
        );
        assert_eq!(
            insert_commas("ich denke wir sollten uns treffen um das projekt zu besprechen bevor wir anfangen"),
            "ich denke wir sollten uns treffen, um das projekt zu besprechen, bevor wir anfangen"
        );
    }
}
