//! DACH formatting pack — full port of the Python `dach_format.py` "DE database".
//!
//! Fixes the mechanical things Whisper gets wrong in German, conservatively
//! (anything ambiguous is left alone):
//!   - Spoken German numbers before a currency word become digits + symbol:
//!     "zweihundert Euro" → "200 €", "drei tausend Euro" → "3000 €",
//!     "20 Euro" → "20 €", "50 Cent" → "50 ct". Running prose like
//!     "der Euro fällt" or a bare "tausend Euro" is left untouched.
//!   - Percent + common units, same conservative number rule:
//!     "fünfzig Prozent" → "50 %", "zehn Kilometer" → "10 km",
//!     "500 Gramm" → "500 g" (km/cm/mm/m/kg/g/l).
//!   - Abbreviation spacing: "z.B." → "z. B.".
//!   - Punctuation spacing: "Hallo  ,  Welt" → "Hallo, Welt".
//!   - German curly quotes: "Hallo" → „Hallo".

use once_cell::sync::Lazy;
use regex::{Captures, Regex};

/// Single German number word → value (cardinals used inside currency context).
fn num_word(w: &str) -> Option<i64> {
    Some(match w {
        "null" => 0,
        "eins" | "ein" | "eine" | "einen" => 1,
        "zwei" => 2,
        "drei" => 3,
        "vier" => 4,
        "fünf" => 5,
        "sechs" => 6,
        "sieben" => 7,
        "acht" => 8,
        "neun" => 9,
        "zehn" => 10,
        "elf" => 11,
        "zwölf" => 12,
        "dreizehn" => 13,
        "vierzehn" => 14,
        "fünfzehn" => 15,
        "sechzehn" => 16,
        "siebzehn" => 17,
        "achtzehn" => 18,
        "neunzehn" => 19,
        "zwanzig" => 20,
        "dreißig" => 30,
        "vierzig" => 40,
        "fünfzig" => 50,
        "sechzig" => 60,
        "siebzig" => 70,
        "achtzig" => 80,
        "neunzig" => 90,
        _ => return None,
    })
}

/// Parse a single compound German number word ("zweihundertfünfzig" → 250).
/// Returns None when unparseable — the caller then keeps the original text.
fn parse_german_compound(word: &str) -> Option<i64> {
    let lower = word.to_lowercase();
    let w = lower.trim();
    if w.is_empty() {
        return None;
    }
    if let Some(n) = num_word(w) {
        return Some(n);
    }
    if let Some(idx) = w.find("tausend") {
        let left = &w[..idx];
        let right = &w[idx + "tausend".len()..];
        let left_n = if left.is_empty() { 1 } else { parse_german_compound(left)? };
        let right_n = if right.is_empty() { 0 } else { parse_german_compound(right)? };
        return Some(left_n * 1000 + right_n);
    }
    if let Some(idx) = w.find("hundert") {
        let left = &w[..idx];
        let right = &w[idx + "hundert".len()..];
        let left_n = if left.is_empty() { 1 } else { parse_german_compound(left)? };
        let right_n = if right.is_empty() { 0 } else { parse_german_compound(right)? };
        return Some(left_n * 100 + right_n);
    }
    // "einundzwanzig" → <ones>und<tens>
    if let Some(pos) = w.find("und") {
        let ones = &w[..pos];
        let tens = &w[pos + 3..];
        if !ones.is_empty() && !tens.is_empty() {
            if let (Some(o), Some(t)) = (num_word(ones), num_word(tens)) {
                if t % 10 == 0 {
                    return Some(t + o);
                }
            }
        }
    }
    None
}

/// Fold a space-separated phrase like ["drei", "tausend"] into 3000. Returns
/// None on the slightest ambiguity so the caller leaves the text alone.
fn multiply_phrase(words: &[&str]) -> Option<i64> {
    let mut total: i64 = 0;
    let mut pending: i64 = 0;
    let mut has_pending = false;
    for w in words {
        match w.to_lowercase().as_str() {
            "und" => continue,
            "hundert" => {
                let mul = if has_pending { pending } else { 1 };
                pending = mul * 100;
                has_pending = true;
            }
            "tausend" => {
                let mul = if has_pending { pending } else { 1 };
                total += mul * 1000;
                pending = 0;
                has_pending = false;
            }
            _ => {
                let n = parse_german_compound(w)?;
                if has_pending {
                    pending += n;
                } else {
                    pending = n;
                    has_pending = true;
                }
            }
        }
    }
    let result = total + if has_pending { pending } else { 0 };
    if result == 0 {
        None
    } else {
        Some(result)
    }
}

// A number (digit literal OR 1–4 German number words) directly before a
// currency word. `\b` keeps the boundary zero-width so adjacent amounts both
// match. The regex crate's `\w`/`\b` are Unicode-aware (umlauts count).
static CURRENCY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(\d+(?:[.,]\d+)?|[a-zäöüß]+(?:\s+[a-zäöüß]+){0,3})\s+(Euro|Cent|CHF|Franken)\b",
    )
    .expect("invalid CURRENCY regex pattern")
});
static DIGIT_ONLY: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d+(?:[.,]\d+)?$").expect("invalid DIGIT_ONLY regex pattern"));

