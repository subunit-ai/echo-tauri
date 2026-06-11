//! Lädt die Diarisierungs-Schwellen aus der zur Compile-Zeit gebundelten
//! `src/params.json` (Kopie von `PARAMS.json` im Repo-Root — der einzigen
//! Quelle). Der Test `bundled_params_match_repo_root` wacht über Drift;
//! `sync-meet-core.sh` (Echo) bzw. `deploy-backend.sh` (Server) syncen.

use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Debug, Clone, Deserialize)]
pub struct MatchParams {
    #[serde(rename = "T")]
    pub t: f64,
    #[serde(rename = "M")]
    pub m: f64,
    #[serde(rename = "MIN_EMB_S")]
    pub min_emb_s: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AdaptParams {
    #[serde(rename = "AD_MARGIN")]
    pub ad_margin: f64,
    #[serde(rename = "AD_DUR")]
    pub ad_dur: f64,
    #[serde(rename = "AD_TOP")]
    pub ad_top: usize,
    #[serde(rename = "AD_MIN_CAND")]
    pub ad_min_cand: usize,
    #[serde(rename = "AD_REL")]
    pub ad_rel: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SplitParams {
    #[serde(rename = "SW_MIN_DUR")]
    pub sw_min_dur: f64,
    #[serde(rename = "SW_MIN_PART")]
    pub sw_min_part: f64,
    #[serde(rename = "SW_M")]
    pub sw_m: f64,
    #[serde(rename = "SW_PAUSE")]
    pub sw_pause: f64,
    #[serde(rename = "SW_DEPTH")]
    pub sw_depth: usize,
    #[serde(rename = "SENTENCE_ENDS")]
    pub sentence_ends: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MiniParams {
    #[serde(rename = "MINI_FLOOR")]
    pub mini_floor: f64,
    #[serde(rename = "MINI_M")]
    pub mini_m: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Params {
    pub version: String,
    #[serde(rename = "match")]
    pub matching: MatchParams,
    pub adapt: AdaptParams,
    pub split: SplitParams,
    pub mini: MiniParams,
}

pub const PARAMS_JSON: &str = include_str!("params.json");

pub fn params() -> &'static Params {
    static P: OnceLock<Params> = OnceLock::new();
    P.get_or_init(|| serde_json::from_str(PARAMS_JSON).expect("meet-core: params.json ungültig"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_parse_and_version() {
        let p = params();
        assert!(!p.version.is_empty());
        assert!(p.matching.t > 0.0 && p.split.sw_depth > 0);
    }

    /// Drift-Wächter: die gebundelte Kopie muss dem Repo-Root-PARAMS.json
    /// entsprechen. In vendored Kopien (Echo) existiert das Root-File nicht →
    /// Skip (der Sync-Script-Vergleich greift dort).
    #[test]
    fn bundled_params_match_repo_root() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../PARAMS.json");
        if !root.is_file() {
            eprintln!("skip: ../PARAMS.json fehlt (vendored Kopie)");
            return;
        }
        let root_v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root).unwrap()).unwrap();
        let bundled_v: serde_json::Value = serde_json::from_str(PARAMS_JSON).unwrap();
        assert_eq!(root_v, bundled_v, "src/params.json driftet von PARAMS.json — cp PARAMS.json rust/src/params.json");
    }
}
