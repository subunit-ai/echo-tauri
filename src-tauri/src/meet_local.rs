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
//!   2. ⏳ wespeaker-Voiceprints via ort (dieselbe ONNX-Datei wie der Server
//!      → numerische Parität, validierte Schwellen gelten unverändert)
//!   3. ⏳ inkrementelle whisper.cpp-Transkription mit Token-Timestamps
//!   4. ⏳ Host-zentrierter Offline-Check-In (Zahl auf dem Host-Schirm,
//!      lokales Whisper + digits-Match — kein QR nötig)

// Bis Baustein 2 (ort-Embedder) verdrahtet ist, konsumiert noch kein
// Laufzeitpfad die Kette — die Re-Exports sind das stabile Interface dafür.
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
