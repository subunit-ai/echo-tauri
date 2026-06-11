//! Inkrementelle Fenster-Transkription über den PCM-Store — 1:1-Port der
//! Server-Windowing-Semantik (echo-server `meet_incremental.transcribe_pcm` +
//! `_ready_windows`): 5-Min-CORE-Fenster mit 15 s Kontext links/rechts, nur
//! Core-Segmente behalten, Zeiten file-global, Energy = int16-RMS. Weil das
//! PCM-Format byte-identisch zum Server-Sidecar ist, liefert derselbe
//! Whisper dasselbe Ergebnis wie der Server-Pfad.
//!
//! Der eigentliche Whisper-Lauf ist hinter `WindowTranscriber` abstrahiert —
//! die Windowing-Logik ist damit ohne Modell deterministisch testbar
//! (Tests unten); die echte Implementierung ist `whisper_window` (Feature
//! `local-whisper`).

use serde::{Deserialize, Serialize};

use meet_core::{Segment, Word};

use super::pcm_store::{PcmReader, SR};

pub const SEG_S: usize = 300; // MEET_SEG_SECONDS
pub const CTX_S: usize = 15; // MEET_SEG_CONTEXT
pub const FAIL_TEXT: &str = "[⚠️ Transkription für diesen Abschnitt fehlgeschlagen]";

/// Fenster-relatives Whisper-Ergebnis (Sekunden relativ zum Fensteranfang).
#[derive(Debug, Clone)]
pub struct RawSeg {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub words: Vec<RawWord>,
}

#[derive(Debug, Clone)]
pub struct RawWord {
    pub start: f64,
    pub end: f64,
    pub word: String,
}

pub trait WindowTranscriber {
    /// `samples`: 16 kHz mono, [-1,1]-normiert (ein komplettes Fenster).
    fn transcribe(&mut self, samples: &[f32]) -> anyhow::Result<Vec<RawSeg>>;
}

/// Wie viele Core-Fenster sind VOLL transkribierbar (Core + rechter Kontext da)?
pub fn ready_windows(total_samples: u64) -> usize {
    let mut n = 0u64;
    while (n * SEG_S as u64 + (SEG_S + CTX_S) as u64) * SR as u64 <= total_samples {
        n += 1;
    }
    n as usize
}

/// Port von `transcribe_pcm`: Fenster `[start_window, max_window)`
/// (`max_window=None` → alles inkl. Rest-Fenster am Ende). Gibt
/// (Segmente, fehlgeschlagen?) zurück — ein Fenster-Fehler erzeugt wie auf
/// dem Server ein Warn-Segment und markiert den Lauf als nicht-zertifizierbar.
pub fn transcribe_windows(
    store: &PcmReader,
    t: &mut dyn WindowTranscriber,
    start_window: usize,
    max_window: Option<usize>,
) -> (Vec<Segment>, bool) {
    let total = store.total_samples();
    let mut out: Vec<Segment> = Vec::new();
    let mut failed = false;
    let mut idx = start_window;
    loop {
        if let Some(mw) = max_window {
            if idx >= mw {
                break;
            }
        }
        let core_start = idx * SEG_S;
        if (core_start * SR) as u64 >= total {
            break;
        }
        let left = if idx > 0 { CTX_S } else { 0 };
        let start_sample = ((core_start - left) * SR) as u64;
        let nsamp = (left + SEG_S + CTX_S) * SR;
        let buf = match store.read_samples(start_sample, nsamp) {
            Ok(b) => b,
            Err(_) => break,
        };
        idx += 1;
        if buf.is_empty() {
            break;
        }
        // raw = int16-Skala (für Energy), norm = [-1,1] (für Whisper) — wie Python
        let raw: Vec<f32> = buf.iter().map(|&s| s as f32).collect();
        let norm: Vec<f32> = raw.iter().map(|x| x / 32768.0).collect();
        let woff = (core_start - left) as f64; // fenster-relativ → global
        match t.transcribe(&norm) {
            Ok(rsegs) => {
                for rs in rsegs {
                    if rs.start < left as f64 || rs.start >= (left + SEG_S) as f64 {
                        continue; // nur Core-Segmente (Kontext dient nur Whisper)
                    }
                    let text = rs.text.trim().to_string();
                    if text.is_empty() {
                        continue;
                    }
                    let a = ((rs.start * SR as f64) as i64).max(0) as usize;
                    let b = (((rs.end * SR as f64) as i64) as usize).min(raw.len());
                    let energy = if b > a {
                        let c = &raw[a..b];
                        (c.iter().map(|x| (x * x) as f64).sum::<f64>() / c.len() as f64).sqrt()
                    } else {
                        0.0
                    };
                    let g0 = woff + rs.start;
                    out.push(Segment {
                        start: g0,
                        end: g0 + (rs.end - rs.start),
                        text,
                        energy: Some(energy),
                        words: Some(
                            rs.words
                                .iter()
                                .map(|w| Word {
                                    start: woff + w.start,
                                    end: woff + w.end,
                                    word: Some(w.word.clone()),
                                })
                                .collect(),
                        ),
                    });
                }
            }
            Err(_) => {
                failed = true;
                out.push(Segment {
                    start: core_start as f64,
                    end: (core_start + SEG_S) as f64,
                    text: FAIL_TEXT.to_string(),
                    energy: Some(0.0),
                    words: None,
                });
            }
        }
    }
    (out, failed)
}

