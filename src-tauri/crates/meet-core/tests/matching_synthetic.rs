//! Port der deterministischen Synthetik-Tests aus
//! `python/tests/test_matching_synthetic.py` — KEINE echten Voiceprints.

use std::collections::HashMap;

use meet_core::{name_segments, Anchors, Segment, Word};

const D: usize = 16;

fn unit(i: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; D];
    v[i] = 1.0;
    v
}

fn mix(a: f32, b: f32) -> Vec<f32> {
    let mut v = vec![0.0f32; D];
    v[0] = a;
    v[1] = b;
    let n = (a * a + b * b).sqrt();
    v.iter().map(|x| x / n).collect()
}

fn anchors() -> Anchors {
    vec![("A".to_string(), unit(0)), ("B".to_string(), unit(1))]
}

fn seg(start: f64, end: f64, text: &str, words: Option<Vec<Word>>) -> Segment {
    Segment { start, end, text: text.to_string(), words, energy: None }
}

fn word(start: f64, end: f64, w: &str) -> Word {
    Word { start, end, word: Some(w.to_string()) }
}

/// embed(a,b,min_s) → Lookup über (round(a,2), round(b,2)); None wenn zu kurz/fehlt.
fn table_embedder(table: HashMap<(i64, i64), Vec<f32>>) -> impl Fn(f64, f64, f64) -> Option<Vec<f32>> {
    move |a, b, min_s| {
        if b - a < min_s {
            return None;
        }
        table.get(&((a * 100.0).round() as i64, (b * 100.0).round() as i64)).cloned()
    }
}

fn key(a: f64, b: f64) -> (i64, i64) {
    ((a * 100.0).round() as i64, (b * 100.0).round() as i64)
}

#[test]
fn clean_alternation_all_direct() {
    let segs = vec![
        seg(0.0, 3.0, "a spricht", None),
        seg(3.0, 6.0, "b spricht", None),
        seg(6.0, 9.0, "a nochmal", None),
    ];
    let table = HashMap::from([
        (key(0.0, 3.0), mix(0.9, 0.1)),
        (key(3.0, 6.0), mix(0.1, 0.9)),
        (key(6.0, 9.0), mix(0.85, 0.15)),
    ]);
    let r = name_segments(&segs, &anchors(), table_embedder(table), None);
    let names: Vec<_> = r.names.iter().map(|n| n.as_deref().unwrap()).collect();
    assert_eq!(names, ["A", "B", "A"]);
    assert_eq!(r.stats.pass2_direct, 3);
}

#[test]
fn one_sided_adaptation_rejected_all_or_nothing() {
    // B hat 3 starke lange Treffer (adaptiert), A nur kurze → nur 1/2 adaptierbar
    // → all-or-nothing: Enroll-Anker bleiben für BEIDE, A's leise Segmente
    // gewinnen weiter per argmax (das war der 69%-Bug aus GT-Test 922462).
    let mut segs: Vec<Segment> = (0..3)
        .map(|i| seg(i as f64 * 3.0, i as f64 * 3.0 + 2.5, &format!("b lang {i}"), None))
        .collect();
    segs.push(seg(9.0, 9.9, "a kurz", None));
    let table = HashMap::from([
        (key(0.0, 2.5), mix(0.05, 0.95)),
        (key(3.0, 5.5), mix(0.08, 0.92)),
        (key(6.0, 8.5), mix(0.06, 0.94)),
        (key(9.0, 9.9), mix(0.30, 0.25)), // leiser A: argmax A, aber unter T
    ]);
    let r = name_segments(&segs, &anchors(), table_embedder(table), None);
    assert!(!r.stats.adapted);
    assert_eq!(r.names[3].as_deref(), Some("A"));
}

#[test]
fn split_mixed_segment() {
    // Ein 4s-Segment: erste Hälfte A, zweite Hälfte B, Satzgrenze nach Wort 2.
    let words = vec![
        word(0.0, 0.9, " erstens"),
        word(0.9, 1.8, " gut."),
        word(1.9, 2.9, " zweitens"),
        word(2.9, 4.0, " auch"),
    ];
    let segs = vec![seg(0.0, 4.0, "erstens gut. zweitens auch", Some(words))];
    let table = HashMap::from([
        (key(0.0, 4.0), mix(0.6, 0.55)),  // Gesamtsegment: unklar
        (key(0.0, 1.8), mix(0.95, 0.05)), // links = A
        (key(1.9, 4.0), mix(0.05, 0.95)), // rechts = B
    ]);
    let r = name_segments(&segs, &anchors(), table_embedder(table), None);
    assert_eq!(r.stats.splits, 1);
    assert_eq!(r.segments.len(), 2);
    let names: Vec<_> = r.names.iter().map(|n| n.as_deref().unwrap()).collect();
    assert_eq!(names, ["A", "B"]);
    assert_eq!(r.segments[0].text, "erstens gut.");
}

#[test]
fn degenerate_anchors_never_panic() {
    // Codex P1: Desktop-Pfad — 0/1 Anker und NaN-Embeddings dürfen nie panicken.
    let segs = vec![seg(0.0, 3.0, "hallo", None)];
    let table = HashMap::from([(key(0.0, 3.0), mix(0.9, 0.1))]);

    let r0 = name_segments(&segs, &vec![], table_embedder(table.clone()), None);
    assert_eq!(r0.names, vec![None]);

    let one: Anchors = vec![("Solo".to_string(), unit(0))];
    let r1 = name_segments(&segs, &one, table_embedder(table), None);
    assert_eq!(r1.names[0].as_deref(), Some("Solo"));
    assert_eq!(r1.stats.named, 1);

    // NaN-Embedding → rank sortiert ohne Panik (Ergebnis egal, nur kein Crash)
    let nan_table = HashMap::from([(key(0.0, 3.0), vec![f32::NAN; D])]);
    let _ = name_segments(&segs, &anchors(), table_embedder(nan_table), None);
}

#[test]
fn mini_rescue_and_ffill() {
    // 0.3s-Einwurf: zu kurz für normales Embedding, Mini-Embed rettet ihn;
    // ein weiteres embedloses Segment ohne Mini-Treffer erbt per ffill.
    let segs = vec![
        seg(0.0, 3.0, "a lang", None),
        seg(3.0, 3.3, "Eben.", None),
        seg(3.4, 3.7, "öh", None),
    ];
    let table = HashMap::from([
        (key(0.0, 3.0), mix(0.9, 0.1)),
        (key(3.0, 3.3), mix(0.1, 0.6)), // Mini: klar B (Margin > MINI_M)
        // (3.4, 3.7) fehlt → embed None → ffill erbt B
    ]);
    let r = name_segments(&segs, &anchors(), table_embedder(table), None);
    let names: Vec<_> = r.names.iter().map(|n| n.as_deref().unwrap()).collect();
    assert_eq!(names, ["A", "B", "B"]);
}
