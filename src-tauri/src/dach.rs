//! DACH formatting pack — full port of the Python `dach_format.py` "DE database".
//!
//! Fixes the mechanical things Whisper gets wrong in German, conservatively
//! (anything ambiguous is left alone):
//!   - Spoken German numbers before a currency word become digits + symbol:
//!     "zweihundert Euro" → "200 €", "drei tausend Euro" → "3000 €",
//!     "20 Euro" → "20 €", "50 Cent" → "50 ct". Running prose like
//!     "der Euro fällt" or a bare "tausend Euro" is left untouched.
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
static CURRENCY: Lazy<Result<Regex, regex::Error>> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(\d+(?:[.,]\d+)?|[a-zäöüß]+(?:\s+[a-zäöüß]+){0,3})\s+(Euro|Cent|CHF|Franken)\b",
    )
});
static DIGIT_ONLY: Lazy<Result<Regex, regex::Error>> = Lazy::new(|| Regex::new(r"^\d+(?:[.,]\d+)?$"));

/// Scale words that must never stand alone as "the number" — "tausend Euro" is
/// too ambiguous (e.g. "Aktien für tausend Euro") so we leave it untouched.
fn is_scale_only(w: &str) -> bool {
    matches!(
        w.to_lowercase().as_str(),
        "hundert" | "tausend" | "million" | "millionen" | "milliarde" | "milliarden"
    )
}

fn format_currency(caps: &Captures, digit_only: &Regex) -> String {
    let whole = caps[0].to_string();
    let raw = caps[1].trim();
    let unit = &caps[2];
    let unit_lower = unit.to_lowercase();

    let n_str = if digit_only.is_match(raw) {
        raw.to_string()
    } else {
        let words: Vec<&str> = raw.split_whitespace().collect();
        if words.len() == 1 && is_scale_only(words[0]) {
            return whole;
        }
        let joined: String = words.concat();
        let parsed = parse_german_compound(&joined).or_else(|| {
            if words.len() >= 2 {
                multiply_phrase(&words)
            } else {
                None
            }
        });
        match parsed {
            Some(p) => p.to_string(),
            None => return whole,
        }
    };

    let suffix = match unit_lower.as_str() {
        "euro" => " €".to_string(),
        "cent" => " ct".to_string(),
        "chf" | "franken" => " CHF".to_string(),
        _ => format!(" {unit}"),
    };
    format!("{n_str}{suffix}")
}

static ABBREVIATIONS: Lazy<Result<Vec<(Regex, &'static str)>, regex::Error>> = Lazy::new(|| {
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
    .map(|(p, r)| Regex::new(p).map(|re| (re, r)))
    .collect()
});

static PUNCT_BEFORE: Lazy<Result<Regex, regex::Error>> = Lazy::new(|| Regex::new(r"\s+([,.;:!?])"));
// Lookahead-free port of `([,;:!?])(?=[^\s\d])`: capture + re-emit the next char.
static PUNCT_AFTER: Lazy<Result<Regex, regex::Error>> = Lazy::new(|| Regex::new(r"([,;:!?])([^\s\d])"));
static MULTISPACE: Lazy<Result<Regex, regex::Error>> = Lazy::new(|| Regex::new(r" {2,}"));
static QUOTES: Lazy<Result<Regex, regex::Error>> = Lazy::new(|| Regex::new("\"([^\"\n]+?)\""));

/// Apply the full DACH pipeline. Order matters: currency first (expects
/// unmangled number words), then abbreviations, punctuation, finally quotes.
pub fn dach_format(text: &str) -> Result<String, regex::Error> {
    if text.is_empty() {
        return Ok(String::new());
    }

    let currency_re = CURRENCY.as_ref().map_err(|e| e.clone())?;
    let digit_only_re = DIGIT_ONLY.as_ref().map_err(|e| e.clone())?;
    let mut s = currency_re.replace_all(text, |caps: &regex::Captures| format_currency(caps, digit_only_re)).into_owned();

    let abbreviations = ABBREVIATIONS.as_ref().map_err(|e| e.clone())?;
    for (re, repl) in abbreviations.iter() {
        s = re.replace_all(&s, *repl).into_owned();
    }

    let punct_before_re = PUNCT_BEFORE.as_ref().map_err(|e| e.clone())?;
    s = punct_before_re.replace_all(&s, "$1").into_owned();

    let punct_after_re = PUNCT_AFTER.as_ref().map_err(|e| e.clone())?;
    s = punct_after_re.replace_all(&s, "$1 $2").into_owned();

    let multispace_re = MULTISPACE.as_ref().map_err(|e| e.clone())?;
    s = multispace_re.replace_all(&s, " ").into_owned();

    let quotes_re = QUOTES.as_ref().map_err(|e| e.clone())?;
    s = quotes_re.replace_all(&s, "„$1“").into_owned();

    Ok(s.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::dach_format;

    #[test]
    fn digit_currency() {
        assert_eq!(dach_format("das kostet 20 Euro").unwrap(), "das kostet 20 €");
        assert_eq!(dach_format("50 Cent bitte").unwrap(), "50 ct bitte");
    }

    #[test]
    fn spoken_currency() {
        assert_eq!(dach_format("zweihundert Euro").unwrap(), "200 €");
        assert_eq!(dach_format("zweihundertfünfzig Euro").unwrap(), "250 €");
        assert_eq!(dach_format("dreitausend Euro").unwrap(), "3000 €");
        assert_eq!(dach_format("drei tausend Euro").unwrap(), "3000 €");
        assert_eq!(dach_format("einundzwanzig Euro").unwrap(), "21 €");
    }

    #[test]
    fn conservative() {
        // bare scale word + running prose must be left alone
        assert_eq!(dach_format("der Euro fällt").unwrap(), "der Euro fällt");
        assert_eq!(dach_format("Aktien für tausend Euro").unwrap(), "Aktien für tausend Euro");
    }

    #[test]
    fn abbreviations_and_quotes() {
        assert_eq!(dach_format("z.B. das").unwrap(), "z. B. das");
        assert_eq!(dach_format("er sagte \"Hallo\"").unwrap(), "er sagte „Hallo“");
    }

    #[test]
    fn punctuation_spacing() {
        assert_eq!(dach_format("Hallo , Welt").unwrap(), "Hallo, Welt");
        assert_eq!(dach_format("eins,zwei").unwrap(), "eins, zwei");
    }
}
