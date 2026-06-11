//! `WindowTranscriber`-Implementierung über whisper.cpp (whisper-rs) — der
//! lokale Ersatz für faster-whisper auf dem Server. Gleiche Anti-Halluzinations-
//! Parameter wie `transcribe::local` (Lehre aus v0.4.25), zusätzlich
//! `token_timestamps`: aus den Token-Zeiten werden Wörter gebaut (Gruppierung
//! an führenden Leerzeichen) — das Word-Format, das das Sub-Segment-Splitting
//! der Naming-Kette (meet-core) braucht.
//!
//! Eigener Kontext-Cache, getrennt vom Diktat (`transcribe::local`): Meetings
//! nutzen typischerweise ein größeres Modell (large-v3-turbo) als das Diktat —
//! zwei Caches verhindern ständiges Re-Laden beim Wechsel Diktat↔Meeting.

use std::sync::Mutex;

use once_cell::sync::Lazy;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::incremental::{RawSeg, RawWord, WindowTranscriber};

static CTX: Lazy<Mutex<Option<(String, WhisperContext)>>> = Lazy::new(|| Mutex::new(None));

pub struct WhisperWindow {
    pub model: String,
    /// `None` = Auto-Detect (wie Server `language=None`).
    pub language: Option<String>,
}

impl WindowTranscriber for WhisperWindow {
    fn transcribe(&mut self, samples: &[f32]) -> anyhow::Result<Vec<RawSeg>> {
        let path = crate::models::ensure_blocking(&self.model)?;
        let mut guard = CTX.lock().map_err(|_| anyhow::anyhow!("meet whisper mutex poisoned"))?;
        let reload = guard.as_ref().map(|(m, _)| m != &self.model).unwrap_or(true);
        if reload {
            let ctx = WhisperContext::new_with_params(&path, WhisperContextParameters::default())
                .map_err(|e| anyhow::anyhow!("whisper load: {e}"))?;
            *guard = Some((self.model.clone(), ctx));
        }
        let ctx = &guard.as_ref().ok_or_else(|| anyhow::anyhow!("whisper context not initialized"))?.1;
        let mut state = ctx.create_state().map_err(|e| anyhow::anyhow!("whisper state: {e}"))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        // Anti-Halluzination wie transcribe::local (v0.4.25) — Begründung dort.
        params.set_no_context(true);
        params.set_temperature(0.0);
        params.set_temperature_inc(0.2);
        params.set_entropy_thold(2.4);
        params.set_logprob_thold(-1.0);
        params.set_no_speech_thold(0.6);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        // Wort-Zeiten für das Sub-Segment-Splitting der Naming-Kette.
        params.set_token_timestamps(true);
        params.set_language(self.language.as_deref());

        state.full(params, samples).map_err(|e| anyhow::anyhow!("whisper full: {e}"))?;

        let mut out = Vec::new();
        for i in 0..state.full_n_segments() {
            let Some(seg) = state.get_segment(i) else { continue };
            let Ok(text) = seg.to_str_lossy() else { continue };
            let mut words: Vec<RawWord> = Vec::new();
            for j in 0..seg.n_tokens() {
                let Some(tok) = seg.get_token(j) else { continue };
                let Ok(ts) = tok.to_str_lossy() else { continue };
                // Spezial-Tokens ([_BEG_], <|endoftext|>, …) sind keine Wörter.
                if ts.starts_with("[_") || ts.starts_with("<|") {
                    continue;
                }
                let d = tok.token_data();
                let (t0, t1) = (d.t0 as f64 / 100.0, d.t1 as f64 / 100.0);
                // Neues Wort bei führendem Leerzeichen, sonst Subword-Fortsetzung.
                if ts.starts_with(' ') || words.is_empty() {
                    words.push(RawWord { start: t0, end: t1, word: ts.to_string() });
                } else {
                    let last = words.last_mut().unwrap();
                    last.word.push_str(&ts);
                    last.end = t1;
                }
            }
            out.push(RawSeg {
                start: seg.start_timestamp() as f64 / 100.0, // Centisekunden
                end: seg.end_timestamp() as f64 / 100.0,
                text: text.to_string(),
                words,
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lädt das tiny-Modell + prüft, dass der Token→Wort-Pfad durchläuft
    /// (synthetischer Ton → meist 0 Segmente, darf aber nie crashen).
    /// Manuell: `cargo test --features local-whisper -- --ignored --nocapture`
    #[test]
    #[ignore = "lädt Modell herunter — manuell laufen lassen"]
    fn token_word_smoke() {
        let sr = 16_000usize;
        let samples: Vec<f32> = (0..sr * 3)
            .map(|i| (i as f32 * 220.0 * std::f32::consts::TAU / sr as f32).sin() * 0.1)
            .collect();
        let mut w = WhisperWindow { model: "tiny".into(), language: Some("de".into()) };
        let r = w.transcribe(&samples);
        println!("MEET_LOCAL_SMOKE ok={} segs={:?}", r.is_ok(), r.as_ref().map(|v| v.len()));
        assert!(r.is_ok(), "whisper window failed: {:?}", r.err());
    }
}
