//! Streaming-Mic-Capture für lokale Meetings: cpal → kontinuierlicher
//! 16k-Resampler → PcmStore auf Platte. Im Gegensatz zum Diktat-`Recorder`
//! (RAM-Buffer, 30-Min-Cap) ist das unbegrenzt — Meetings sind lang.
//!
//! Thread-Modell wie `recorder.rs`: der cpal-`Stream` ist `!Send`, also
//! besitzt ihn ein Worker-Thread; der Audio-Callback schickt Mono-Chunks per
//! Channel, der Worker resampelt MIT Positions-Carry über Chunk-Grenzen
//! (sonst Knackser alle ~10 ms) und appendet in den Store.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender, SyncSender, TrySendError};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::pcm_store::PcmWriter;

/// Bounded Chunk-Queue (Codex P1): der Audio-Callback darf NIE blockieren und
/// der Speicher NIE unbegrenzt wachsen. cpal liefert ~10-50-ms-Chunks; 2048
/// Einträge ≈ deutlich über eine Minute Puffer. Läuft sie voll (Disk hängt),
/// wird der Chunk verworfen + die Aufnahme als fehlerhaft markiert — wie die
/// Server-Sidecar-Queue (überlaufen → "incremental incomplete").
const CHUNK_QUEUE_MAX: usize = 2048;

const SR_OUT: f64 = 16_000.0;

/// Linear-Resampler mit persistentem Zustand über Chunk-Grenzen: merkt sich
/// die fraktionale Leseposition + das letzte Sample des vorigen Chunks.
pub struct StreamingResampler {
    ratio: f64, // in_sr / 16000
    pos: f64,   // Leseposition relativ zum aktuellen Chunk-Anfang (kann <0 via prev)
    prev: Option<f32>,
}

impl StreamingResampler {
    pub fn new(in_sr: u32) -> Self {
        Self { ratio: in_sr as f64 / SR_OUT, pos: 0.0, prev: None }
    }

    pub fn push(&mut self, chunk: &[f32]) -> Vec<f32> {
        if chunk.is_empty() {
            return Vec::new();
        }
        if (self.ratio - 1.0).abs() < 1e-12 && self.prev.is_none() {
            return chunk.to_vec();
        }
        let mut out = Vec::with_capacity((chunk.len() as f64 / self.ratio) as usize + 2);
        // Index -1 = letztes Sample des vorigen Chunks
        let at = |i: i64| -> f32 {
            if i < 0 {
                self.prev.unwrap_or(chunk[0])
            } else {
                chunk[(i as usize).min(chunk.len() - 1)]
            }
        };
        while self.pos < (chunk.len() - 1) as f64 || (self.prev.is_some() && self.pos < 0.0) {
            let i0 = self.pos.floor();
            let frac = (self.pos - i0) as f32;
            let a = at(i0 as i64);
            let b = at(i0 as i64 + 1);
            out.push(a + (b - a) * frac);
            self.pos += self.ratio;
        }
        // Position auf den nächsten Chunk umrechnen
        self.pos -= chunk.len() as f64;
        self.prev = chunk.last().copied();
        out
    }
}

pub struct MeetCapture {
    stop_tx: Sender<()>,
    join: Option<std::thread::JoinHandle<()>>,
    level: Arc<AtomicU32>,
    pub failed: Arc<AtomicBool>,
}