/// Persistenter Zustand pro Aufnahme — Port von `ConnState` + Manifest
/// (`.segs.json`, atomar via tmp+rename → crash-sicher wie auf dem Server).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct IncrementalState {
    pub segments: Vec<Segment>,
    pub last_window: usize,
    pub usable: bool,
    pub finalized: bool,
    #[serde(skip)]
    failed: bool,
}

impl IncrementalState {
    pub fn new() -> Self {
        Self { usable: true, ..Default::default() }
    }

    /// Während der Aufnahme zyklisch aufrufen: transkribiert alle NEU fertig
    /// gewordenen Fenster. Gibt die Zahl neuer Segmente zurück.
    pub fn step(&mut self, store: &PcmReader, t: &mut dyn WindowTranscriber) -> usize {
        if self.finalized {
            return 0;
        }
        let ready = ready_windows(store.total_samples());
        if ready <= self.last_window {
            return 0;
        }
        let (new, failed) = transcribe_windows(store, t, self.last_window, Some(ready));
        let n = new.len();
        self.segments.extend(new);
        self.last_window = ready;
        if failed {
            self.failed = true;
            self.usable = false;
        }
        n
    }

    /// Aufnahme-Ende: Rest-Fenster (inkl. Anbruch) transkribieren + final markieren.
    pub fn finalize(&mut self, store: &PcmReader, t: &mut dyn WindowTranscriber) {
        if self.finalized {
            return;
        }
        let (new, failed) = transcribe_windows(store, t, self.last_window, None);
        self.segments.extend(new);
        if failed {
            self.failed = true;
            self.usable = false;
        }
        self.finalized = true;
    }

