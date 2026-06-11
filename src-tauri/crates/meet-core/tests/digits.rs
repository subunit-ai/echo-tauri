//! Port der 8 Python-Tests aus `python/tests/test_digits.py`.

use meet_core::{digits_from_text, spoken_code_matches};

#[test]
fn plain_digits() {
    assert_eq!(digits_from_text("32603"), "32603");
}

#[test]
fn spoken_german() {
    assert_eq!(digits_from_text("drei zwei sechs null drei"), "32603");
}

#[test]
fn spoken_english() {
    assert_eq!(digits_from_text("three two six zero three"), "32603");
}

#[test]
fn mixed_words_digits() {
    assert_eq!(digits_from_text("4 sieben 1"), "471");
}

#[test]
fn umlaut_and_variants() {
    assert_eq!(digits_from_text("fünf fuenf zwo"), "552");
}

#[test]
fn noise_around_code() {
    assert!(spoken_code_matches("Okay, die Zahl ist 5 0 6 5 4, fertig.", "50654"));
}

#[test]
fn no_match_partial() {
    assert!(!spoken_code_matches("nur 1865 gehört", "18679"));
}

#[test]
fn empty() {
    assert_eq!(digits_from_text(""), "");
    assert!(!spoken_code_matches("", "12345"));
    assert!(!spoken_code_matches("12345", ""));
}
