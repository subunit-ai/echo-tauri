//! Golden-Replay-Tests gegen die echten GT-Skript-Meetings (922462 + 301304).
//!
//! Die echten Voiceprints/Embeddings sind BIOMETRIE und liegen NICHT im Repo —
//! sondern lokal unter `fixtures/private/` (gitignored). Fehlen die Dateien
//! (CI/vendored Kopie in Echo), wird geskippt — die Synthetik-Tests decken die
//! Logik ab; die Replays beweisen Parität mit der Python-Referenz und der
//! GT-Validierung (301304: 64/64 = 100 %, 922462: 62/63 = 98,4 %).
//!
//! Der Rust-Port MUSS exakt dieselben `expected_names` liefern wie Python —
//! sonst kein Merge.

use std::collections::HashMap;
use std::path::Path;

use meet_core::{name_segments, Anchors, Segment};

fn run_replay(code: &str) {
    let f = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../fixtures/private/{code}_replay.json"));
    if !f.is_file() {
        eprintln!("skip: private fixture fehlt ({code}) — Replay nur auf subunit-Maschinen");
        return;
    }
    let d: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(f).unwrap()).unwrap();

    let segs: Vec<Segment> = serde_json::from_value(d["segments"].clone()).unwrap();
    // Anker-Reihenfolge = JSON-Reihenfolge (serde_json preserve_order)
    let anchors: Anchors = d["anchors"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(n, v)| (n.clone(), serde_json::from_value::<Vec<f32>>(v.clone()).unwrap()))
        .collect();
    let calls: HashMap<String, Option<Vec<f32>>> =
        serde_json::from_value(d["embed_calls"].clone()).unwrap();
    let expected_names: Vec<Option<String>> =
        serde_json::from_value(d["expected_names"].clone()).unwrap();

    let embed = |a: f64, b: f64, min_s: f64| -> Option<Vec<f32>> {
        if b - a < min_s {
            return None;
        }
        calls.get(&format!("{a:.3}|{b:.3}")).cloned().flatten()
    };

    let r = name_segments(&segs, &anchors, embed, None);
    assert_eq!(r.names, expected_names, "{code}: Namen weichen von der Python-Referenz ab");
    assert_eq!(
        r.stats.splits as u64,
        d["expected_stats"]["splits"].as_u64().unwrap(),
        "{code}: splits"
    );
    assert_eq!(
        r.stats.adapted,
        d["expected_stats"]["adapted"].as_bool().unwrap(),
        "{code}: adapted"
    );
    eprintln!("{code}: {} Segmente, alle Namen identisch zur Python-Referenz ✓", r.names.len());
}

#[test]
fn golden_replay_301304() {
    run_replay("301304");
}

#[test]
fn golden_replay_922462() {
    run_replay("922462");
}