// Same number-capture as CURRENCY, but before a percent/unit word. Longer unit
// words come first in the alternation so "Kilometer" never loses to "Meter"
// (belt — the `\s+` already anchors the unit at the word start). Inflected dative
// plurals (…metern) included since dictation often produces them.
static MEASURE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(\d+(?:[.,]\d+)?|[a-zäöüß]+(?:\s+[a-zäöüß]+){0,3})\s+(Prozent|Kilometern|Kilometer|Zentimetern|Zentimeter|Millimetern|Millimeter|Kilogramm|Metern|Meter|Kilo|Gramm|Litern|Liter)\b",
    )
    .expect("invalid MEASURE regex pattern")
});

/// Scale words that must never stand alone as "the number" — "tausend Euro" is
/// too ambiguous (e.g. "Aktien für tausend Euro") so we leave it untouched.
fn is_scale_only(w: &str) -> bool {
    matches!(
        w.to_lowercase().as_str(),
        "hundert" | "tausend" | "million" | "millionen" | "milliarde" | "milliarden"
    )
}

/// Resolve the number capture (a digit literal or 1–4 German number words) to a
/// digit string. `None` = ambiguous or a bare scale word ("tausend") → the caller
/// leaves the original text untouched. Shared by currency AND measure formatting.
/// Returns `(prefix, digits)` where `prefix` is any leading words kept verbatim
/// (with a trailing space) and `digits` is the parsed amount. `None` = nothing
/// parseable, so the caller leaves the original text untouched.
fn resolve_amount(raw: &str) -> Option<(String, String)> {
    if DIGIT_ONLY.is_match(raw) {
        return Some((String::new(), raw.to_string()));
    }
    let words: Vec<&str> = raw.split_whitespace().collect();
    // The regex greedily captures up to 4 words, so a leading NON-number word can
    // ride along ("in zwei Metern", "für zweihundert Euro"). Take the longest
    // TRAILING sub-phrase that parses and keep the skipped leader verbatim, so the
    // replacement is "in 2 m", never "2 m" (which would eat the "in").
    for start in 0..words.len() {
        let sub = &words[start..];
        // A bare scale word ("tausend") is too ambiguous to stand as the amount.
        if sub.len() == 1 && is_scale_only(sub[0]) {
            continue;
        }
        let joined: String = sub.concat();
        let parsed = parse_german_compound(&joined)
            .or_else(|| if sub.len() >= 2 { multiply_phrase(sub) } else { None });
        if let Some(p) = parsed {
            let prefix = if start == 0 {
                String::new()
            } else {
                format!("{} ", words[..start].join(" "))
            };
            return Some((prefix, p.to_string()));
        }
    }
    None
}

fn format_currency(caps: &Captures) -> String {
    let whole = caps[0].to_string();
    let (prefix, n_str) = match resolve_amount(caps[1].trim()) {
        Some(x) => x,
        None => return whole,
    };
    let suffix = match caps[2].to_lowercase().as_str() {
        "euro" => " €",
        "cent" => " ct",
        "chf" | "franken" => " CHF",
        _ => return whole,
    };
    format!("{prefix}{n_str}{suffix}")
}

/// SI-symbol suffix for a spoken percent/unit word (base + dative-plural forms).
fn unit_suffix(unit_lower: &str) -> Option<&'static str> {
    Some(match unit_lower {
        "prozent" => " %",
        "kilometer" | "kilometern" => " km",
        "zentimeter" | "zentimetern" => " cm",
        "millimeter" | "millimetern" => " mm",
        "meter" | "metern" => " m",
        "kilogramm" | "kilo" => " kg",
        "gramm" => " g",
        "liter" | "litern" => " l",
        _ => return None,
    })
}

fn format_measure(caps: &Captures) -> String {
    let whole = caps[0].to_string();
    let suffix = match unit_suffix(&caps[2].to_lowercase()) {
        Some(s) => s,
        None => return whole,
    };
    match resolve_amount(caps[1].trim()) {
        Some((prefix, n)) => format!("{prefix}{n}{suffix}"),
        None => whole,
    }
}

