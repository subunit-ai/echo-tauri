//! Paritäts-Test des Rust-Embedders (fbank + ort) gegen die echte Python-
//! Referenz (wespeakerruntime im transcribe-api-Container, torchaudio-fbank).
//!
//! Fixtures: `fixtures/parity.wav` (DETERMINISTISCHES Synthetik-Audio, KEINE
//! Biometrie — committet) + `fixtures/parity_ref.json` (Fbank-Frames +
//! normiertes Referenz-Embedding aus dem Container). Das ONNX-Modell selbst
//! (26 MB, öffentliches wespeaker-en-Modell) liegt ungetrackt unter
//! `fixtures/models/model.onnx` — fehlt es, wird der Embedding-Teil geskippt
//! (Fbank-Parität läuft immer).

#![cfg(feature = "embedder")]

use std::path::Path;

use meet_core::{fbank_cmn, Embedder};

#[derive(serde::Deserialize)]
struct Ref {
    n_samples: usize,
    fbank_shape: (usize, usize),
    fbank_frame0: Vec<f32>,
    fbank_frame_last: Vec<f32>,
    fbank_mean_abs: f32,
    embedding_l2norm: f32,
    embedding: Vec<f32>,
}

fn fixtures() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures")
}

fn load() -> (Vec<f32>, Ref) {
    let mut rd = hound::WavReader::open(fixtures().join("parity.wav")).expect("parity.wav fehlt");
    assert_eq!(rd.spec().sample_rate, 16000);
    // int16-Skala wie torchaudio.load * (1<<15)
    let samples: Vec<f32> = rd.samples::<i16>().map(|s| s.unwrap() as f32).collect();
    let r: Ref =
        serde_json::from_str(&std::fs::read_to_string(fixtures().join("parity_ref.json")).unwrap())
            .unwrap();
    assert_eq!(samples.len(), r.n_samples);
    (samples, r)
}

fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
}

#[test]
fn fbank_matches_torchaudio() {
    let (samples, r) = load();
    let feats = fbank_cmn(&samples);
    assert_eq!((feats.len(), feats[0].len()), r.fbank_shape, "Fbank-Shape");
    let d0 = max_abs_diff(&feats[0], &r.fbank_frame0);
    let dl = max_abs_diff(feats.last().unwrap(), &r.fbank_frame_last);
    let mean_abs =
        feats.iter().flatten().map(|x| x.abs()).sum::<f32>() / (feats.len() * feats[0].len()) as f32;
    eprintln!("fbank diff frame0={d0:.2e} last={dl:.2e} | mean_abs {mean_abs:.6} vs {:.6}", r.fbank_mean_abs);
    assert!(d0 < 1e-2 && dl < 1e-2, "Fbank weicht ab: frame0 {d0}, last {dl}");
    assert!((mean_abs - r.fbank_mean_abs).abs() / r.fbank_mean_abs < 1e-3);
}

#[test]
fn embedding_matches_wespeakerruntime() {
    let model = fixtures().join("models/model.onnx");
    if !model.is_file() {
        eprintln!("skip: fixtures/models/model.onnx fehlt (docker cp aus transcribe-api)");
        return;
    }
    let (samples, r) = load();
    let mut emb = Embedder::new(&model).expect("ort-Session");
    let e = emb.embed(&samples).expect("Embedding");
    assert_eq!(e.len(), r.embedding.len());
    let cos: f32 = e.iter().zip(&r.embedding).map(|(x, y)| x * y).sum();
    eprintln!("embedding cosine vs Python-Referenz: {cos:.7} (Roh-Norm Referenz {:.4})", r.embedding_l2norm);
    assert!(cos > 0.9999, "Embedding-Parität verfehlt: cos={cos}");
}
