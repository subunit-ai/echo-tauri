//! Persistent configuration for Echo.
//!
//! Faithful Rust port of the Python `synapse_voice/config.py` dataclass.
//! Field names match 1:1 so an existing user's `~/.config/synapse-voice/config.json`
//! deserializes straight into this struct — see [`Config::load`] which migrates the
//! legacy file to `~/.config/echo/config.json` on first run.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// New config home. Kept at `~/.config/echo` on *all* platforms to mirror the
/// Python app's cross-platform `Path.home()/.config/...` choice (predictable,
/// and lets the legacy migration use a sibling path).
pub fn config_dir() -> PathBuf {
    home_dir().join(".config").join("echo")
}

pub fn config_file() -> PathBuf {
    config_dir().join("config.json")
}

/// The Python/PyQt6 app stored its config here on every platform.
fn legacy_config_file() -> PathBuf {
    home_dir()
        .join(".config")
        .join("synapse-voice")
        .join("config.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VocabEntry {
    pub sounds_like: String,
    pub write_as: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default = "default_category")]
    pub category: String,
}

fn default_category() -> String {
    "Other".to_string()
}

/// Baseline DACH vocabulary (ported verbatim from `DEFAULT_VOCABULARY` in
/// config.py). Seeded once, gated by `vocabulary_default_seeded`, so user
/// deletions stick.
fn default_vocabulary() -> Vec<VocabEntry> {
    let v = |s: &str, w: &str, a: &[&str], c: &str| VocabEntry {
        sounds_like: s.to_string(),
        write_as: w.to_string(),
        aliases: a.iter().map(|x| x.to_string()).collect(),
        category: c.to_string(),
    };
    vec![
        // Brand / product names
        v("Echo", "Echo", &["Eko", "Ecko", "Echo."], "Company"),
        v("Sub-Unit", "Subunit", &["Subunit.", "Sub unit", "Subnit", "Subunit AI"], "Company"),
        v("Synaps", "Synapse", &["Synaps."], "Company"),
        v("Es-Enn-I", "SNI", &["S N I"], "Tech"),
        v("Higgs Field", "Higgsfield", &["Higs Field", "Higsfield"], "Company"),
        // Tech terms Whisper consistently mangles in German
        v("Instant", "Instant", &["Inzin", "Insent", "Instent", "Instand"], "Tech"),
        v("transkrivieren", "transkribieren", &["transkriebieren", "transkrieben", "transkrivieren"], "Tech"),
        v("transkriviert", "transkribiert", &["transkrieviert", "transkriebiert"], "Tech"),
        v("Whisper", "Whisper", &["Wisper", "Visper"], "Tech"),
        v("Klaud", "Claude", &["Klod", "Klode"], "Tech"),
        v("Antropik", "Anthropic", &["Antrobik"], "Company"),
        v("Open-AI", "OpenAI", &["Open A I", "Openei"], "Company"),
        v("Em-Ce-Pe", "MCP", &["M C P", "M.C.P."], "Tech"),
        v("DSGVO", "DSGVO", &["D S G V O", "D.S.G.V.O."], "Tech"),
        // People recurring in workflow
        v("Erik", "Erik", &["Eric"], "Person"),
        v("Te-Je", "TJ", &["T J", "T.J.", "Tee Jay"], "Person"),
    ]
}