impl MeetCapture {
    /// Startet die Aufnahme in den exklusiv übernommenen `writer`. Blockiert
    /// bis der Stream läuft oder liefert eine nutzerlesbare Fehlermeldung
    /// (Muster aus `recorder.rs`).
    pub fn start(device: Option<String>, mut writer: PcmWriter) -> Result<Self, String> {
        let (stop_tx, stop_rx) = channel::<()>();
        let (ready_tx, ready_rx) = channel::<Result<(), String>>();
        let level = Arc::new(AtomicU32::new(0));
        let failed = Arc::new(AtomicBool::new(false));
        let (lvl, fl) = (level.clone(), failed.clone());

        let join = std::thread::Builder::new()
            .name("echo-meet-capture".into())
            .spawn(move || {
                let (chunk_tx, chunk_rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(CHUNK_QUEUE_MAX);
                let (stream, in_sr) = match build_stream(device, lvl, fl.clone(), chunk_tx) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("Mikrofon: {e}")));
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    let _ = ready_tx.send(Err(format!("Mikrofon-Start: {e}")));
                    return;
                }
                let _ = ready_tx.send(Ok(()));
                let mut rs = StreamingResampler::new(in_sr);
                loop {
                    // Stop hat Vorrang; sonst Chunks mit Timeout draven, damit
                    // das Stop-Signal spätestens nach 200 ms greift.
                    if stop_rx.try_recv().is_ok() {
                        break;
                    }
                    match chunk_rx.recv_timeout(std::time::Duration::from_millis(200)) {
                        Ok(chunk) => {
                            let out = rs.push(&chunk);
                            if !out.is_empty() {
                                if writer.append_f32(&out).is_err() {
                                    fl.store(true, Ordering::Relaxed);
                                    break;
                                }
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(_) => break, // Stream weg
                    }
                }
                // Mic freigeben: EXPLIZIT stoppen vor dem Drop — cpal 0.15 hält über
                // seinen Disconnect-Listener einen Stream-Klon in derselben StreamInner
                // (Referenz-Zyklus), sodass drop das AudioUnit nie disposed und das
                // Mikro an bliebe. pause() → AudioOutputUnitStop stoppt die Hardware.
                let _ = stream.pause();
                drop(stream);
                // Rest-Chunks noch einsammeln (Callback könnte vor dem Drop gesendet haben)
                while let Ok(chunk) = chunk_rx.try_recv() {
                    let out = rs.push(&chunk);
                    if !out.is_empty() {
                        let _ = writer.append_f32(&out);
                    }
                }
                let _ = writer.flush();
            })
            .map_err(|e| format!("Capture-Thread: {e}"))?;

        match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self { stop_tx, join: Some(join), level, failed }),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                // Codex P1: ein spät startender Stream darf nicht herrenlos
                // weiter aufnehmen — Stop vorab queuen, dann erst Err.
                let _ = stop_tx.send(());
                Err("Mikrofon-Start hat nicht reagiert.".into())
            }
        }
    }

    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }

    /// Stoppt die Aufnahme und wartet, bis alle Samples im Store sind.
    pub fn stop(mut self) {
        let _ = self.stop_tx.send(());
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

fn build_stream(
    device_name: Option<String>,
    level: Arc<AtomicU32>,
    failed: Arc<AtomicBool>,
    chunk_tx: SyncSender<Vec<f32>>,
) -> anyhow::Result<(cpal::Stream, u32)> {
    let host = cpal::default_host();
    let device = match device_name {
        Some(name) if !name.is_empty() && name != "System Default" => host
            .input_devices()?
            .find(|d| d.name().map(|n| n == name).unwrap_or(false))
            .or_else(|| host.default_input_device())
            .ok_or_else(|| anyhow::anyhow!("no input device"))?,
        _ => host
            .default_input_device()
            .ok_or_else(|| anyhow::anyhow!("no default input device"))?,
    };
    let supported = device.default_input_config()?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let fmt = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let err_fn = |e| log::error!("meet-capture: stream error: {e}");

    macro_rules! stream_as {
        ($t:ty, $conv:expr) => {{
            let (tx, l, fl) = (chunk_tx.clone(), level.clone(), failed.clone());
            device.build_input_stream(
                &config,
                move |data: &[$t], _| {
                    let f: Vec<f32> = data.iter().map($conv).collect();
                    let mono = downmix(&f, channels, &l);
                    // try_send: NIE blockieren; voll = Disk/Engine hängt →
                    // Chunk verwerfen + Aufnahme als fehlerhaft markieren.
                    if let Err(TrySendError::Full(_)) = tx.try_send(mono) {
                        fl.store(true, Ordering::Relaxed);
                    }
                },
                err_fn,
                None,
            )?
        }};
    }
    let stream = match fmt {
        cpal::SampleFormat::F32 => stream_as!(f32, |s| *s),
        cpal::SampleFormat::I16 => stream_as!(i16, |s| *s as f32 / 32768.0),
        cpal::SampleFormat::U16 => stream_as!(u16, |s| (*s as f32 - 32768.0) / 32768.0),
        other => anyhow::bail!("unsupported sample format: {other:?}"),
    };
    Ok((stream, sample_rate))
}

/// Mono-Downmix + RMS-Level (wie `recorder::ingest`, nur ohne Buffer).
fn downmix(data: &[f32], channels: usize, level: &Arc<AtomicU32>) -> Vec<f32> {
    let mono: Vec<f32> = if channels <= 1 {
        data.to_vec()
    } else {
        data.chunks_exact(channels)
            .map(|f| f.iter().sum::<f32>() / channels as f32)
            .collect()
    };
    if !mono.is_empty() {
        let rms = (mono.iter().map(|s| s * s).sum::<f32>() / mono.len() as f32).sqrt();
        level.store(((rms * 4.0).min(1.0)).to_bits(), Ordering::Relaxed);
    }
    mono
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_passthrough_at_16k() {
        let mut rs = StreamingResampler::new(16_000);
        let a = rs.push(&[0.1, 0.2, 0.3]);
        assert_eq!(a, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn resampler_chunked_equals_oneshot() {
        // Kontinuität: 48k→16k in einem Stück vs. in 7 ungleichen Chunks
        let sr = 48_000u32;
        let sig: Vec<f32> = (0..sr as usize).map(|i| (i as f32 * 0.001).sin()).collect();
        let mut one = StreamingResampler::new(sr);
        let whole = one.push(&sig);
        let mut chunked = StreamingResampler::new(sr);
        let mut out = Vec::new();
        let cuts = [0usize, 7, 1000, 1001, 20_000, 20_001, 30_000, sr as usize];
        for w in cuts.windows(2) {
            out.extend(chunked.push(&sig[w[0]..w[1]]));
        }
        // gleiche Länge ±1 und punktweise nahezu identisch
        assert!((whole.len() as i64 - out.len() as i64).abs() <= 1);
        let n = whole.len().min(out.len());
        let maxd = whole[..n]
            .iter()
            .zip(&out[..n])
            .map(|(x, y)| (x - y).abs())
            .fold(0.0f32, f32::max);
        assert!(maxd < 1e-4, "Chunk-Grenzen erzeugen Artefakte: {maxd}");
        // Länge ≈ 1/3
        assert!((out.len() as f64 - sr as f64 / 3.0).abs() < 3.0);
    }
}
