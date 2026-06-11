//! meet-core — geteilte Meet-Diarisierungs-Pipeline (Rust-Port).
//!
//! Verhaltensgleich zu `python/meet_core` (echo-server). Konsumenten:
//! Echo-Tauri (`src-tauri/crates/meet-core`, vendored via `sync-meet-core.sh`).
//! Schwellen kommen aus der gebundelten `src/params.json` (= PARAMS.json,
//! einzige Quelle — Änderung = Versions-Bump + Golden-Tests py+rs grün).

mod digits;
mod matching;
mod params;

pub use digits::{digits_from_text, spoken_code_matches};
pub use matching::{name_segments, Anchors, NameResult, NameStats, Segment, Word};
pub use params::{params, Params, PARAMS_JSON};