/// Persistent config. `#[serde(default)]` at the container level means any
/// field missing from an older config.json is filled from [`Config::default`]
/// — that's the forward-compat mechanism for new fields, and unknown fields
/// from a newer build are ignored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub hotkey: String,
    /// "local" | "subunit" | "openai" | "groq" | "custom"
    pub mode: String,
    pub local_model: String,
    pub local_device: String,
    pub language: String,

    pub subunit_endpoint: String,
    pub subunit_api_key: String,

    pub openai_api_key: String,
    pub openai_model: String,

    pub groq_api_key: String,
    pub groq_model: String,

    pub custom_endpoint: String,
    pub custom_api_key: String,
    pub custom_model: String,

    /// Legacy pre-v0.2.5 OpenRouter key — kept so old configs migrate quietly.
    pub openrouter_api_key: String,

    pub autopaste: bool,
    pub target_lock: bool,
    pub show_bubble: bool,

    /// Empty = system default. Otherwise device name (resolved to index at startup).
    pub mic_device_name: String,

    pub use_orb_overlay: bool,
    pub orb_color_theme: String,
    /// named anchor (bottom-center, ...) or "custom-X-Y"
    pub orb_position: String,
    pub orb_idle_pulse: bool,
    /// ping | sphere | sonar | bars | wave | classic
    pub orb_overlay_style: String,
    pub orb_overlay_size: f32,
    pub orb_overlay_auto_hide: bool,

    pub diarization_enabled: bool,
    pub diarization_max_speakers: i32,

    pub cleanup_enabled: bool,
    pub cleanup_style: String,
    pub cleanup_auto_mode: bool,
    pub auto_mode_overrides: HashMap<String, String>,

    pub long_form_threshold_seconds: i32,
    pub long_form_cleanup_style: String,

    pub synapse_save_enabled: bool,

    /// toggle | hold (push-to-talk, default)
    pub recording_mode: String,

    pub account_email: String,
    pub last_cloud_mode: String,
    pub auto_update_check: bool,
    pub has_seen_onboarding: bool,
    pub ui_language: String,
    pub ui_theme: String,

    pub plan: String,
    pub trial_started_at: i64,

    pub subunit_access_token: String,
    pub subunit_refresh_token: String,
    pub subunit_token_issued_at: f64,
    pub subunit_token_expires_in: i32,
    pub subunit_workspace_id: String,

    /// "auto" | "instant" | "fast" | "quality"
    pub cloud_quality_mode: String,
    pub gpu_aware_migrated: bool,
    pub live_type: bool,
    pub cloud_superfast: bool,

    pub sound_enabled: bool,
    pub sound_volume: f32,

    pub vocabulary: Vec<VocabEntry>,
    pub vocabulary_default_seeded: bool,

    pub dach_format_enabled: bool,

    pub history_size: i32,
    /// Lossless passthrough of history entries (shape owned by the transcription path).
    pub history: Vec<Value>,
    pub history_enabled: bool,

    pub total_transcriptions: i64,
    pub total_audio_seconds: f64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            hotkey: "<ctrl>+<space>".to_string(),
            mode: "local".to_string(),
            local_model: "base".to_string(),
            local_device: "auto".to_string(),
            language: "de".to_string(),

            subunit_endpoint: "https://transcribe.subunit.ai/v1/transcribe".to_string(),
            subunit_api_key: String::new(),

            openai_api_key: String::new(),
            openai_model: "whisper-1".to_string(),

            groq_api_key: String::new(),
            groq_model: "whisper-large-v3-turbo".to_string(),

            custom_endpoint: String::new(),
            custom_api_key: String::new(),
            custom_model: "whisper-1".to_string(),

            openrouter_api_key: String::new(),

            autopaste: true,
            target_lock: true,
            show_bubble: true,

            mic_device_name: String::new(),

            use_orb_overlay: true,
            orb_color_theme: "cyan".to_string(),
            orb_position: "bottom-center".to_string(),
            orb_idle_pulse: true,
            orb_overlay_style: "ping".to_string(),
            orb_overlay_size: 1.0,
            orb_overlay_auto_hide: false,

            diarization_enabled: false,
            diarization_max_speakers: 8,

            cleanup_enabled: false,
            cleanup_style: "prompt".to_string(),
            cleanup_auto_mode: false,
            auto_mode_overrides: HashMap::new(),

            long_form_threshold_seconds: 240,
            long_form_cleanup_style: "raw".to_string(),

            synapse_save_enabled: false,

            recording_mode: "hold".to_string(),

            account_email: String::new(),
            last_cloud_mode: "subunit".to_string(),
            auto_update_check: true,
            has_seen_onboarding: false,
            ui_language: "de".to_string(),
            ui_theme: "dark".to_string(),

            plan: "free".to_string(),
            trial_started_at: 0,

            subunit_access_token: String::new(),
            subunit_refresh_token: String::new(),
            subunit_token_issued_at: 0.0,
            subunit_token_expires_in: 0,
            subunit_workspace_id: String::new(),

            cloud_quality_mode: "quality".to_string(),
            gpu_aware_migrated: false,
            live_type: false,
            cloud_superfast: false,

            sound_enabled: true,
            sound_volume: 0.6,

            vocabulary: Vec::new(),
            vocabulary_default_seeded: false,

            dach_format_enabled: false,

            history_size: 50,
            history: Vec::new(),
            history_enabled: true,

            total_transcriptions: 0,
            total_audio_seconds: 0.0,
        }
    }
}

