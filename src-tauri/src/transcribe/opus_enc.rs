//! Opus speech compression for cloud uploads. Whisper only needs 16 kHz mono,
//! and the upload (not the GPU) was the latency bottleneck — so we compress the
//! 16 kHz PCM to Opus-in-Ogg (~8× smaller than the WAV, ASR-transparent at this
//! bitrate) and send `audio.ogg`, which the server's ffmpeg path already decodes.
//!
//! Excluded on Windows-ARM (see Cargo.toml) — that target keeps the 16 kHz WAV.
//! Any failure here is non-fatal: the caller falls back to the WAV.

use anyhow::Context;
use audiopus::{coder::Encoder, Application, Bitrate, Channels, SampleRate};
use ogg::writing::{PacketWriteEndInfo, PacketWriter};

// 20 ms frame @ 16 kHz = 320 samples. Opus always presents at 48 kHz, so each
// 20 ms frame advances the granule position by 20 ms × 48 kHz = 960 samples.
const FRAME: usize = 320;
const GRANULE_PER_FRAME: u64 = 960;
// 24 kbit/s is transparent for speech recognition while staying tiny.
const BITRATE: i32 = 24_000;
// Fixed Ogg logical-stream serial (single stream; value is arbitrary).
const SERIAL: u32 = 0x00ec_0a01;

/// Encode 16 kHz mono f32 samples (range -1..1) to an Ogg/Opus byte stream.
pub fn encode_ogg_opus(samples_16k: &[f32]) -> anyhow::Result<Vec<u8>> {
    if samples_16k.is_empty() {
        anyhow::bail!("no samples");
    }
    let mut enc = Encoder::new(SampleRate::Hz16000, Channels::Mono, Application::Voip)
        .context("opus encoder init")?;
    let _ = enc.set_bitrate(Bitrate::BitsPerSecond(BITRATE));

    let pcm: Vec<i16> = samples_16k
        .iter()
        .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
        .collect();

    let mut writer = PacketWriter::new(Vec::<u8>::new());

    // Header pages (RFC 7845): OpusHead (BOS) + OpusTags, each its own page.
    // pre-skip = 0: the decoder won't trim the ~few-ms encoder warmup, which is
    // irrelevant for transcription (Whisper ignores leading silence/warmup).
    writer
        .write_packet(opus_head(1, 0), SERIAL, PacketWriteEndInfo::EndPage, 0)
        .context("write OpusHead")?;
    writer
        .write_packet(opus_tags(), SERIAL, PacketWriteEndInfo::EndPage, 0)
        .context("write OpusTags")?;

    // Audio pages: one Opus packet per 20 ms frame, granulepos accumulating. The
    // final short frame is padded with silence to a full block.
    let mut out = vec![0u8; 4000];
    let mut frame_buf = [0i16; FRAME];
    let total = pcm.len().div_ceil(FRAME);
    let mut granule: u64 = 0;
    for (i, chunk) in pcm.chunks(FRAME).enumerate() {
        let frame: &[i16] = if chunk.len() == FRAME {
            chunk
        } else {
            frame_buf[..chunk.len()].copy_from_slice(chunk);
            frame_buf[chunk.len()..].fill(0);
            &frame_buf
        };
        let n = enc.encode(frame, &mut out).context("opus encode")?;
        granule += GRANULE_PER_FRAME;
        let inf = if i + 1 == total {
            PacketWriteEndInfo::EndStream
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        writer
            .write_packet(out[..n].to_vec(), SERIAL, inf, granule)
            .context("write audio packet")?;
    }

    Ok(writer.into_inner())
}

/// OpusHead identification header (19 bytes, little-endian).
fn opus_head(channels: u8, pre_skip: u16) -> Vec<u8> {
    let mut h = Vec::with_capacity(19);
    h.extend_from_slice(b"OpusHead");
    h.push(1); // version
    h.push(channels);
    h.extend_from_slice(&pre_skip.to_le_bytes());
    h.extend_from_slice(&16_000u32.to_le_bytes()); // input sample rate (informational)
    h.extend_from_slice(&0i16.to_le_bytes()); // output gain
    h.push(0); // channel mapping family 0 (mono/stereo)
    h
}

/// OpusTags comment header (vendor string, zero comments).
fn opus_tags() -> Vec<u8> {
    let vendor = b"echo";
    let mut t = Vec::new();
    t.extend_from_slice(b"OpusTags");
    t.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    t.extend_from_slice(vendor);
    t.extend_from_slice(&0u32.to_le_bytes()); // comment count
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Local-only: reads /tmp/echo-bench.wav (16 kHz mono), encodes Ogg/Opus,
    /// writes /tmp/echo-bench.ogg, and asserts it's much smaller. ffprobe is run
    /// separately to confirm the container decodes (it's not in CI). Ignored
    /// unless the bench file exists.
    #[test]
    fn encodes_bench_wav() {
        let path = "/tmp/echo-bench.wav";
        let Ok(mut r) = hound::WavReader::open(path) else {
            eprintln!("skip: {path} not present");
            return;
        };
        let samples: Vec<f32> = r
            .samples::<i16>()
            .map(|s| s.unwrap_or(0) as f32 / 32768.0)
            .collect();
        let ogg = encode_ogg_opus(&samples).expect("encode");
        let wav_len = samples.len() * 2;
        std::fs::write("/tmp/echo-bench.ogg", &ogg).unwrap();
        eprintln!(
            "WAV(16k) {} bytes → Ogg/Opus {} bytes ({:.1}× kleiner)",
            wav_len,
            ogg.len(),
            wav_len as f64 / ogg.len() as f64
        );
        assert!(&ogg[..4] == b"OggS", "not an Ogg stream");
        assert!(ogg.len() < wav_len / 3, "compression weaker than expected");
    }
}
