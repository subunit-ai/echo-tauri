//! DACH formatting pack (port of the Python dach_format pass): German curly
//! quotes, spaced abbreviations, and currency normalisation. Pure function.

use once_cell::sync::Lazy;
use regex::Regex;

static QUOTES: Lazy<Regex> = Lazy::new(|| Regex::new(r#""([^"]*)""#).unwrap());
static CURRENCY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\d+(?:[.,]\d+)?)\s*(?:Euro|EUR)\b").unwrap());

pub fn dach_format(text: &str) -> String {
    let mut s = text.to_string();
    // Paired straight quotes → German „…"
    s = QUOTES.replace_all(&s, "„$1“").into_owned();
    // 20 Euro / 20 EUR → 20 €
    s = CURRENCY.replace_all(&s, "$1 €").into_owned();
    // Common abbreviations → spaced form (idempotent: spaced forms map to themselves)
    for (from, to) in [
        ("z.B.", "z. B."),
        ("d.h.", "d. h."),
        ("u.a.", "u. a."),
        ("i.d.R.", "i. d. R."),
        ("u.U.", "u. U."),
        ("v.a.", "v. a."),
        ("s.o.", "s. o."),
        ("s.u.", "s. u."),
        ("o.Ä.", "o. Ä."),
        ("Nr.", "Nr."),
    ] {
        s = s.replace(from, to);
    }
    s
}