    pub fn write_manifest(&self, path: &std::path::Path) -> std::io::Result<()> {
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(self)?)?;
        std::fs::rename(&tmp, path)
    }

    pub fn load_manifest(path: &std::path::Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministischer Fake: meldet pro Fenster ein Segment am Fensteranfang
    /// (landet bei idx>0 im linken Kontext → muss gefiltert werden), eines im
    /// Core mit Wörtern und merkt sich die empfangenen Sample-Zahlen.
    struct Fake {
        calls: Vec<usize>,
        fail_on_call: Option<usize>,
    }

    impl WindowTranscriber for Fake {
        fn transcribe(&mut self, samples: &[f32]) -> anyhow::Result<Vec<RawSeg>> {
            self.calls.push(samples.len());
            if self.fail_on_call == Some(self.calls.len()) {
                anyhow::bail!("kaputt");
            }
            Ok(vec![
                RawSeg { start: 1.0, end: 2.0, text: "kontext".into(), words: vec![] },
                RawSeg {
                    start: 20.0,
                    end: 22.0,
                    text: " core hallo".into(),
                    words: vec![RawWord { start: 20.0, end: 21.0, word: " core".into() }],
                },
            ])
        }
    }

    /// `name` MUSS pro Test eindeutig sein — cargo test läuft parallel,
    /// ein geteiltes Verzeichnis wäre eine Datei-Race zwischen den Tests.
    fn store_with_seconds(name: &str, secs: usize) -> (PcmReader, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("echo-incr-test-{name}"));
        let path = dir.join("audio.pcm");
        let mut w = super::super::pcm_store::PcmWriter::create(&path).unwrap();
        w.append_i16(&vec![1000i16; secs * SR]).unwrap();
        w.flush().unwrap();
        (PcmReader::new(&path), dir)
    }

    #[test]
    fn ready_windows_mirrors_server() {
        assert_eq!(ready_windows(0), 0);
        assert_eq!(ready_windows(((SEG_S + CTX_S) * SR) as u64 - 1), 0);
        assert_eq!(ready_windows(((SEG_S + CTX_S) * SR) as u64), 1);
        assert_eq!(ready_windows((2 * SEG_S * SR) as u64), 1);
        assert_eq!(ready_windows(((2 * SEG_S + CTX_S) * SR) as u64), 2);
    }

    #[test]
    fn windowing_offsets_filter_and_tail() {
        // 11 Minuten → 2 fertige Fenster + Rest
        let (st, dir) = store_with_seconds("windowing", 660);
        let mut fake = Fake { calls: vec![], fail_on_call: None };
        let mut inc = IncrementalState::new();

        let n = inc.step(&st, &mut fake);
        assert_eq!(inc.last_window, 2);
        // Fenster 0: kein linker Kontext → BEIDE Segmente im Core (1.0 + 20.0);
        // Fenster 1: Segment bei 1.0 liegt im linken Kontext → gefiltert
        assert_eq!(n, 3);
        // Fenster 0: 315 s, Fenster 1: 330 s
        assert_eq!(fake.calls, vec![(SEG_S + CTX_S) * SR, (CTX_S + SEG_S + CTX_S) * SR]);
        // globale Zeiten: Fenster 1 core_start=300, left=15 → woff=285 → 20.0 → 305.0
        let s = &inc.segments;
        assert_eq!((s[0].start, s[1].start, s[2].start), (1.0, 20.0, 305.0));
        assert_eq!(s[2].end, 307.0);
        let w = s[2].words.as_ref().unwrap();
        assert_eq!((w[0].start, w[0].end), (305.0, 306.0));
        assert_eq!(s[1].text, "core hallo"); // getrimmt
        assert!(s[1].energy.unwrap() > 999.0 && s[1].energy.unwrap() < 1001.0); // int16-RMS

        // step ohne neue Daten = no-op
        assert_eq!(inc.step(&st, &mut fake), 0);

        // finalize transkribiert den Rest (Fenster 2, angebrochen)
        inc.finalize(&st, &mut fake);
        assert!(inc.finalized && inc.usable);
        assert_eq!(fake.calls.len(), 3);
        // Fenster 2: left=15, verfügbar 660-585=75 s
        assert_eq!(fake.calls[2], (660 - (2 * SEG_S - CTX_S)) * SR);

        // Manifest-Roundtrip
        let mp = dir.join("audio.segs.json");
        inc.write_manifest(&mp).unwrap();
        let back = IncrementalState::load_manifest(&mp).unwrap();
        assert_eq!(back.segments.len(), inc.segments.len());
        assert!(back.finalized && back.usable);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn window_failure_marks_unusable() {
        let (st, dir) = store_with_seconds("failure", 660);
        let mut fake = Fake { calls: vec![], fail_on_call: Some(2) };
        let mut inc = IncrementalState::new();
        inc.step(&st, &mut fake);
        assert!(!inc.usable);
        assert!(inc.segments.iter().any(|s| s.text == FAIL_TEXT));
        std::fs::remove_dir_all(&dir).ok();
    }
}

