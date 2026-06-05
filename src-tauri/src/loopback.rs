//! System-audio loopback capture — the "other side" of a meeting (what comes OUT
//! of the speakers: the remote Teams/Zoom/Meet participants). Echo's `recorder.rs`
//! already captures the local MIC; for a real meeting transcript we also need this
//! render-endpoint loopback, then we mix the two.
//!
//! Windows: WASAPI loopback via the `wasapi` crate (render endpoint + capture
//! direction → the crate sets AUDCLNT_STREAMFLAGS_LOOPBACK). A worker thread reads
//! frames, downmixes to mono f32, and appends to a shared buffer that `snapshot()`
//! clones — mirroring `recorder.rs` so the mixer can treat both the same way.
//! Non-Windows: a stub that yields nothing (macOS loopback is a later follow-up).

#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;

/// A clone of the system audio captured so far (mono f32 at the device rate).
pub struct LoopbackCapture {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

/// Live system-audio loopback capturer. Holds a worker thread until dropped/stopped.
pub struct SystemLoopback {
    buf: Arc<Mutex<Vec<f32>>>,
    sample_rate: Arc<Mutex<u32>>,
    running: Arc<AtomicBool>,
    #[cfg(windows)]
    handle: Option<std::thread::JoinHandle<()>>,
}

impl SystemLoopback {
    /// Snapshot the audio captured so far WITHOUT stopping (the mixer polls this,
    /// like `recorder.snapshot()`).
    pub fn snapshot(&self) -> LoopbackCapture {
        LoopbackCapture {
            samples: self.buf.lock().clone(),
            sample_rate: *self.sample_rate.lock(),
        }
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        #[cfg(windows)]
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for SystemLoopback {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
pub fn start() -> anyhow::Result<SystemLoopback> {
    use wasapi::{
        get_default_device, initialize_mta, Direction, SampleType, ShareMode,
    };

    let buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let sample_rate = Arc::new(Mutex::new(48_000u32));
    let running = Arc::new(AtomicBool::new(true));

    let buf_t = buf.clone();
    let sr_t = sample_rate.clone();
    let run_t = running.clone();

    let handle = std::thread::spawn(move || {
        if let Err(e) = capture_loop(buf_t, sr_t, run_t) {
            log::warn!("loopback: capture loop ended: {e}");
        }
        // keep types referenced so an unused-import warning doesn't turn into a feature-gate surprise
        let _ = (
            std::any::type_name::<Direction>(),
            std::any::type_name::<SampleType>(),
            std::any::type_name::<ShareMode>(),
        );
        let _ = (get_default_device, initialize_mta);
    });

    Ok(SystemLoopback {
        buf,
        sample_rate,
        running,
        handle: Some(handle),
    })
}

#[cfg(windows)]
fn capture_loop(
    buf: Arc<Mutex<Vec<f32>>>,
    sample_rate: Arc<Mutex<u32>>,
    running: Arc<AtomicBool>,
) -> anyhow::Result<()> {
    use std::collections::VecDeque;
    use wasapi::{get_default_device, initialize_mta, Direction, SampleType, ShareMode};

    initialize_mta().ok();

    // Render endpoint + Capture direction = loopback (the crate sets the LOOPBACK flag).
    let device = get_default_device(&Direction::Render)
        .map_err(|e| anyhow::anyhow!("loopback: no render device: {e}"))?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| anyhow::anyhow!("loopback: get_iaudioclient: {e}"))?;

    let format = audio_client
        .get_mixformat()
        .map_err(|e| anyhow::anyhow!("loopback: get_mixformat: {e}"))?;
    let channels = format.get_nchannels() as usize;
    let bits = format.get_bitspersample() as usize;
    let block_align = format.get_blockalign() as usize;
    let sample_type = format.get_subformat().unwrap_or(SampleType::Float);
    *sample_rate.lock() = format.get_samplespersec();

    let (_def, min_period) = audio_client
        .get_periods()
        .map_err(|e| anyhow::anyhow!("loopback: get_periods: {e}"))?;
    audio_client
        .initialize_client(&format, min_period, &Direction::Capture, &ShareMode::Shared, false)
        .map_err(|e| anyhow::anyhow!("loopback: initialize_client: {e}"))?;

    let h_event = audio_client
        .set_get_eventhandle()
        .map_err(|e| anyhow::anyhow!("loopback: set_get_eventhandle: {e}"))?;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| anyhow::anyhow!("loopback: get_audiocaptureclient: {e}"))?;
    audio_client
        .start_stream()
        .map_err(|e| anyhow::anyhow!("loopback: start_stream: {e}"))?;

    let mut raw: VecDeque<u8> = VecDeque::new();
    while running.load(Ordering::SeqCst) {
        if h_event.wait_for_event(200).is_err() {
            continue; // timeout → re-check the running flag
        }
        capture_client
            .read_from_device_to_deque(&mut raw)
            .map_err(|e| anyhow::anyhow!("loopback: read: {e}"))?;
        // Convert raw interleaved frames → mono f32 (average channels).
        let mut mono = Vec::with_capacity(raw.len() / block_align.max(1));
        while raw.len() >= block_align {
            let mut frame: Vec<u8> = Vec::with_capacity(block_align);
            for _ in 0..block_align {
                frame.push(raw.pop_front().unwrap());
            }
            let mut acc = 0.0f32;
            let bytes_per_sample = (bits / 8).max(1);
            for ch in 0..channels {
                let off = ch * bytes_per_sample;
                acc += sample_to_f32(&frame[off..off + bytes_per_sample], bits, sample_type);
            }
            mono.push(acc / channels.max(1) as f32);
        }
        if !mono.is_empty() {
            buf.lock().extend_from_slice(&mono);
        }
    }
    let _ = audio_client.stop_stream();
    Ok(())
}

/// Decode one PCM sample (little-endian) of the given bit depth/type to f32 [-1,1].
#[cfg(windows)]
fn sample_to_f32(bytes: &[u8], bits: usize, ty: wasapi::SampleType) -> f32 {
    match (ty, bits) {
        (wasapi::SampleType::Float, 32) => {
            f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
        }
        (_, 16) => i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0,
        (_, 32) => i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / 2_147_483_648.0,
        _ => 0.0,
    }
}

#[cfg(not(windows))]
pub fn start() -> anyhow::Result<SystemLoopback> {
    anyhow::bail!("system loopback capture is only implemented on Windows")
}
