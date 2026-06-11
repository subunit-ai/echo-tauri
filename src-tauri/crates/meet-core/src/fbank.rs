//! Kaldi-kompatible Fbank-Features — exakter Nachbau von
//! `torchaudio.compliance.kaldi.fbank` mit den wespeakerruntime-Parametern
//! (80 Mel, 25/10 ms, dither 0, Hamming, preemph 0.97, remove_dc_offset,
//! snip_edges, use_energy=false, low 20 Hz, high Nyquist) + CMN.
//! Eingabe: Samples in int16-Skala (torchaudio lädt [-1,1] und multipliziert
//! mit 32768 — netto die rohen s16-Werte als f32), 16 kHz mono.
//! Paritäts-Test gegen die Python-Referenz: `tests/embedder_parity.rs`.

use rustfft::{num_complex::Complex, FftPlanner};

pub const SAMPLE_RATE: usize = 16000;
pub const NUM_BINS: usize = 80;
const FRAME_LEN: usize = 400; // 25 ms
const FRAME_SHIFT: usize = 160; // 10 ms
const FFT_SIZE: usize = 512; // round_to_power_of_two(400)
const LOW_FREQ: f32 = 20.0;
const PREEMPH: f32 = 0.97;
const EPS: f32 = 1.192_092_9e-7; // torch.finfo(float32).eps

fn mel(f: f32) -> f32 {
    1127.0 * (1.0 + f / 700.0).ln()
}

/// Kaldi-Mel-Filterbank (80 × 257); letzte FFT-Bin-Spalte ist 0
/// (torchaudio padded die Bank von 256 auf 257 mit einer Null-Spalte).
fn mel_banks() -> Vec<Vec<f32>> {
    let nyquist = SAMPLE_RATE as f32 / 2.0;
    let fft_bin_width = SAMPLE_RATE as f32 / FFT_SIZE as f32;
    let mel_low = mel(LOW_FREQ);
    let delta = (mel(nyquist) - mel_low) / (NUM_BINS + 1) as f32;
    (0..NUM_BINS)
        .map(|i| {
            let left = mel_low + i as f32 * delta;
            let center = left + delta;
            let right = center + delta;
            (0..FFT_SIZE / 2 + 1)
                .map(|j| {
                    if j == FFT_SIZE / 2 {
                        return 0.0;
                    }
                    let m = mel(fft_bin_width * j as f32);
                    ((m - left) / delta).min((right - m) / delta).max(0.0)
                })
                .collect()
        })
        .collect()
}

/// Log-Mel-Fbank ohne CMN. Gibt `[T][80]` zurück (leer wenn < 1 Frame).
/// Bewusste Abweichung von torchaudio (Codex P2): < 400 Samples asserten dort,
/// hier leer zurück — `Embedder` mappt das defensiv auf „kein Embedding".
pub fn fbank(samples: &[f32]) -> Vec<Vec<f32>> {
    if samples.len() < FRAME_LEN {
        return Vec::new();
    }
    let num_frames = 1 + (samples.len() - FRAME_LEN) / FRAME_SHIFT;
    let window: Vec<f32> = (0..FRAME_LEN)
        .map(|n| {
            0.54 - 0.46 * (2.0 * std::f32::consts::PI * n as f32 / (FRAME_LEN - 1) as f32).cos()
        })
        .collect();
    let banks = mel_banks();
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
    let mut buf = vec![Complex::new(0.0f32, 0.0); FFT_SIZE];
    let mut out = Vec::with_capacity(num_frames);
    for m in 0..num_frames {
        let fr = &samples[m * FRAME_SHIFT..m * FRAME_SHIFT + FRAME_LEN];
        // Reihenfolge wie torchaudio _get_window: dc-offset → preemph → window → pad
        let mean = fr.iter().sum::<f32>() / FRAME_LEN as f32;
        let mut x: Vec<f32> = fr.iter().map(|v| v - mean).collect();
        let mut prev = x[0]; // x[-1] := x[0] (replicate-Pad)
        for v in x.iter_mut() {
            let cur = *v;
            *v = cur - PREEMPH * prev;
            prev = cur;
        }
        for i in 0..FFT_SIZE {
            buf[i] = Complex::new(if i < FRAME_LEN { x[i] * window[i] } else { 0.0 }, 0.0);
        }
        fft.process(&mut buf);
        let power: Vec<f32> = buf[..FFT_SIZE / 2 + 1].iter().map(|c| c.norm_sqr()).collect();
        out.push(
            banks
                .iter()
                .map(|b| {
                    b.iter().zip(&power).map(|(w, p)| w * p).sum::<f32>().max(EPS).ln()
                })
                .collect(),
        );
    }
    out
}

/// Fbank + CMN (Mittelwert pro Mel-Bin über die Zeit abziehen, ohne CVN) —
/// das Feature-Format, das das wespeaker-ONNX erwartet.
pub fn fbank_cmn(samples: &[f32]) -> Vec<Vec<f32>> {
    let mut feats = fbank(samples);
    let t = feats.len();
    if t == 0 {
        return feats;
    }
    for j in 0..NUM_BINS {
        let mean = feats.iter().map(|r| r[j]).sum::<f32>() / t as f32;
        for r in feats.iter_mut() {
            r[j] -= mean;
        }
    }
    feats
}
