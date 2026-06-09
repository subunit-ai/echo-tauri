//! Meeting capture orchestrator (increment 2, the core value).
//!
//! A real meeting transcript needs BOTH sides: the local mic (you) AND the system
//! loopback (the remote Teams/Zoom/Meet participants). This owns a dedicated mic
//! `Recorder` plus a `SystemLoopback`, runs them together, and on stop resamples each
//! to 16 kHz mono and MIXES them into a single track ready for transcription.
//!
//! Kept separate from the dictation recorder in `AppState` so a meeting recording and
//! a hotkey dictation never fight over one capture. The mix/resample math is pure +
//! unit-tested; the device capture is validated by compile (win-check) + Erik's runtime.
//!
//! TODO (next wiring step): feed `stop_and_mix()`'s buffer through the existing
//! transcribe → store-meeting path (commands.rs) and trigger it from MeetingPrompt's
//! "record" instead of the meet.subunit.ai web room.

#![allow(dead_code)]

use crate::loopback::SystemLoopback;
use crate::recorder::Recorder;

const SR: u32 = 16_000;

/// Linear-resample mono f32 from `from_sr` to 16 kHz.
pub fn resample_to_16k(samples: &[f32], from_sr: u32) -> Vec<f32> {
    if from_sr == SR || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = from_sr as f64 / SR as f64;
    let out_len = ((samples.len() as f64) / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 * ratio;
        let i0 = src.floor() as usize;
        let frac = (src - i0 as f64) as f32;
        let a = samples[i0.min(samples.len() - 1)];
        let b = samples[(i0 + 1).min(samples.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

/// Mix two mono tracks (already same sample rate) by summing with a soft clamp to
/// [-1, 1]. Lengths can differ (mic vs loopback drift); the result spans the longer
/// track and the shorter one simply contributes silence past its end.
pub fn mix(a: &[f32], b: &[f32]) -> Vec<f32> {
    let n = a.len().max(b.len());
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let s = a.get(i).copied().unwrap_or(0.0) + b.get(i).copied().unwrap_or(0.0);
        out.push(s.clamp(-1.0, 1.0));
    }
    out
}

/// A live two-source meeting capture. Drop/stop releases both devices.
pub struct MeetingCapture {
    mic: Recorder,
    system: SystemLoopback,
}

impl MeetingCapture {
    /// Start mic + system-loopback capture together. `mic_device` mirrors the
    /// dictation device-picker config (None = system default).
    pub fn start(mic_device: Option<String>) -> Result<Self, String> {
        let system = crate::loopback::start().map_err(|e| format!("loopback: {e}"))?;
        let mic = Recorder::new();
        mic.start(mic_device)?;
        Ok(Self { mic, system })
    }

    /// Stop both captures and return the mixed 16 kHz mono track (+ its sample rate,
    /// always 16000) ready to transcribe.
    pub fn stop_and_mix(mut self) -> (Vec<f32>, u32) {
        let mic_cap = self.mic.stop();
        self.system.stop();
        let sys_cap = self.system.snapshot();

        let mic_16k = mic_cap
            .map(|c| resample_to_16k(&c.samples, c.sample_rate))
            .unwrap_or_default();
        let sys_16k = resample_to_16k(&sys_cap.samples, sys_cap.sample_rate);
        let mixed = mix(&mic_16k, &sys_16k);
        (mixed, SR)
    }
}

#[cfg(test)]
mod tests {
    use super::{mix, resample_to_16k};

    #[test]
    fn resample_passthrough_at_16k() {
        let s = vec![0.1, 0.2, 0.3];
        assert_eq!(resample_to_16k(&s, 16_000), s);
    }

    #[test]
    fn resample_halves_length_from_32k() {
        // 32k → 16k ≈ half the samples.
        let s: Vec<f32> = (0..100).map(|i| i as f32 / 100.0).collect();
        let out = resample_to_16k(&s, 32_000);
        assert!((out.len() as i32 - 50).abs() <= 1, "got {}", out.len());
    }

    #[test]
    fn mix_sums_and_clamps() {
        assert_eq!(mix(&[0.5, 0.5], &[0.5, -0.5]), vec![1.0, 0.0]);
        // overflow is clamped, not wrapped
        assert_eq!(mix(&[0.9], &[0.9]), vec![1.0]);
    }

    #[test]
    fn mix_handles_unequal_lengths() {
        // shorter track contributes silence past its end
        assert_eq!(mix(&[0.2], &[0.1, 0.1, 0.1]), vec![0.3, 0.1, 0.1]);
    }
}
