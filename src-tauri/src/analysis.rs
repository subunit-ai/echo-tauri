//! Local text analysis for the Activity + Learning tabs.
//!
//! 100% on-device, zero network: tokenizer, DE/EN stop-word filtering, word
//! frequency, and a lexical-quality pass (type/token ratio, sentence length,
//! filler & discourse words, over-used content words, weak-word detection) plus
//! a curated German UPGRADE_MAP (weak word → richer alternatives with a short
//! why/when note) that powers the Learning coach's default suggestions, and the
//! curated WORD_OF_DAY list (deterministic per-day pick). The optional
//! `/v1/word-upgrade` LLM enrichment lives in `commands.rs` and only ever
//! *augments* this — the analysis here never touches the network, so the coach
//! can't hang on it.

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
    "mir", "mein", "meine", "meiner", "meinem", "meinen", "meines", "wir", "uns", "unser",
    "unsere", "unserer", "unserem", "unseren", "unseres", "ihr", "euch", "euer", "eure", "eurer",
    "du", "dich", "dir", "dein", "deine", "deiner", "deinem", "deinen", "deines", "sie", "ihn",
    "ihm", "ihnen", "ihre", "ihrer", "ihrem", "ihren", "ihres", "sein", "seine", "seiner", "seinem",
    "seinen", "seines", "man", "wer", "wen", "wem", "wessen", "was", "wo", "wie", "warum", "wann",
    "wieso", "weshalb", "und", "oder", "aber", "denn", "sondern", "doch", "weil", "dass", "ob",
    "wenn", "als", "damit", "sodass", "obwohl", "während", "bevor", "nachdem", "sowie", "sowohl",
    "beziehungsweise", "bzw", "aus", "bei", "mit", "nach", "seit", "von", "vom", "zu", "zur", "zum",
    "über", "unter", "vor", "hinter", "neben", "zwischen", "durch", "für", "gegen", "ohne", "um",
    "an", "am", "auf", "in", "im", "ins", "bis", "ab", "per", "pro", "gegenüber", "trotz", "wegen",
    "ist", "sind", "war", "waren", "bin", "bist", "hat", "haben", "habe", "hast", "hatte",
    "hatten", "wird", "werden", "wurde", "wurden", "worden", "geworden", "gewesen", "kann", "können",
    "konnte", "könnte", "muss", "müssen", "musste", "soll", "sollen", "sollte", "will", "wollen",
    "wollte", "darf", "dürfen", "mag", "mögen", "würde", "würden", "nicht", "nur", "auch", "noch",
    "schon", "mehr", "hier", "dort", "dann", "jetzt", "immer", "nie", "mal", "wieder", "etwa",
    "fast", "ganz", "eben", "so", "zwar", "ja", "nein", "nun", "hin", "her", "weg", "dabei", "dazu",
    "daran", "darauf", "darüber", "gibt", "geht",
    // discourse fillers (also counted separately by the filler pass)
    "halt", "quasi", "sozusagen", "eigentlich", "genau", "irgendwie", "also",
];

