//! Wort↔Ziffer-Normalisierung für den Stimm-Check-In (DE+EN).
//! Verhaltensgleicher Port von `python/meet_core/digits.py`
//! (Tokenizer = Läufe aus `[0-9]+` oder `[a-zäöüß]+` über dem lowercased Text).

fn num_word(tok: &str) -> Option<char> {
    Some(match tok {
        "null" | "zero" | "oh" => '0',
        "eins" | "ein" | "eine" | "one" => '1',
        "zwei" | "zwo" | "two" => '2',
        "drei" | "three" => '3',
        "vier" | "four" => '4',
        "fünf" | "fuenf" | "five" => '5',
        "sechs" | "six" => '6',
        "sieben" | "seven" => '7',
        "acht" | "eight" => '8',
        "neun" | "nine" => '9',
        _ => return None,
    })
}

#[derive(PartialEq, Clone, Copy)]
enum Kind {
    Digit,
    Letter,
    Other,
}

fn kind(c: char) -> Kind {
    if c.is_ascii_digit() {
        Kind::Digit
    } else if c.is_ascii_lowercase() || matches!(c, 'ä' | 'ö' | 'ü' | 'ß') {
        Kind::Letter
    } else {
        Kind::Other
    }
}

/// Ziffernkette aus evtl. gesprochenen Zahlen (`"4 sieben 1"` → `"471"`).
pub fn digits_from_text(text: &str) -> String {
    let lower = text.to_lowercase();
    let mut out = String::new();
    let mut tok = String::new();
    let mut tok_kind = Kind::Other;
    let mut flush = |tok: &mut String, k: Kind, out: &mut String| {
        if tok.is_empty() {
            return;
        }
        match k {
            Kind::Digit => out.push_str(tok),
            Kind::Letter => {
                if let Some(d) = num_word(tok) {
                    out.push(d);
                }
            }
            Kind::Other => {}
        }
        tok.clear();
    };
    for c in lower.chars() {
        let k = kind(c);
        if k != tok_kind || k == Kind::Other {
            flush(&mut tok, tok_kind, &mut out);
            tok_kind = k;
        }
        if k != Kind::Other {
            tok.push(c);
        }
    }
    flush(&mut tok, tok_kind, &mut out);
    out
}

/// True, wenn der Enroll-`code` im (evtl. gesprochenen) Ziffern-Text vorkommt.
pub fn spoken_code_matches(text: &str, code: &str) -> bool {
    !code.is_empty() && digits_from_text(text).contains(code)
}