impl Config {
    /// Load the config, applying the same migration ladder as the Python app
    /// plus a one-time carry-over from the legacy `synapse-voice` config.
    pub fn load() -> Self {
        let path = config_file();
        if path.exists() {
            match Self::read_from(&path) {
                Ok(mut c) => {
                    c.migrate();
                    c.seed_default_vocabulary();
                    let _ = c.save();
                    c
                }
                Err(e) => {
                    log::warn!("config: unreadable ({e}) — backing up + starting fresh");
                    Self::backup_broken(&path);
                    Self::fresh()
                }
            }
        } else if legacy_config_file().exists() {
            // Seamless carry-over for existing Echo (PyQt6) users.
            match Self::read_from(&legacy_config_file()) {
                Ok(mut c) => {
                    log::info!("config: migrating legacy synapse-voice config → echo");
                    c.migrate();
                    c.seed_default_vocabulary();
                    let _ = c.save();
                    c
                }
                Err(_) => Self::fresh(),
            }
        } else {
            Self::fresh()
        }
    }

    fn read_from(p: &Path) -> anyhow::Result<Self> {
        let s = fs::read_to_string(p)?;
        let cfg: Config = serde_json::from_str(&s)?;
        Ok(cfg)
    }

    fn fresh() -> Self {
        let mut c = Self::default();
        c.gpu_aware_migrated = true;
        c.route_default_engine();
        c.seed_default_vocabulary();
        let _ = c.save();
        c
    }

    /// Migration ladder (mirrors Config.load in config.py).
    fn migrate(&mut self) {
        if self.mode == "openrouter" {
            self.mode = "openai".to_string();
        }
        if self.cleanup_style == "tidy" {
            self.cleanup_style = "prompt".to_string();
        }
        if self.cloud_quality_mode.is_empty() || self.cloud_quality_mode == "auto" {
            // v0.9.14: auto's instant/fast tiers degraded German accuracy.
            self.cloud_quality_mode = "quality".to_string();
        }
        self.route_default_engine();
    }

    /// If this build has no on-device engine (`local-whisper` off), a blind
    /// "local" default can't transcribe — route it to the cloud (Subunit). This
    /// is the GPU-aware-default equivalent: an explicit choice on a build that
    /// *can* run local is left untouched.
    fn route_default_engine(&mut self) {
        if self.mode == "local" && !cfg!(feature = "local-whisper") {
            self.mode = "subunit".to_string();
        }
    }

    /// Append baseline DACH terms once (idempotent via `vocabulary_default_seeded`).
    fn seed_default_vocabulary(&mut self) {
        if self.vocabulary_default_seeded {
            return;
        }
        let mut existing: std::collections::HashSet<String> = self
            .vocabulary
            .iter()
            .map(|e| e.write_as.trim().to_lowercase())
            .collect();
        for entry in default_vocabulary() {
            let canon = entry.write_as.trim().to_lowercase();
            if !canon.is_empty() && !existing.contains(&canon) {
                existing.insert(canon);
                self.vocabulary.push(entry);
            }
        }
        self.vocabulary_default_seeded = true;
    }

    fn backup_broken(path: &Path) {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup = config_dir().join(format!("config.broken-{ts}.json"));
        let _ = fs::rename(path, backup);
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let dir = config_dir();
        fs::create_dir_all(&dir)?;
        let path = config_file();
        let json = serde_json::to_string_pretty(self)?;
        fs::write(&path, json)?;
        // The config holds refresh tokens + BYO API keys — tighten to 0600 on
        // POSIX so a shared-machine attacker can't grep it (Codex P2, Python parity).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}
