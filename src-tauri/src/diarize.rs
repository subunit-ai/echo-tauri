//! Speaker diarization for long-form recordings (port of diarization_client.py).
//!
//! POST the same WAV to `/v1/diarize` → speaker time-segments
//! `{start_s, end_s, speaker}`. The server does NOT merge with the transcript;
//! we overlap-merge here against the Whisper [`Segment`]s and format a
//! speaker-tagged transcript. Best-effort: returns None on any failure.

use std::time::Duration;

use crate::config::Config;
use crate::transcribe::Segment;

struct SpeakerSpan {
    start_s: f64,
    end_s: f64,
    speaker: String,
}

/// POST the WAV to /v1/diarize and return the speaker spans (None on any error).
fn diarize(cfg: &Config, wav: Vec<u8>, max_speakers: i32) -> Option<Vec<SpeakerSpan>> {
    let url = cfg
        .subunit_endpoint
        .replace("/v1/transcribe", "/v1/diarize");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .ok()?;
    let part = reqwest::blocking::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .ok()?;
    let form = reqwest::blocking::multipart::Form::new()
        .part("file", part)
        .text("max_speakers", max_speakers.to_string());
    let mut req = client.post(&url).multipart(form);
    if !cfg.subunit_access_token.is_empty() {
        req = req.bearer_auth(&cfg.subunit_access_token);
    } else if !cfg.subunit_api_key.is_empty() {
        req = req.header("X-API-Key", cfg.subunit_api_key.clone());
    }
    let resp = req.send().ok()?;
    if !resp.status().is_success() {
        log::warn!("diarize HTTP {}", resp.status());
        return None;
    }
    let json: serde_json::Value = resp.json().ok()?;
    let spans: Vec<SpeakerSpan> = json
        .get("segments")?
        .as_array()?
        .iter()
        .map(|s| SpeakerSpan {
            start_s: s.get("start_s").and_then(|v| v.as_f64()).unwrap_or(0.0),
            end_s: s.get("end_s").and_then(|v| v.as_f64()).unwrap_or(0.0),
            speaker: s
                .get("speaker")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string(),
        })
        .collect();
    if spans.is_empty() {
        None
    } else {
        Some(spans)
    }
}

/// Assign each transcript segment to the speaker whose span overlaps it most,
/// then collapse consecutive same-speaker segments into "Speaker N: …" blocks.
fn merge(transcript: &[Segment], speakers: &[SpeakerSpan]) -> String {
    let speaker_at = |seg: &Segment| -> String {
        let mut best = ("?".to_string(), 0.0_f64);
        for sp in speakers {
            let overlap = seg.end_s.min(sp.end_s) - seg.start_s.max(sp.start_s);
            if overlap > best.1 {
                best = (sp.speaker.clone(), overlap);
            }
        }
        best.0
    };

    let mut out = String::new();
    let mut cur_speaker: Option<String> = None;
    for seg in transcript {
        let txt = seg.text.trim();
        if txt.is_empty() {
            continue;
        }
        let sp = speaker_at(seg);
        if cur_speaker.as_deref() != Some(sp.as_str()) {
            if cur_speaker.is_some() {
                out.push_str("\n\n");
            }
            out.push_str(&format!("{}: ", label(&sp)));
            cur_speaker = Some(sp);
        } else {
            out.push(' ');
        }
        out.push_str(txt);
    }
    out
}

/// "SPEAKER_00" / "0" → "Sprecher 1" (1-based, friendlier).
fn label(raw: &str) -> String {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    match digits.parse::<usize>() {
        Ok(n) => format!("Sprecher {}", n + 1),
        Err(_) => format!("Sprecher {raw}"),
    }
}

/// Full flow: diarize the WAV + merge with the transcript segments → a
/// speaker-tagged transcript, or None if diarization wasn't possible.
pub fn speaker_transcript(
    cfg: &Config,
    wav: Vec<u8>,
    transcript: &[Segment],
) -> Option<String> {
    if transcript.is_empty() {
        return None;
    }
    let max = cfg.diarization_max_speakers.clamp(1, 16);
    let speakers = diarize(cfg, wav, max)?;
    let merged = merge(transcript, &speakers);
    if merged.trim().is_empty() {
        None
    } else {
        Some(merged)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_label() {
        assert_eq!(label("SPEAKER_00"), "Sprecher 1");
        assert_eq!(label("SPEAKER_01"), "Sprecher 2");
        assert_eq!(label("0"), "Sprecher 1");
        assert_eq!(label("12"), "Sprecher 13");
        assert_eq!(label("?"), "Sprecher ?");
        assert_eq!(label("unknown"), "Sprecher unknown");
    }

    #[test]
    fn test_merge_basic() {
        let transcript = vec![
            Segment { start_s: 0.0, end_s: 2.0, text: " Hello".to_string() },
            Segment { start_s: 2.0, end_s: 4.0, text: " world.".to_string() },
            Segment { start_s: 4.0, end_s: 6.0, text: " How are you?".to_string() },
        ];
        let speakers = vec![
            SpeakerSpan { start_s: 0.0, end_s: 4.5, speaker: "0".to_string() },
            SpeakerSpan { start_s: 4.5, end_s: 6.0, speaker: "1".to_string() },
        ];

        let result = merge(&transcript, &speakers);
        assert_eq!(result, "Sprecher 1: Hello world.\n\nSprecher 2: How are you?");
    }

    #[test]
    fn test_merge_overlap() {
        let transcript = vec![
            // Overlaps "0" by 1.0s and "1" by 3.0s -> should pick "1"
            Segment { start_s: 0.0, end_s: 4.0, text: " I span two speakers.".to_string() },
        ];
        let speakers = vec![
            SpeakerSpan { start_s: 0.0, end_s: 1.0, speaker: "0".to_string() },
            SpeakerSpan { start_s: 1.0, end_s: 4.0, speaker: "1".to_string() },
        ];

        let result = merge(&transcript, &speakers);
        assert_eq!(result, "Sprecher 2: I span two speakers.");
    }

    #[test]
    fn test_merge_empty_segments() {
        let transcript = vec![
            Segment { start_s: 0.0, end_s: 1.0, text: "  ".to_string() },
            Segment { start_s: 1.0, end_s: 2.0, text: " Real text.".to_string() },
        ];
        let speakers = vec![
            SpeakerSpan { start_s: 0.0, end_s: 2.0, speaker: "0".to_string() },
        ];

        let result = merge(&transcript, &speakers);
        assert_eq!(result, "Sprecher 1: Real text.");
    }

    #[test]
    fn test_merge_unassigned() {
        let transcript = vec![
            Segment { start_s: 10.0, end_s: 12.0, text: " Ghost.".to_string() },
        ];
        let speakers = vec![
            SpeakerSpan { start_s: 0.0, end_s: 2.0, speaker: "0".to_string() },
        ];

        let result = merge(&transcript, &speakers);
        // Overlap is negative or 0. speaker_at returns "?"
        assert_eq!(result, "Sprecher ?: Ghost.");
    }
}
