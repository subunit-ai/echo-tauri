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

/// Bump when adding new default vocab terms/aliases that EXISTING (already-seeded)
/// users should receive. `merge_default_vocab_updates` runs once per bump and adds
/// only what's missing — see there. v1 = 2026-05-28 batch (Syncore/Citron/Claude
/// Code/OpenClaw/Ollama/Cursor/Ubuntu/Gründungszuschuss + Subunit/Erik aliases).
const VOCAB_SEED_VERSION: u32 = 1;

/// Serializes [`Config::save`] across threads so concurrent writers can't clobber
/// the shared temp file mid-rename. See `save()`.
static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
    // Generic AI / tech / German terms Whisper consistently mangles. Deliberately
    // NO company-internal brands or people (Subunit/Synapse/SNI/Syncore/Citron/
    // OpenClaw/Higgsfield/Claude Code/Erik/TJ/… were removed) so FRESH installs look
    // clean and neutral for new users (TJ). This list only seeds first-run installs;
    // existing users keep whatever they were already seeded with (the seed + version
    // guards never re-run for them), so internal teams keep their full vocabulary.
    vec![
        v("Instant", "Instant", &["Inzin", "Insent", "Instent", "Instand"], "Tech"),
        v("transkrivieren", "transkribieren", &["transkriebieren", "transkrieben", "transkrivieren"], "Tech"),
        v("transkriviert", "transkribiert", &["transkrieviert", "transkriebiert"], "Tech"),
        v("Whisper", "Whisper", &["Wisper", "Visper"], "Tech"),
        v("Klaud", "Claude", &["Klod", "Klode"], "Tech"),
        v("Antropik", "Anthropic", &["Antrobik"], "Company"),
        v("Open-AI", "OpenAI", &["Open A I", "Openei"], "Company"),
        v("Em-Ce-Pe", "MCP", &["M C P", "M.C.P."], "Tech"),
        v("DSGVO", "DSGVO", &["D S G V O", "D.S.G.V.O."], "Tech"),
        v("Olama", "Ollama", &["Oh Lama"], "Tech"),
        v("Körser", "Cursor", &["Curser"], "Tech"),
        v("Ju-Buntu", "Ubuntu", &["Ubunu"], "Tech"),
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
    /// "local" | "subunit". Subunit (the DSGVO cloud) and Local (on-device
    /// whisper.cpp) are the supported engines. The former Groq-proxied
    /// "superfast" tier was removed — that infrastructure was torn down.
    pub mode: String,
    pub local_model: String,
    pub local_device: String,
    pub language: String,

    pub subunit_endpoint: String,
    pub subunit_api_key: String,

    pub autopaste: bool,
    pub target_lock: bool,
    pub show_bubble: bool,

    /// Type the final transcript in progressively ("live typing") instead of an
    /// instant clipboard+Ctrl+V paste. Default false = instant paste (atomic,
    /// native, no per-char spam). User-settable in Settings.
    pub instant_live_typing: bool,

    /// Empty = system default. Otherwise device name (resolved to index at startup).
    pub mic_device_name: String,

    pub use_orb_overlay: bool,
    pub orb_color_theme: String,
    /// named anchor (bottom-center, ...) or "custom-X-Y"
    pub orb_position: String,
    pub orb_idle_pulse: bool,
    /// ping | sphere | sonar | bars | wave | classic
    pub orb_overlay_style: String,
    /// One-time guard: sets the default orb style to "sonar" ONCE for existing
    /// installs (see migrate()); afterwards the user's chosen style sticks.
    pub orb_style_migrated: bool,
    pub orb_overlay_size: f32,
    pub orb_overlay_auto_hide: bool,
    /// Idle behaviour: "normal" | "dim" (semi-transparent at rest, instead of
    /// vanishing) | "hide". Supersedes the boolean `orb_overlay_auto_hide`, which
    /// is kept only for deserialize compat and seeded into this once via
    /// `orb_idle_migrated`.
    pub orb_idle_mode: String,
    /// One-time guard: seed `orb_idle_mode` from the legacy auto-hide bool once.
    pub orb_idle_migrated: bool,
    /// Animation speed multiplier for the overlay (orb AND bubble): scales every
    /// pulse/ring/wave frequency uniformly. 1.0 = the original cadence; lower =
    /// calmer/slower. User-settable (TJ: the default frequency felt too fast).
    /// Clamped to a sane range when applied. Default 0.6 = a calmer baseline.
    pub orb_speed: f32,
    /// Per-state orb colors (hex). `idle` = resting, `working` = recording AND
    /// transcribing (the "busy" states), `done` = finished. These supersede the
    /// legacy single `orb_color_theme` dropdown — that field is kept only so old
    /// configs deserialize; its value is folded into `orb_color_idle` once via the
    /// `orb_colors_migrated` guard. The `error` state keeps a fixed warning tint
    /// (not user-themable — it signals a problem, shouldn't blend with the palette).
    pub orb_color_idle: String,
    pub orb_color_working: String,
    pub orb_color_done: String,
    /// One-time guard: seed the per-state colors from the legacy `orb_color_theme`
    /// ONCE for existing installs (so their chosen tint carries over), then the
    /// user's colors stick. Old configs lack this field → default false → migrates.
    pub orb_colors_migrated: bool,

    pub diarization_enabled: bool,
    pub diarization_max_speakers: i32,

    pub cleanup_enabled: bool,
    pub cleanup_style: String,
    pub cleanup_auto_mode: bool,
    pub auto_mode_overrides: HashMap<String, String>,

    pub long_form_threshold_seconds: i32,
    pub long_form_cleanup_style: String,

    pub synapse_save_enabled: bool,

    /// Global hotkey toggling the floating Prompt Console (empty = disabled).
    pub prompt_console_hotkey: String,
    /// "Konsole als Ziel": route every finished transcript into the Prompt
    /// Console instead of pasting it into the app behind. Toggled from the
    /// console header and in Settings.
    pub prompt_console_as_target: bool,

    /// toggle | hold (push-to-talk, default)
    pub recording_mode: String,

    pub account_email: String,
    pub last_cloud_mode: String,
    pub auto_update_check: bool,
    /// Auto-detect a running Teams/Zoom/Meet meeting and prompt to record it.
    pub meeting_autodetect: bool,
    /// Launch Echo at login (OS autostart entry, applied via the autostart plugin).
    pub autostart_enabled: bool,
    /// One-time guard: flips existing installs to autostart-on ONCE (see migrate()).
    /// Old configs lack this field → default false → the migration runs for them;
    /// afterwards the user's own choice sticks.
    pub autostart_migrated: bool,
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

    pub sound_enabled: bool,
    pub sound_volume: f32,
    /// Independent on/off for the two cues + which preset tone each plays. These
    /// supersede the single `sound_enabled` (kept only for deserialize compat),
    /// seeded from it once via `sound_split_migrated`. Tone ids → src/lib/sounds.ts.
    pub sound_start_enabled: bool,
    pub sound_paste_enabled: bool,
    pub sound_start_id: String,
    pub sound_paste_id: String,
    /// One-time guard: seed the two new toggles from the legacy `sound_enabled` once.
    pub sound_split_migrated: bool,

    pub vocabulary: Vec<VocabEntry>,
    #[serde(skip)]
    pub vocab_regex_cache: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, regex::Regex>>>,

    pub vocabulary_default_seeded: bool,
    /// Which `VOCAB_SEED_VERSION` batch this config has merged. Lets us push new
    /// default terms/aliases to already-seeded users without resurrecting their
    /// deletions every launch (only on a version bump). Old configs default to 0.
    #[serde(default)]
    pub vocab_seed_version: u32,

    pub dach_format_enabled: bool,

    pub history_size: i32,
    /// Lossless passthrough of history entries (shape owned by the transcription path).
    pub history: Vec<Value>,
    pub history_enabled: bool,
    /// Long-form recordings (>= long_form_threshold_seconds) kept separately.
    pub meetings: Vec<Value>,

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

            autopaste: true,
            target_lock: true,
            show_bubble: true,
            instant_live_typing: false,

            mic_device_name: String::new(),

            use_orb_overlay: true,
            orb_color_theme: "cyan".to_string(),
            orb_position: "bottom-center".to_string(),
            orb_idle_pulse: true,
            orb_overlay_style: "sonar".to_string(),
            orb_style_migrated: false,
            orb_overlay_size: 1.0,
            orb_overlay_auto_hide: false,
            orb_idle_mode: "normal".to_string(),
            orb_idle_migrated: false,
            orb_speed: 0.6,
            orb_color_idle: "#22d3ee".to_string(),
            orb_color_working: "#ff5c5c".to_string(),
            orb_color_done: "#50dc82".to_string(),
            orb_colors_migrated: false,

            diarization_enabled: false,
            diarization_max_speakers: 8,

            cleanup_enabled: false,
            cleanup_style: "prompt".to_string(),
            cleanup_auto_mode: false,
            auto_mode_overrides: HashMap::new(),

            long_form_threshold_seconds: 240,
            long_form_cleanup_style: "raw".to_string(),

            synapse_save_enabled: false,

            prompt_console_hotkey: "<ctrl>+<shift>+p".to_string(),
            prompt_console_as_target: false,

            recording_mode: "hold".to_string(),

            account_email: String::new(),
            last_cloud_mode: "subunit".to_string(),
            auto_update_check: true,
            meeting_autodetect: true,
            autostart_enabled: true,
            autostart_migrated: false,
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

            sound_enabled: true,
            sound_volume: 0.6,
            sound_start_enabled: true,
            sound_paste_enabled: true,
            sound_start_id: "standard".to_string(),
            sound_paste_id: "standard".to_string(),
            sound_split_migrated: false,

            vocabulary: Vec::new(),
            vocab_regex_cache: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            vocabulary_default_seeded: false,
            vocab_seed_version: 0,

            dach_format_enabled: false,

            history_size: 50,
            history: Vec::new(),
            history_enabled: true,
            meetings: Vec::new(),

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
                    // Initialize the non-serialized cache
                    c.vocab_regex_cache = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
                    c.migrate();
                    c.seed_default_vocabulary();
                    c.merge_default_vocab_updates();
                    c.build_vocab_regex_cache();
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
                    c.vocab_regex_cache = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
                    c.migrate();
                    c.seed_default_vocabulary();
                    c.merge_default_vocab_updates();
                    c.build_vocab_regex_cache();
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
        c.autostart_migrated = true; // fresh installs are already autostart-on by default
        c.orb_style_migrated = true; // fresh installs already default to the "sonar" orb
        c.orb_colors_migrated = true; // fresh installs already use the per-state color defaults
        c.orb_idle_migrated = true; // fresh installs default to the "normal" idle mode
        c.sound_split_migrated = true; // fresh installs already have the split toggles
        c.route_default_engine();
        c.seed_default_vocabulary();
        c.merge_default_vocab_updates();
        c.build_vocab_regex_cache();
        let _ = c.save();
        c
    }

    /// Migration ladder (mirrors Config.load in config.py).
    fn migrate(&mut self) {
        if self.cleanup_style == "tidy" {
            self.cleanup_style = "prompt".to_string();
        }
        if self.cloud_quality_mode.is_empty() || self.cloud_quality_mode == "auto" {
            // v0.9.14: auto's instant/fast tiers degraded German accuracy.
            self.cloud_quality_mode = "quality".to_string();
        }
        // v0.4.4: Echo should launch at login by default. Existing installs saved
        // autostart_enabled=false; flip them ON exactly once, then respect the
        // user's choice forever after (the guard never re-runs).
        if !self.autostart_migrated {
            self.autostart_enabled = true;
            self.autostart_migrated = true;
        }
        // v0.4.4: default orb overlay is now the "sonar" radar style. Move installs
        // that were still on the previous default ("ping") over ONCE — but leave any
        // deliberately-chosen style (wave/sphere/…) untouched. Runs only once.
        if !self.orb_style_migrated {
            if self.orb_overlay_style == "ping" {
                self.orb_overlay_style = "sonar".to_string();
            }
            self.orb_style_migrated = true;
        }
        // v0.4.15: per-state orb colors replace the single theme dropdown. Seed the
        // idle color from the user's previous theme (cyan/violet/mint) ONCE so their
        // look carries over; working/done take the classic record-red / done-green
        // (the previous hardcoded STATE_COLOR values). Runs only once.
        if !self.orb_colors_migrated {
            self.orb_color_idle = match self.orb_color_theme.as_str() {
                "violet" => "#aa6eff",
                "mint" => "#6ee6be",
                _ => "#22d3ee",
            }
            .to_string();
            self.orb_colors_migrated = true;
        }
        // v0.4.16: idle behaviour moved from a bool to a 3-way mode. Seed it from
        // the legacy auto-hide flag once: auto_hide=true → "hide", else "normal".
        if !self.orb_idle_migrated {
            self.orb_idle_mode = if self.orb_overlay_auto_hide { "hide" } else { "normal" }.to_string();
            self.orb_idle_migrated = true;
        }
        // v0.4.18: the single sound toggle split into two (activation + paste).
        // Seed both from the old flag once so a user who'd muted sounds stays muted.
        if !self.sound_split_migrated {
            self.sound_start_enabled = self.sound_enabled;
            self.sound_paste_enabled = self.sound_enabled;
            self.sound_split_migrated = true;
        }
        self.route_default_engine();
    }

    /// Coerce the mode to a supported engine. Old configs (or migrated ones) may
    /// carry the dropped openai/groq/custom/openrouter modes → route them to the
    /// cloud (Subunit). And a blind "local" on a build without the on-device
    /// engine can't transcribe → also Subunit. An explicit "local" on a
    /// local-capable build is left untouched.
    fn route_default_engine(&mut self) {
        if self.mode == "local" {
            if !cfg!(feature = "local-whisper") {
                self.mode = "subunit".to_string();
            }
        } else if self.mode != "subunit" {
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

    /// Additively push NEW default vocab to already-seeded users, once per
    /// `VOCAB_SEED_VERSION` bump. For a default whose `write_as` the user already
    /// has, merge any missing aliases (and its `sounds_like`) into that entry;
    /// otherwise append the whole entry. Case-insensitive dedupe; user entries
    /// are never removed or reworded, so custom edits survive.
    fn merge_default_vocab_updates(&mut self) {
        if self.vocab_seed_version >= VOCAB_SEED_VERSION {
            return;
        }
        for def in default_vocabulary() {
            let canon = def.write_as.trim().to_lowercase();
            if canon.is_empty() {
                continue;
            }
            match self
                .vocabulary
                .iter_mut()
                .find(|e| e.write_as.trim().to_lowercase() == canon)
            {
                Some(existing) => {
                    // Already have this term — fold in any missing patterns.
                    let mut have: std::collections::HashSet<String> = existing
                        .aliases
                        .iter()
                        .map(|a| a.trim().to_lowercase())
                        .collect();
                    have.insert(existing.sounds_like.trim().to_lowercase());
                    have.insert(existing.write_as.trim().to_lowercase());
                    let mut candidates = vec![def.sounds_like.clone()];
                    candidates.extend(def.aliases.iter().cloned());
                    for cand in candidates {
                        let key = cand.trim().to_lowercase();
                        if !key.is_empty() && have.insert(key) {
                            existing.aliases.push(cand);
                        }
                    }
                }
                None => self.vocabulary.push(def),
            }
        }
        self.vocab_seed_version = VOCAB_SEED_VERSION;
    }

    fn backup_broken(path: &Path) {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup = config_dir().join(format!("config.broken-{ts}.json"));
        let _ = fs::rename(path, backup);
    }

    /// Pre-compiles vocabulary regexes into the cache.
    pub fn build_vocab_regex_cache(&self) {
        let mut pairs: Vec<(&str, &str)> = Vec::new();
        for e in &self.vocabulary {
            let target = e.write_as.trim();
            if target.is_empty() {
                continue;
            }
            let sl = e.sounds_like.trim();
            if !sl.is_empty() && !sl.eq_ignore_ascii_case(target) {
                pairs.push((sl, target));
            }
            for a in &e.aliases {
                let a = a.trim();
                if !a.is_empty() && !a.eq_ignore_ascii_case(target) {
                    pairs.push((a, target));
                }
            }
        }

        let mut cache = self.vocab_regex_cache.lock().unwrap();
        cache.clear();

        for (p, _) in pairs {
            let pat = format!(r"(?i)(^|[^\w]){}([^\w]|$)", regex::escape(p));
            if let Ok(re) = regex::Regex::new(&pat) {
                cache.insert(p.to_string(), re);
            }
        }
    }

    pub fn save(&self) -> anyhow::Result<()> {
        // Serialize all saves process-wide so concurrent writers (the main set_config
        // + detached diarization/stats threads) can't interleave onto the temp file.
        let _guard = SAVE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let dir = config_dir();
        fs::create_dir_all(&dir)?;
        let path = config_file();
        let json = serde_json::to_string_pretty(self)?;
        // Per-process temp name: SAVE_LOCK only serializes within this process, but a
        // racing second launch (before the single-instance guard exits it) is a
        // separate process — it must not clobber a shared temp mid-rename.
        let tmp = dir.join(format!("config.{}.tmp", std::process::id()));
        // Atomic write: into a temp file, then rename over the target. fs::rename
        // replaces atomically on POSIX and on Windows (MOVEFILE_REPLACE_EXISTING), so
        // a crash mid-write can never leave a truncated config.json (which would drop
        // the user's tokens + history). The config holds refresh tokens + BYO API
        // keys, so on unix create the temp 0600 *before* the secrets land (not after,
        // which left a brief world-readable window) and clean it up on any failure.
        let write_then_rename = || -> std::io::Result<()> {
            #[cfg(unix)]
            {
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                let mut f = fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(&tmp)?;
                f.write_all(json.as_bytes())?;
                f.sync_all()?;
            }
            #[cfg(not(unix))]
            {
                fs::write(&tmp, json.as_bytes())?;
            }
            fs::rename(&tmp, &path)
        };
        if let Err(e) = write_then_rename() {
            let _ = fs::remove_file(&tmp); // never leave a token-bearing temp behind
            return Err(e.into());
        }
        Ok(())
    }
}
