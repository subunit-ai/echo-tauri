//! Disk-Streaming-PCM — s16le, 16 kHz, mono, BYTE-IDENTISCH zum PCM-Sidecar
//! des Servers (echo-server meet_incremental.Sidecar). Ersetzt den RAM-Buffer
//! des Diktat-Recorders für Meetings (kein 30-Min-Limit mehr).
//!
//! Bewusst in Writer und Reader GETRENNT (Codex P1): der Capture-Thread
//! besitzt den `PcmWriter` exklusiv (kein Mutex im Audio-Pfad), die Engine
//! liest über den lock-freien `PcmReader` (eigenes File-Handle pro Read,
//! Stand = geflushte Bytes). Whisper-Läufe können so NIE die Aufnahme stauen.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const SR: usize = 16_000;

/// Auto-Flush-Schwelle: Reader sehen die Aufnahme mit max. ~0,5 s Verzögerung.
const FLUSH_EVERY_SAMPLES: u64 = (SR / 2) as u64;

pub struct PcmWriter {
    path: PathBuf,
    writer: BufWriter<File>,
    written: u64,
    since_flush: u64,
}

impl PcmWriter {
    /// Neue Aufnahme — legt die Datei an (truncate).
    pub fn create(path: &Path) -> std::io::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let f = OpenOptions::new().create(true).write(true).truncate(true).open(path)?;
        Ok(Self { path: path.to_path_buf(), writer: BufWriter::new(f), written: 0, since_flush: 0 })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append_i16(&mut self, samples: &[i16]) -> std::io::Result<()> {
        let mut buf = Vec::with_capacity(samples.len() * 2);
        for s in samples {
            buf.extend_from_slice(&s.to_le_bytes());
        }
        self.writer.write_all(&buf)?;
        self.written += samples.len() as u64;
        self.since_flush += samples.len() as u64;
        if self.since_flush >= FLUSH_EVERY_SAMPLES {
            self.flush()?;
        }
        Ok(())
    }

    /// f32 [-1,1] (cpal/Resampler-Ausgabe) → s16 wie der Browser-Encoder.
    pub fn append_f32(&mut self, samples: &[f32]) -> std::io::Result<()> {
        let conv: Vec<i16> = samples
            .iter()
            .map(|&x| (x * 32768.0).round().clamp(-32768.0, 32767.0) as i16)
            .collect();
        self.append_i16(&conv)
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        self.since_flush = 0;
        self.writer.flush()
    }

    pub fn total_samples(&self) -> u64 {
        self.written
    }
}

/// Lock-freier Lesezugriff auf eine PCM-Datei. `Clone`-bar (nur der Pfad);
/// jeder Read öffnet ein eigenes Handle. Sichtbar ist der GEFLUSHTE Stand —
/// bei laufender Aufnahme max. ~0,5 s hinter dem Mic (für 5-Min-Fenster und
/// 8-s-Check-In-Clips irrelevant; die Aufrufer warten ohnehin auf Dauer).
#[derive(Clone)]
pub struct PcmReader {
    path: PathBuf,
}

impl PcmReader {
    pub fn new(path: &Path) -> Self {
        Self { path: path.to_path_buf() }
    }

    /// Geflushte Samples (Datei-Größe / 2).
    pub fn total_samples(&self) -> u64 {
        std::fs::metadata(&self.path).map(|m| m.len() / 2).unwrap_or(0)
    }

    pub fn duration_s(&self) -> f64 {
        self.total_samples() as f64 / SR as f64
    }

    /// Liest bis zu `n` Samples ab `start_sample`; kürzer am Dateiende —
    /// wie der `f.read`-Pfad des Servers.
    pub fn read_samples(&self, start_sample: u64, n: usize) -> std::io::Result<Vec<i16>> {
        let mut f = File::open(&self.path)?;
        f.seek(SeekFrom::Start(start_sample * 2))?;
        let mut buf = vec![0u8; n * 2];
        let mut read = 0usize;
        while read < buf.len() {
            match f.read(&mut buf[read..])? {
                0 => break,
                k => read += k,
            }
        }
        buf.truncate(read - read % 2);
        Ok(buf.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect())
    }

    /// Zeit-Slice in Sekunden — das Eingabeformat des Voiceprint-Embedders
    /// (meet-core `Embedder`, int16-Skala).
    pub fn read_slice_s(&self, start_s: f64, end_s: f64) -> std::io::Result<Vec<i16>> {
        let a = (start_s.max(0.0) * SR as f64) as u64;
        let b = (end_s.max(0.0) * SR as f64) as u64;
        if b <= a {
            return Ok(Vec::new());
        }
        self.read_samples(a, (b - a) as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_slices() {
        let dir = std::env::temp_dir().join("echo-pcm-store-test");
        let path = dir.join("audio.pcm");
        let mut w = PcmWriter::create(&path).unwrap();
        let r = PcmReader::new(&path);
        // 2 s Rampe: sample i hat Wert (i % 1000)
        let samples: Vec<i16> = (0..2 * SR).map(|i| (i % 1000) as i16).collect();
        w.append_i16(&samples).unwrap();
        w.flush().unwrap();
        assert_eq!(w.total_samples(), 2 * SR as u64);
        assert_eq!(r.total_samples(), 2 * SR as u64);
        assert!((r.duration_s() - 2.0).abs() < 1e-9);

        let mid = r.read_samples(SR as u64, 100).unwrap();
        assert_eq!(mid, &samples[SR..SR + 100]);
        // über das Ende hinaus → gekürzt statt Fehler
        let tail = r.read_samples((2 * SR - 50) as u64, 100).unwrap();
        assert_eq!(tail.len(), 50);
        // Zeit-Slice
        let sl = r.read_slice_s(0.5, 0.75).unwrap();
        assert_eq!(sl.len(), SR / 4);
        assert_eq!(sl[0], samples[SR / 2]);
        // f32-Append quantisiert wie erwartet
        w.append_f32(&[0.5, -1.5]).unwrap();
        w.flush().unwrap();
        let q = r.read_samples(2 * SR as u64, 2).unwrap();
        assert_eq!(q, vec![16384, -32768]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reader_sees_only_flushed_data() {
        let dir = std::env::temp_dir().join("echo-pcm-flush-test");
        let path = dir.join("audio.pcm");
        let mut w = PcmWriter::create(&path).unwrap();
        let r = PcmReader::new(&path);
        w.append_i16(&[1i16; 100]).unwrap(); // unter der Flush-Schwelle
        assert_eq!(r.total_samples(), 0);
        w.flush().unwrap();
        assert_eq!(r.total_samples(), 100);
        // Auto-Flush ab 0,5 s
        w.append_i16(&vec![2i16; SR / 2]).unwrap();
        assert_eq!(r.total_samples(), 100 + (SR / 2) as u64);
        std::fs::remove_dir_all(&dir).ok();
    }
}
