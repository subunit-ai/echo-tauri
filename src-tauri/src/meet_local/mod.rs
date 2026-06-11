//! Lokales Meet-Backend (Pro-Feature): die Pod-Pipeline des Servers —
//! Whisper-Transkription, Stimm-Check-In und Sprecher-Diarisierung — läuft
//! hier komplett auf dem Gerät (M1 Mac & Co.), für Offline-Meetings und
//! Netz-Abbruch-Resilienz.
//!
//! Die Diarisierungs-Logik selbst lebt NICHT hier, sondern in der geteilten
//! `meet-core`-Crate (vendored aus subunit-ai/meet-core, identisch zur
//! Python-Pipeline des Servers — Golden-Replay-getestet). Dieses Modul ist
//! die Geräte-Seite drumherum; die Bausteine landen schrittweise hier:
//!   1. ✅ Naming-Kette + Check-In-Digits (meet-core, GT-validiert)
//!   2. ✅ wespeaker-Voiceprints via ort in meet-core (dieselbe ONNX-Datei wie
//!      der Server → numerische Parität; Feature `embedder`, hier noch aus)
//!   3. ✅ Disk-Streaming-PCM (`pcm_store`, byte-identisch zum Server-Sidecar)
//!      + inkrementelle Fenster-Transkription (`incremental`, Port der
//!      Server-Windowing-Semantik) + whisper.cpp-Adapter mit Token→Wort-
//!      Timestamps (`whisper_window`, Feature `local-whisper`)
//!   4. ⏳ Host-zentrierter Offline-Check-In (Zahl auf dem Host-Schirm,
//!      lokales Whisper + digits-Match — kein QR nötig) + UI/Command-Wiring

// dead_code: bis Baustein 4 (Command-/UI-Wiring) gibt es noch keinen
// Laufzeit-Konsumenten — die Module sind über ihre Tests abgedeckt.
#[allow(dead_code)]
pub mod incremental;
#[allow(dead_code)]
pub mod pcm_store;
#[cfg(feature = "local-whisper")]
#[allow(dead_code)]
pub mod whisper_window;

// Bis das Command-/UI-Wiring (Baustein 4) die Pipeline konsumiert, sind die
// Re-Exports das stabile Interface der Kette.
#[allow(unused_imports)]
pub use meet_core::{digits_from_text, name_segments, spoken_code_matches, Anchors, Segment, Word};

/// Version der gebundelten Diarisierungs-Schwellen (PARAMS.json aus meet-core).
/// Muss zur Server-Seite passen, wenn Ergebnisse verglichen/gemerged werden.
#[allow(dead_code)]
pub fn core_params_version() -> &'static str {
    &meet_core::params().version
}

#[cfg(test)]
mod tests {
    #[test]
    fn core_is_wired() {
        assert!(!super::core_params_version().is_empty());
        assert_eq!(super::digits_from_text("drei zwei sechs"), "326");
    }
}