static ABBREVIATIONS: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    [
        (r"(?i)\bz\.\s*B\.", "z. B."),
        (r"(?i)\bd\.\s*h\.", "d. h."),
        (r"(?i)\bu\.\s*a\.", "u. a."),
        (r"(?i)\bs\.\s*o\.", "s. o."),
        (r"(?i)\bs\.\s*u\.", "s. u."),
        (r"(?i)\bi\.\s*d\.\s*R\.", "i. d. R."),
        (r"(?i)\bu\.\s*U\.", "u. U."),
        (r"(?i)\bv\.\s*a\.", "v. a."),
        (r"(?i)\bo\.\s*Ä\.", "o. Ä."),
        (r"(?i)\bbzgl\.", "bzgl."),
        (r"(?i)\bggf\.", "ggf."),
        (r"(?i)\bca\.", "ca."),
        (r"(?i)\busw\.", "usw."),
        (r"(?i)\bevtl\.", "evtl."),
    ]
    .into_iter()
    .map(|(p, r)| (Regex::new(p).expect("invalid ABBREVIATIONS regex pattern"), r))
    .collect()
});

static PUNCT_BEFORE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+([,.;:!?])").expect("invalid PUNCT_BEFORE regex pattern"));
// Lookahead-free port of `([,;:!?])(?=[^\s\d])`: capture + re-emit the next char.
static PUNCT_AFTER: Lazy<Regex> = Lazy::new(|| Regex::new(r"([,;:!?])([^\s\d])").expect("invalid PUNCT_AFTER regex pattern"));
static MULTISPACE: Lazy<Regex> = Lazy::new(|| Regex::new(r" {2,}").expect("invalid MULTISPACE regex pattern"));
static QUOTES: Lazy<Regex> = Lazy::new(|| Regex::new("\"([^\"\n]+?)\"").expect("invalid QUOTES regex pattern"));

/// Apply the full DACH pipeline. Order matters: currency first (expects
/// unmangled number words), then abbreviations, punctuation, finally quotes.
pub fn dach_format(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut s = CURRENCY.replace_all(text, format_currency).into_owned();
    s = MEASURE.replace_all(&s, format_measure).into_owned();
    for (re, repl) in ABBREVIATIONS.iter() {
        s = re.replace_all(&s, *repl).into_owned();
    }
    s = PUNCT_BEFORE.replace_all(&s, "$1").into_owned();
    s = PUNCT_AFTER.replace_all(&s, "$1 $2").into_owned();
    s = MULTISPACE.replace_all(&s, " ").into_owned();
    s = QUOTES.replace_all(&s, "„$1“").into_owned();
    s.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::dach_format;

    #[test]
    fn digit_currency() {
        assert_eq!(dach_format("das kostet 20 Euro"), "das kostet 20 €");
        assert_eq!(dach_format("50 Cent bitte"), "50 ct bitte");
    }

    #[test]
    fn spoken_currency() {
        assert_eq!(dach_format("zweihundert Euro"), "200 €");
        assert_eq!(dach_format("zweihundertfünfzig Euro"), "250 €");
        assert_eq!(dach_format("dreitausend Euro"), "3000 €");
        assert_eq!(dach_format("drei tausend Euro"), "3000 €");
        assert_eq!(dach_format("einundzwanzig Euro"), "21 €");
        // Leading non-number word is kept verbatim, not eaten.
        assert_eq!(dach_format("für zweihundert Euro"), "für 200 €");
    }

    #[test]
    fn conservative() {
        // bare scale word + running prose must be left alone
        assert_eq!(dach_format("der Euro fällt"), "der Euro fällt");
        assert_eq!(dach_format("Aktien für tausend Euro"), "Aktien für tausend Euro");
    }

    #[test]
    fn percent_and_units() {
        assert_eq!(dach_format("fünfzig Prozent"), "50 %");
        assert_eq!(dach_format("das sind 20 Prozent"), "das sind 20 %");
        assert_eq!(dach_format("zehn Kilometer"), "10 km");
        assert_eq!(dach_format("fünf Kilometer"), "5 km"); // not mangled via "Kilo"+"meter"
        assert_eq!(dach_format("500 Gramm Mehl"), "500 g Mehl");
        assert_eq!(dach_format("drei Kilo"), "3 kg");
        assert_eq!(dach_format("zwei Meter Stoff"), "2 m Stoff");
        assert_eq!(dach_format("hundertfünfzig Zentimeter"), "150 cm");
        assert_eq!(dach_format("in zwei Metern Höhe"), "in 2 m Höhe");
    }

    #[test]
    fn units_stay_conservative() {
        // Bare scale word before a unit is ambiguous → left alone (like currency).
        assert_eq!(dach_format("tausend Meter"), "tausend Meter");
        // No number → untouched (the unit word alone must never trigger).
        assert_eq!(dach_format("der Meter ist eine Einheit"), "der Meter ist eine Einheit");
        assert_eq!(dach_format("viele Kilometer entfernt"), "viele Kilometer entfernt");
    }

    #[test]
    fn abbreviations_and_quotes() {
        assert_eq!(dach_format("z.B. das"), "z. B. das");
        assert_eq!(dach_format("er sagte \"Hallo\""), "er sagte „Hallo“");
    }

    #[test]
    fn punctuation_spacing() {
        assert_eq!(dach_format("Hallo , Welt"), "Hallo, Welt");
        assert_eq!(dach_format("eins,zwei"), "eins, zwei");
    }
}
