//! wespeaker-Voiceprint-Embedder via onnxruntime (`ort`) — nutzt EXAKT
//! dieselbe ONNX-Modelldatei wie der Server (wespeakerruntime ist intern
//! onnxruntime) → numerische Parität, die GT-validierten Schwellen aus
//! PARAMS.json gelten unverändert. Paritäts-Test: `tests/embedder_parity.rs`.
//!
//! Eingabe: 16 kHz mono PCM. Ausgabe: L2-normierter 256er-Voiceprint
//! (None bei zu wenig Audio / Null-Norm) — das Format, das
//! `matching::name_segments` als Anker/embed-Ergebnis erwartet.

use crate::fbank::fbank_cmn;

pub struct Embedder {
    session: ort::session::Session,
}

impl Embedder {
    pub fn new(model_path: &std::path::Path) -> Result<Self, ort::Error> {
        let session = ort::session::Session::builder()?
            .with_inter_threads(1)?
            .with_intra_threads(1)?
            .commit_from_file(model_path)?;
        Ok(Self { session })
    }

    /// Samples in int16-Skala als f32 (s16le-PCM 1:1 gecastet), 16 kHz mono.
    pub fn embed(&mut self, samples: &[f32]) -> Option<Vec<f32>> {
        let feats = fbank_cmn(samples);
        let t = feats.len();
        if t == 0 {
            return None;
        }
        let dim = feats[0].len();
        let flat: Vec<f32> = feats.into_iter().flatten().collect();
        let input = ort::value::Value::from_array(([1usize, t, dim], flat)).ok()?;
        let outputs = self.session.run(ort::inputs!["feats" => input]).ok()?;
        let (_, data) = outputs["embs"].try_extract_tensor::<f32>().ok()?;
        let e: Vec<f32> = data.to_vec();
        let n = e.iter().map(|x| x * x).sum::<f32>().sqrt();
        if n > 0.0 {
            Some(e.iter().map(|x| x / n).collect())
        } else {
            None
        }
    }

    /// Bequemlichkeit: rohe s16le-Samples.
    pub fn embed_i16(&mut self, samples: &[i16]) -> Option<Vec<f32>> {
        let f: Vec<f32> = samples.iter().map(|&s| s as f32).collect();
        self.embed(&f)
    }
}