/// English function words (fallback locale is EN; many users dictate mixed
/// DE/EN) + EN discourse fillers.
const STOPWORDS_EN: &[&str] = &[
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "her", "was", "one",
    "our", "out", "day", "get", "has", "him", "his", "how", "its", "may", "new", "now", "old",
    "see", "two", "way", "who", "boy", "did", "she", "use", "than", "that", "this", "with",
    "have", "from", "they", "will", "would", "there", "their", "what", "about", "which", "when",
    "make", "like", "time", "just", "know", "take", "into", "your", "some", "them", "then",
    "were", "been", "being", "does", "doing", "done", "such", "very", "much", "more", "most",
    "many", "each", "every", "both", "either", "neither", "only", "also", "over", "under", "after",
    "before", "between", "through", "during", "again", "here", "because", "while", "where", "why",
    "shall", "should", "could", "might", "must", "cannot", "onto", "upon", "off", "down",
    "yes", "nor", "yet", "per", "via", "etc", "let", "got",
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
    if w.chars().count() < 2 {
        return None;
    }
    // Pure hum cluster: only h/m, needs BOTH (excludes "mm"=millimetre, "hh").
    // Covers "hm", "hmm", "mhm", "mmh" …
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

/// One curated alternative: the richer word + an optional ONE-sentence note on
/// why/when it is stronger (curated for the most important entries).
type Alt = (&'static str, Option<&'static str>);

/// weak German word → richer alternatives (curated, §12c shape with notes).
/// This is the DEFAULT source for the Learning coach; the LLM hook in
/// commands.rs only ever augments it.
static UPGRADE_MAP: &[(&'static str, &[Alt])] = &[
    ("gut", &[
        ("hervorragend", Some("Hebt echte Spitzenqualität hervor, wo „gut“ nur abnickt.")),
        ("ausgezeichnet", None),
        ("solide", Some("Ehrlich für „ordentlich, ohne Glanz“ — präziser als ein pauschales „gut“.")),
    ]),
    ("schön", &[
        ("ansprechend", Some("Beschreibt die Wirkung auf den Betrachter — konkreter als „schön“.")),
        ("elegant", None),
        ("gelungen", Some("Lobt das Ergebnis einer Arbeit, nicht nur die Optik.")),
    ]),
    ("machen", &[
        ("umsetzen", Some("Betont, dass ein Plan tatsächlich in die Tat kommt.")),
        ("realisieren", None),
        ("gestalten", Some("Passt, wenn kreativer Spielraum im Spiel ist.")),
    ]),
    ("sache", &[
        ("Angelegenheit", Some("Wirkt im formellen Kontext deutlich professioneller.")),
        ("Aspekt", Some("Präzise, wenn ein Teilgesichtspunkt gemeint ist.")),
        ("Thema", None),
    ]),
    ("sagen", &[
        ("erläutern", Some("Kündigt eine echte Erklärung an, nicht bloß eine Äußerung.")),
        ("darlegen", None),
        ("betonen", Some("Stark, wenn etwas ausdrücklich hervorgehoben werden soll.")),
    ]),
    ("wichtig", &[
        ("entscheidend", Some("Signalisiert: Hiervon hängt das Ergebnis ab.")),
        ("maßgeblich", None),
        ("zentral", None),
    ]),
    ("groß", &[
        ("umfangreich", Some("Präzise für Menge und Umfang statt räumlicher Größe.")),
        ("beträchtlich", None),
        ("erheblich", None),
    ]),
    ("schlecht", &[
        ("mangelhaft", Some("Benennt einen objektiven Qualitätsmangel statt eines Pauschalurteils.")),
        ("unzureichend", Some("Sagt konkret: Es genügt den Anforderungen nicht.")),
        ("fehlerhaft", None),
    ]),
    ("viel", &[
        ("zahlreich", None),
        ("erheblich", None),
        ("umfangreich", None),
    ]),
    ("toll", &[
        ("großartig", None),
        ("herausragend", Some("Hebt etwas messbar über den Durchschnitt.")),
        ("beeindruckend", None),
    ]),
    ("ding", &[
        ("Element", None),
        ("Gegenstand", None),
        ("Aspekt", None),
    ]),
    ("dinge", &[
        ("Elemente", None),
        ("Aspekte", None),
        ("Faktoren", Some("Stark in Analysen: „Faktoren“ klingt nach System statt Beliebigkeit.")),
    ]),
    ("tun", &[
        ("handeln", None),
        ("unternehmen", Some("Impliziert Initiative: Es wird aktiv etwas angestoßen.")),
        ("bewirken", None),
    ]),
    ("schnell", &[
        ("zügig", Some("Klingt nach Tempo mit Sorgfalt — ideal für Zusagen.")),
        ("rasch", None),
        ("umgehend", Some("Die verbindlichste Form: sofort und ohne Verzögerung.")),
    ]),
    ("langsam", &[
        ("gemächlich", None),
        ("schleppend", Some("Wertend: macht stockenden Fortschritt explizit.")),
        ("träge", None),
    ]),
    ("wenig", &[
        ("gering", None),
        ("begrenzt", None),
        ("überschaubar", Some("Diplomatisch, wenn „wenig“ zu negativ klingen würde.")),
    ]),
    ("neu", &[
        ("innovativ", Some("Nur verwenden, wenn wirklich etwas Neuartiges dahintersteht.")),
        ("aktuell", None),
        ("neuartig", None),
    ]),
    ("alt", &[
        ("bewährt", Some("Dreht die Perspektive: Alter als Qualitätsbeweis.")),
        ("etabliert", None),
        ("langjährig", None),
    ]),
    ("einfach", &[
        ("unkompliziert", None),
        ("mühelos", None),
        ("verständlich", Some("Präzise, wenn „einfach zu begreifen“ gemeint ist.")),
    ]),
    ("schwierig", &[
        ("anspruchsvoll", Some("Positiv gewendet: fordernd statt abschreckend.")),
        ("komplex", Some("Sachlich für vielschichtige Probleme.")),
        ("herausfordernd", None),
    ]),
    ("problem", &[
        ("Herausforderung", Some("Lösungsorientierter Rahmen — besonders in Kundenkommunikation.")),
        ("Hürde", None),
        ("Schwachstelle", Some("Präzise, wenn eine konkrete Stelle im System gemeint ist.")),
    ]),
    ("interessant", &[
        ("aufschlussreich", Some("Sagt, was der Mehrwert ist: eine neue Erkenntnis.")),
        ("bemerkenswert", None),
        ("vielversprechend", Some("Passend für Dinge mit Zukunftspotenzial.")),
    ]),
    ("denken", &[
        ("erwägen", Some("Zeigt strukturiertes Abwägen statt vagem Nachdenken.")),
        ("annehmen", None),
        ("einschätzen", None),
    ]),
    ("finden", &[
        ("erachten", Some("Formeller Ausdruck für ein begründetes Urteil.")),
        ("beurteilen", None),
        ("empfinden", None),
    ]),
    ("zeigen", &[
        ("verdeutlichen", None),
        ("aufzeigen", None),
        ("belegen", Some("Am stärksten: mit Beweis statt bloßer Behauptung.")),
    ]),
    ("bekommen", &[
        ("erhalten", Some("Der neutrale Standard im Geschäftsdeutsch.")),
        ("erzielen", Some("Für Ergebnisse, die man sich aktiv erarbeitet hat.")),
        ("erlangen", None),
    ]),
    ("geben", &[
        ("bereitstellen", Some("Aktiv und serviceorientiert.")),
        ("liefern", None),
        ("gewähren", None),
    ]),
    ("nehmen", &[
        ("wählen", None),
        ("übernehmen", None),
        ("heranziehen", Some("Präzise für Quellen, Daten und Belege.")),
    ]),
    ("gehen", &[
        ("funktionieren", None),
        ("verlaufen", None),
        ("voranschreiten", None),
    ]),
    ("kommen", &[
        ("resultieren", Some("Macht die Ursache-Wirkung-Beziehung explizit.")),
        ("eintreffen", None),
        ("gelangen", None),
    ]),
    ("bringen", &[
        ("liefern", None),
        ("herbeiführen", Some("Betont die aktive Verursachung eines Ergebnisses.")),
        ("einbringen", None),
    ]),
    ("stellen", &[
        ("bereitstellen", None),
        ("positionieren", None),
        ("platzieren", None),
    ]),
    ("nutzen", &[
        ("einsetzen", Some("Impliziert gezielten, geplanten Gebrauch.")),
        ("verwenden", None),
        ("heranziehen", None),
    ]),
    ("brauchen", &[
        ("benötigen", Some("Die formellere Standardform.")),
        ("erfordern", Some("Wenn die Sache selbst es verlangt, nicht die Person.")),
        ("voraussetzen", None),
    ]),
    ("helfen", &[
        ("unterstützen", Some("Professioneller und breiter als „helfen“.")),
        ("fördern", None),
        ("entlasten", Some("Konkret: nimmt jemandem spürbar Last ab.")),
    ]),
    ("verbessern", &[
        ("optimieren", Some("Systematisch zum Bestmöglichen hin — stärker als bloßes Verbessern.")),
        ("steigern", None),
        ("verfeinern", None),
    ]),
    ("ändern", &[
        ("anpassen", Some("Zielgerichtet: eine Änderung mit klarem Bezugspunkt.")),
        ("überarbeiten", None),
        ("modifizieren", None),
    ]),
    ("erklären", &[
        ("erläutern", None),
        ("darlegen", None),
        ("veranschaulichen", Some("Am stärksten mit Beispielen und Bildern.")),
    ]),
    ("wirklich", &[
        ("tatsächlich", Some("Sachlicher; „wirklich“ wirkt schnell umgangssprachlich.")),
        ("nachweislich", Some("Nur mit Beleg verwenden — dann aber sehr überzeugend.")),
        ("ausgesprochen", None),
    ]),
    ("richtig", &[
        ("korrekt", None),
        ("zutreffend", None),
        ("angemessen", None),
    ]),
    ("klar", &[
        ("eindeutig", Some("Lässt keinerlei Interpretationsspielraum.")),
        ("unmissverständlich", None),
        ("nachvollziehbar", None),
    ]),
    ("nett", &[
        ("zuvorkommend", Some("Beschreibt aktives Entgegenkommen statt blasser Freundlichkeit.")),
        ("freundlich", None),
        ("angenehm", None),
    ]),
    ("super", &[
        ("hervorragend", None),
        ("erstklassig", None),
        ("ausgezeichnet", None),
    ]),
    ("cool", &[
        ("überzeugend", Some("Im Berufskontext die seriöse Entsprechung.")),
        ("beeindruckend", None),
        ("gelungen", None),
    ]),
    ("spannend", &[
        ("fesselnd", None),
        ("vielversprechend", None),
        ("reizvoll", None),
    ]),
    ("leicht", &[
        ("mühelos", None),
        ("unkompliziert", None),
        ("spielend", None),
    ]),
    ("teuer", &[
        ("kostspielig", Some("Neutral-formell für hohe Kosten.")),
        ("hochpreisig", Some("Wertfrei: beschreibt das Preissegment statt zu urteilen.")),
        ("kostenintensiv", None),
    ]),
    ("billig", &[
        ("preiswert", Some("Positiv: guter Wert fürs Geld — „billig“ klingt nach Ramsch.")),
        ("günstig", None),
        ("erschwinglich", None),
    ]),
];

// ── Word of the day (curated, deterministic) ─────────────────────────────────

/// One curated „Wort des Tages“ — real, usable German Bildungssprache with a
/// precise plain-language meaning + a natural business/everyday example. No
/// stilted archaisms.
pub struct WodEntry {
    pub word: &'static str,
    pub meaning: &'static str,
    pub example: &'static str,
    pub synonyms: &'static [&'static str],
}

pub const WORD_OF_DAY: &[WodEntry] = &[
    WodEntry { word: "akribisch", meaning: "Äußerst sorgfältig und genau bis ins kleinste Detail.", example: "Sie hat den Vertrag akribisch geprüft, bevor sie unterschrieben hat.", synonyms: &["gewissenhaft", "penibel", "gründlich"] },
    WodEntry { word: "stringent", meaning: "Logisch zwingend und in sich schlüssig aufgebaut.", example: "Seine Argumentation war so stringent, dass niemand widersprach.", synonyms: &["schlüssig", "folgerichtig", "konsequent"] },
    WodEntry { word: "Prämisse", meaning: "Die Voraussetzung oder Annahme, von der eine Überlegung ausgeht.", example: "Die Kalkulation beruht auf der Prämisse, dass die Nachfrage stabil bleibt.", synonyms: &["Annahme", "Voraussetzung", "Grundlage"] },
    WodEntry { word: "Diskrepanz", meaning: "Eine auffällige Abweichung zwischen Dingen, die eigentlich zusammenpassen sollten.", example: "Zwischen Plan und tatsächlichen Kosten klafft eine deutliche Diskrepanz.", synonyms: &["Abweichung", "Unstimmigkeit", "Missverhältnis"] },
    WodEntry { word: "eruieren", meaning: "Etwas durch gründliches Nachforschen herausfinden.", example: "Wir müssen erst eruieren, woran der Ausfall tatsächlich lag.", synonyms: &["ermitteln", "herausfinden", "untersuchen"] },
    WodEntry { word: "konzise", meaning: "Knapp und dabei präzise formuliert — kein Wort zu viel.", example: "Bitte fassen Sie die Ergebnisse konzise auf einer Seite zusammen.", synonyms: &["prägnant", "knapp", "präzise"] },
    WodEntry { word: "substanziell", meaning: "Wesentlich und von echtem Gewicht, nicht nur oberflächlich.", example: "Der neue Partner leistet einen substanziellen Beitrag zum Umsatz.", synonyms: &["wesentlich", "erheblich", "bedeutend"] },
    WodEntry { word: "elaboriert", meaning: "Sorgfältig ausgearbeitet und gedanklich differenziert.", example: "Das Konzept ist deutlich elaborierter als der erste Entwurf.", synonyms: &["ausgefeilt", "durchdacht", "differenziert"] },
    WodEntry { word: "implizieren", meaning: "Etwas unausgesprochen mitmeinen oder als Folge nahelegen.", example: "Ihre Antwort impliziert, dass der Termin nicht zu halten ist.", synonyms: &["nahelegen", "mitmeinen", "bedeuten"] },
    WodEntry { word: "Paradigma", meaning: "Ein grundlegendes Denkmuster oder Leitbild, an dem sich vieles ausrichtet.", example: "Remote-Arbeit hat das Paradigma der Präsenzkultur abgelöst.", synonyms: &["Denkmuster", "Leitbild", "Modell"] },
    WodEntry { word: "Synergie", meaning: "Ein Zusammenwirken, das mehr ergibt als die Summe der Einzelteile.", example: "Die Fusion soll Synergien zwischen Vertrieb und Support heben.", synonyms: &["Zusammenspiel", "Wechselwirkung", "Verbundeffekt"] },
    WodEntry { word: "Ambivalenz", meaning: "Das gleichzeitige Empfinden widersprüchlicher Bewertungen gegenüber derselben Sache.", example: "Er betrachtete das Übernahmeangebot mit einer gewissen Ambivalenz.", synonyms: &["Zwiespältigkeit", "Zerrissenheit", "Widersprüchlichkeit"] },
    WodEntry { word: "kohärent", meaning: "In sich zusammenhängend und stimmig.", example: "Der Bericht wirkt kohärent, weil jedes Kapitel auf dem vorigen aufbaut.", synonyms: &["stimmig", "zusammenhängend", "schlüssig"] },
    WodEntry { word: "prägnant", meaning: "Treffend und auf den Punkt gebracht.", example: "Ein prägnanter Betreff erhöht die Öffnungsrate deutlich.", synonyms: &["treffend", "pointiert", "markant"] },
    WodEntry { word: "dezidiert", meaning: "Ausdrücklich und mit Nachdruck vertreten.", example: "Sie vertrat dezidiert die Ansicht, dass der Launch verschoben werden muss.", synonyms: &["entschieden", "ausdrücklich", "nachdrücklich"] },
    WodEntry { word: "fundiert", meaning: "Auf solidem Wissen oder belastbaren Belegen beruhend.", example: "Wir brauchen eine fundierte Analyse statt eines Bauchgefühls.", synonyms: &["belegt", "gesichert", "wohlbegründet"] },
    WodEntry { word: "Konsens", meaning: "Die Übereinstimmung aller Beteiligten in einer Frage.", example: "Nach zwei Stunden Diskussion war der Konsens gefunden.", synonyms: &["Übereinstimmung", "Einigkeit", "Einvernehmen"] },
    WodEntry { word: "divergieren", meaning: "Auseinandergehen, sich voneinander entfernen.", example: "Die Einschätzungen der beiden Teams divergieren erheblich.", synonyms: &["abweichen", "auseinandergehen", "differieren"] },
    WodEntry { word: "plausibel", meaning: "Nachvollziehbar und glaubwürdig erscheinend.", example: "Die Erklärung klingt plausibel, sollte aber geprüft werden.", synonyms: &["nachvollziehbar", "einleuchtend", "glaubhaft"] },
    WodEntry { word: "differenziert", meaning: "Fein unterscheidend statt pauschal urteilend.", example: "Er bewertet die Lage differenziert, statt alles über einen Kamm zu scheren.", synonyms: &["nuanciert", "abgestuft", "vielschichtig"] },
    WodEntry { word: "pragmatisch", meaning: "An der praktischen Umsetzbarkeit orientiert statt an der reinen Lehre.", example: "Wir entschieden pragmatisch: erst die schnelle Lösung, dann die schöne.", synonyms: &["praxisnah", "sachbezogen", "lösungsorientiert"] },
    WodEntry { word: "Expertise", meaning: "Ausgewiesenes Fachwissen auf einem Gebiet.", example: "Für die Migration holen wir uns externe Expertise ins Haus.", synonyms: &["Fachwissen", "Sachverstand", "Know-how"] },
    WodEntry { word: "valide", meaning: "Gültig und belastbar — hält einer Prüfung stand.", example: "Die Daten sind valide genug für eine Entscheidung.", synonyms: &["belastbar", "gültig", "stichhaltig"] },
    WodEntry { word: "Hypothese", meaning: "Eine begründete, aber noch unbewiesene Annahme.", example: "Unsere Hypothese: Der Umsatzrückgang liegt an der Preiserhöhung.", synonyms: &["Annahme", "Vermutung", "These"] },
    WodEntry { word: "Implikation", meaning: "Eine mitgedachte Folge einer Aussage oder Entscheidung.", example: "Die rechtlichen Implikationen des Deals sind noch ungeklärt.", synonyms: &["Folge", "Konsequenz", "Tragweite"] },
    WodEntry { word: "adäquat", meaning: "Der Situation angemessen und passend.", example: "Auf die Beschwerde haben wir adäquat reagiert.", synonyms: &["angemessen", "passend", "entsprechend"] },
    WodEntry { word: "obsolet", meaning: "Überholt und nicht mehr gebraucht.", example: "Mit dem neuen Tool wird der alte Prozess obsolet.", synonyms: &["überholt", "veraltet", "hinfällig"] },
    WodEntry { word: "Redundanz", meaning: "Eine überflüssige Doppelung; in der Technik auch bewusste Absicherung.", example: "Wir haben die Redundanzen im Bericht gestrichen.", synonyms: &["Doppelung", "Überfluss", "Wiederholung"] },
    WodEntry { word: "komplementär", meaning: "Sich gegenseitig ergänzend.", example: "Die beiden Produkte sind komplementär und verkaufen sich gemeinsam besser.", synonyms: &["ergänzend", "zusammenpassend", "wechselseitig"] },
    WodEntry { word: "Affinität", meaning: "Eine natürliche Neigung oder Anziehung zu etwas.", example: "Sie hat eine hohe Affinität zu Zahlen und Datenanalysen.", synonyms: &["Neigung", "Hang", "Vorliebe"] },
    WodEntry { word: "akkumulieren", meaning: "Nach und nach ansammeln.", example: "Über die Jahre hat sich technischer Ballast im System akkumuliert.", synonyms: &["ansammeln", "anhäufen", "aufbauen"] },
    WodEntry { word: "antizipieren", meaning: "Etwas vorausahnen und gedanklich vorwegnehmen.", example: "Gute Planung heißt, Engpässe zu antizipieren, bevor sie entstehen.", synonyms: &["vorwegnehmen", "vorhersehen", "erwarten"] },
    WodEntry { word: "dediziert", meaning: "Eigens für einen bestimmten Zweck vorgesehen.", example: "Für das Projekt stellen wir ein dediziertes Team ab.", synonyms: &["eigens", "speziell", "zweckgebunden"] },
    WodEntry { word: "explizit", meaning: "Ausdrücklich und unmissverständlich ausgesprochen.", example: "Der Kunde hat explizit um eine schriftliche Bestätigung gebeten.", synonyms: &["ausdrücklich", "klar", "unmissverständlich"] },
    WodEntry { word: "genuin", meaning: "Echt und ursprünglich, nicht aufgesetzt.", example: "Sein Interesse an dem Thema ist genuin, nicht taktisch.", synonyms: &["echt", "ursprünglich", "authentisch"] },
    WodEntry { word: "gravierend", meaning: "Schwerwiegend und mit spürbaren Folgen.", example: "Der Fehler hatte gravierende Folgen für den Zeitplan.", synonyms: &["schwerwiegend", "einschneidend", "erheblich"] },
    WodEntry { word: "Indiz", meaning: "Ein Hinweis, der auf etwas schließen lässt, ohne es zu beweisen.", example: "Die sinkende Öffnungsrate ist ein Indiz für Ermüdung der Zielgruppe.", synonyms: &["Hinweis", "Anzeichen", "Anhaltspunkt"] },
    WodEntry { word: "inhärent", meaning: "Einer Sache von Natur aus innewohnend.", example: "Jedem neuen Markt ist ein gewisses Risiko inhärent.", synonyms: &["innewohnend", "eigen", "immanent"] },
    WodEntry { word: "Iteration", meaning: "Ein Wiederholungsschritt, mit dem etwas schrittweise verbessert wird.", example: "Nach drei Iterationen stand das finale Design.", synonyms: &["Durchlauf", "Schleife", "Überarbeitungsrunde"] },
    WodEntry { word: "Kalkül", meaning: "Eine nüchterne, berechnende Überlegung hinter einer Entscheidung.", example: "Die Preissenkung war strategisches Kalkül, kein Zufall.", synonyms: &["Berechnung", "Strategie", "Überlegung"] },
    WodEntry { word: "kategorisch", meaning: "Ohne jede Einschränkung, unbedingt.", example: "Er lehnte den Vorschlag kategorisch ab.", synonyms: &["strikt", "ausnahmslos", "kompromisslos"] },
    WodEntry { word: "Konnotation", meaning: "Die mitschwingende Nebenbedeutung eines Wortes.", example: "Das Wort „billig“ hat eine negative Konnotation — „günstig“ nicht.", synonyms: &["Nebenbedeutung", "Beiklang", "Unterton"] },
    WodEntry { word: "konsolidieren", meaning: "Festigen und zu einer stabilen Einheit zusammenführen.", example: "Wir konsolidieren die drei Tools zu einer Plattform.", synonyms: &["festigen", "bündeln", "zusammenführen"] },
    WodEntry { word: "Kontinuität", meaning: "Ein ununterbrochener, stetiger Fortgang ohne Brüche.", example: "Die neue Führung steht für Kontinuität statt Kurswechsel.", synonyms: &["Stetigkeit", "Beständigkeit", "Fortdauer"] },
    WodEntry { word: "lukrativ", meaning: "Finanziell einträglich und lohnend.", example: "Das Wartungsgeschäft ist lukrativer als der Erstverkauf.", synonyms: &["einträglich", "gewinnbringend", "rentabel"] },
    WodEntry { word: "marginal", meaning: "Nur am Rande liegend, geringfügig.", example: "Die Änderung hat nur marginale Auswirkungen auf die Ladezeit.", synonyms: &["geringfügig", "unwesentlich", "minimal"] },
    WodEntry { word: "obligatorisch", meaning: "Verpflichtend vorgeschrieben.", example: "Die Schulung ist für alle neuen Mitarbeiter obligatorisch.", synonyms: &["verpflichtend", "vorgeschrieben", "verbindlich"] },
    WodEntry { word: "opportun", meaning: "Im gegebenen Moment günstig oder angebracht.", example: "Eine Preiserhöhung scheint derzeit nicht opportun.", synonyms: &["angebracht", "günstig", "ratsam"] },
    WodEntry { word: "partizipieren", meaning: "An etwas teilhaben oder beteiligt sein.", example: "Alle Teams partizipieren am Erfolg des Launches.", synonyms: &["teilhaben", "mitwirken", "profitieren"] },
    WodEntry { word: "plakativ", meaning: "Bewusst vereinfacht und auffällig, um sofort verstanden zu werden.", example: "Das Beispiel ist plakativ, macht das Problem aber sofort greifbar.", synonyms: &["einprägsam", "überspitzt", "schlagwortartig"] },
    WodEntry { word: "postulieren", meaning: "Etwas als gegeben behaupten oder ausdrücklich fordern.", example: "Die Studie postuliert einen direkten Zusammenhang zwischen Preis und Loyalität.", synonyms: &["behaupten", "fordern", "aufstellen"] },
    WodEntry { word: "präferieren", meaning: "Etwas gegenüber anderem bevorzugen.", example: "Der Kunde präferiert die schlichte Variante.", synonyms: &["bevorzugen", "favorisieren", "vorziehen"] },
    WodEntry { word: "Präzedenzfall", meaning: "Ein früherer Fall, der als Maßstab für künftige Entscheidungen dient.", example: "Die Kulanzregelung schafft einen Präzedenzfall für ähnliche Beschwerden.", synonyms: &["Musterfall", "Beispielfall", "Vergleichsfall"] },
    WodEntry { word: "profund", meaning: "Tiefgehend und auf gründlichem Wissen beruhend.", example: "Sie verfügt über profunde Kenntnisse des deutschen Marktes.", synonyms: &["tiefgreifend", "gründlich", "umfassend"] },
    WodEntry { word: "Quintessenz", meaning: "Der wesentliche Kern einer Sache, auf den alles hinausläuft.", example: "Die Quintessenz des Workshops: weniger Meetings, klarere Ziele.", synonyms: &["Kernaussage", "Essenz", "Fazit"] },
    WodEntry { word: "renommiert", meaning: "Mit einem ausgezeichneten Ruf versehen.", example: "Wir arbeiten mit einem renommierten Forschungsinstitut zusammen.", synonyms: &["angesehen", "namhaft", "anerkannt"] },
    WodEntry { word: "resilient", meaning: "Widerstandsfähig gegenüber Krisen und Rückschlägen.", example: "Die Lieferkette ist nach dem Umbau deutlich resilienter.", synonyms: &["widerstandsfähig", "robust", "belastbar"] },
    WodEntry { word: "rigoros", meaning: "Streng und ohne Ausnahme durchgreifend.", example: "Ausgaben ohne Beleg werden rigoros abgelehnt.", synonyms: &["streng", "konsequent", "kompromisslos"] },
    WodEntry { word: "rudimentär", meaning: "Nur in Ansätzen vorhanden, unvollständig entwickelt.", example: "Seine Spanischkenntnisse sind rudimentär, reichen aber für den Small Talk.", synonyms: &["ansatzweise", "grundlegend", "unvollständig"] },
    WodEntry { word: "signifikant", meaning: "Deutlich und bedeutsam; statistisch: nicht durch Zufall erklärbar.", example: "Die Conversion-Rate stieg signifikant um zwölf Prozent.", synonyms: &["deutlich", "erheblich", "markant"] },
    WodEntry { word: "skizzieren", meaning: "Etwas in groben Zügen darstellen.", example: "Ich skizziere kurz den Fahrplan für das nächste Quartal.", synonyms: &["umreißen", "andeuten", "entwerfen"] },
    WodEntry { word: "sukzessive", meaning: "Nach und nach, in aufeinanderfolgenden Schritten.", example: "Wir stellen die Kunden sukzessive auf das neue System um.", synonyms: &["schrittweise", "allmählich", "nach und nach"] },
    WodEntry { word: "tangieren", meaning: "Etwas berühren oder betreffen, oft nur am Rande.", example: "Die Gesetzesänderung tangiert unser Geschäftsmodell nur am Rande.", synonyms: &["berühren", "betreffen", "beeinflussen"] },
    WodEntry { word: "versiert", meaning: "Durch Erfahrung sehr geschickt und bewandert.", example: "Sie ist im Umgang mit schwierigen Kunden äußerst versiert.", synonyms: &["erfahren", "routiniert", "bewandert"] },
    WodEntry { word: "volatil", meaning: "Stark und unvorhersehbar schwankend.", example: "Die Nachfrage ist saisonal sehr volatil.", synonyms: &["schwankend", "unbeständig", "sprunghaft"] },
    WodEntry { word: "retrospektiv", meaning: "Rückblickend, aus der Sicht des Nachhinein.", example: "Retrospektiv war die frühe Investition genau richtig.", synonyms: &["rückblickend", "im Nachhinein", "rückschauend"] },
    WodEntry { word: "forcieren", meaning: "Etwas mit Nachdruck vorantreiben.", example: "Der Vorstand will das Auslandsgeschäft forcieren.", synonyms: &["vorantreiben", "beschleunigen", "verstärken"] },
    WodEntry { word: "heterogen", meaning: "Aus Ungleichartigem zusammengesetzt.", example: "Die Zielgruppe ist heterogen — vom Studenten bis zum Konzern.", synonyms: &["uneinheitlich", "gemischt", "verschiedenartig"] },
    WodEntry { word: "evident", meaning: "Offenkundig und klar ersichtlich, ohne dass es eines Beweises bedarf.", example: "Der Nutzen der Automatisierung ist evident.", synonyms: &["offenkundig", "offensichtlich", "augenfällig"] },
    WodEntry { word: "souverän", meaning: "Überlegen sicher im Auftreten und Handeln.", example: "Sie hat die kritischen Fragen im Meeting souverän beantwortet.", synonyms: &["selbstsicher", "überlegen", "gelassen"] },
    WodEntry { word: "verifizieren", meaning: "Die Richtigkeit von etwas prüfen und bestätigen.", example: "Bitte verifizieren Sie die Zahlen, bevor der Bericht rausgeht.", synonyms: &["überprüfen", "bestätigen", "nachweisen"] },
    WodEntry { word: "priorisieren", meaning: "Nach Wichtigkeit ordnen und das Entscheidende zuerst angehen.", example: "Wir priorisieren die offenen Fehler nach Kundenwirkung.", synonyms: &["gewichten", "einstufen", "vorziehen"] },
    WodEntry { word: "granular", meaning: "Fein aufgegliedert, bis in kleine Einheiten aufgelöst.", example: "Wir erfassen die Nutzung granular auf Feature-Ebene.", synonyms: &["feingliedrig", "detailliert", "fein aufgelöst"] },
    WodEntry { word: "konkretisieren", meaning: "Etwas Vages genauer und greifbarer fassen.", example: "Bitte konkretisieren Sie den Vorschlag mit Zahlen und Terminen.", synonyms: &["präzisieren", "verdeutlichen", "ausformulieren"] },
];

/// djb2 hash (Dan Bernstein) — tiny, stable across builds and platforms, so
/// the date → word mapping is deterministic forever.
fn djb2(s: &str) -> u64 {
    s.bytes().fold(5381u64, |h, b| {
        h.wrapping_shl(5).wrapping_add(h).wrapping_add(b as u64)
    })
}

/// Deterministic word-of-the-day pick for `day` ('YYYY-MM-DD'): the date hash
/// selects a start index; from there the FIRST word (circular scan) the user
/// has NOT already used in `recent_words` (lowercase token set of the last 30
/// days) wins — the coach teaches something new. If every word occurs, the
/// hash index itself is returned, flagged already-used.
pub fn pick_word_of_day(day: &str, recent_words: &HashSet<String>) -> (&'static WodEntry, bool) {
    let n = WORD_OF_DAY.len();
    let start = (djb2(day) % n as u64) as usize;
    for i in 0..n {
        let e = &WORD_OF_DAY[(start + i) % n];
        if !recent_words.contains(&e.word.to_lowercase()) {
            return (e, false);
        }
    }
    (&WORD_OF_DAY[start], true)
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

// ── Upgrade suggestions (local default, §12c shape) ──────────────────────────

/// One richer alternative for a weak word, with an optional one-sentence note
/// on why/when it is stronger (§12c `WordAlternative`).
#[derive(serde::Serialize, Clone)]
pub struct WordAlternative {
    pub word: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct Suggestion {
    pub word: String,
    pub count: i64,
    pub alternatives: Vec<WordAlternative>,
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
/// in `texts`, with its count, alternatives (incl. curated notes) and an example
/// sentence. Descending by count, capped at 20. This is the coach's guaranteed
/// non-empty default — it never touches the network.
pub fn local_suggestions(texts: &[String]) -> Vec<Suggestion> {
    let mut all_counts: HashMap<String, i64> = HashMap::new();
    for t in texts {
        for w in tokenize(t) {
            *all_counts.entry(w).or_insert(0) += 1;
        }
    }
    let mut out: Vec<Suggestion> = Vec::new();
    for (key, alts) in UPGRADE_MAP {
        if let Some(c) = all_counts.get(*key) {
            if *c >= 1 {
                out.push(Suggestion {
                    word: (*key).to_string(),
                    count: *c,
                    alternatives: alts
                        .iter()
                        .map(|(w, note)| WordAlternative {
                            word: (*w).to_string(),
                            note: note.map(str::to_string),
                        })
                        .collect(),
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
        // mixed alphanumeric survives
        assert!(tokenize("GPT4 rocks").contains(&"gpt4".to_string()));
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
        assert_eq!(hesitation("hm"), Some("hmm"));
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
        // Upgrade coach must yield real suggestions for occurring weak words,
        // in the §12c shape (alternatives as {word, note?} objects).
        let sug = local_suggestions(&texts);
        let gut = sug.iter().find(|s| s.word == "gut").expect("'gut' suggested");
        assert!(!gut.alternatives.is_empty());
        assert!(gut.alternatives.iter().any(|a| a.note.is_some()));
        assert!(sug.iter().any(|s| s.word == "machen"));
    }

    #[test]
    fn curated_lists_meet_contract_sizes() {
        assert!(UPGRADE_MAP.len() >= 40, "UPGRADE_MAP needs ≥40 entries");
        assert!(WORD_OF_DAY.len() >= 60, "WORD_OF_DAY needs ≥60 entries");
        for e in WORD_OF_DAY {
            assert!(!e.word.is_empty() && !e.meaning.is_empty() && !e.example.is_empty());
            assert!(!e.synonyms.is_empty());
        }
    }

    #[test]
    fn word_of_day_is_deterministic_and_skips_used_words() {
        let empty = HashSet::new();
        // Same day → same word, always.
        let (a, used_a) = pick_word_of_day("2026-07-08", &empty);
        let (b, used_b) = pick_word_of_day("2026-07-08", &empty);
        assert_eq!(a.word, b.word);
        assert!(!used_a && !used_b);
        // A word the user already dictated is skipped (circular scan).
        let mut recent = HashSet::new();
        recent.insert(a.word.to_lowercase());
        let (c, used_c) = pick_word_of_day("2026-07-08", &recent);
        assert_ne!(c.word, a.word);
        assert!(!used_c);
        // All words used → the hash index itself, flagged already_used.
        let all: HashSet<String> = WORD_OF_DAY.iter().map(|e| e.word.to_lowercase()).collect();
        let (d, used_d) = pick_word_of_day("2026-07-08", &all);
        assert_eq!(d.word, a.word); // start index = the unfiltered pick
        assert!(used_d);
    }
}
