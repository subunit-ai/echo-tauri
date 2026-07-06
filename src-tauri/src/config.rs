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

/// Serde default for opt-out bool flags: an existing config that predates the
/// field should keep the feature ON (only an explicit user toggle turns it off).
fn default_true() -> bool {
    true
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
    /// Quietly download a small local model once (background, on start) so the
    /// automatic cloud→local fallback is armed even for users who never touch
    /// the model manager. Container `#[serde(default)]` seeds old configs true.
    pub local_fallback_autofetch: bool,
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
    /// named anchor (bottom-center, ...) or drag-set "center-X-Y" (orb centre,
    /// logical px; legacy "custom-X-Y" = orb top-left, converted in migrate())
    pub orb_position: String,
    pub orb_idle_pulse: bool,
    /// ping | sphere | sonar | bars | wave | classic
    /// | ping2 | sonar2 | bars2 | wave2 (V2 remodels) | halo | orbit | aurora | spectrum
    /// | bars3 (hybrid 9-band EQ) | duobars | duobars2 | duobars3 (centre-baseline,
    ///   independent top/bottom lobes — V1 = 5 bars, V2 = 13, V3 = 9)
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
    /// How the satellite islands are revealed: "hover" = appear while the cursor
    /// is over the orb cluster; "click" = stay hidden until the orb (overlay
    /// window) is clicked/focused, so they never pop up just from passing over the
    /// orb (TJ: hover-reveal "stört und nervt"). Click also sidesteps the macOS
    /// non-key-window mouse quirk — the activating click makes the window key.
    pub orb_trigger: String,
    /// Animation speed multiplier for the overlay (orb AND bubble): scales every
    /// pulse/ring/wave frequency uniformly. 1.0 = the original cadence; lower =
    /// calmer/slower. User-settable (TJ: the default frequency felt too fast).
    /// Clamped to a sane range when applied. Default 0.6 = a calmer baseline.
    pub orb_speed: f32,
    /// Voice-reactivity of the orb/bubble meters (perceptual VU mapping in
    /// `recorder.rs`): `noise_floor` gates true silence, `gain` is the linear
    /// boost, `gamma` (<1) expands the quiet→mid band a voice lives in. Defaults
    /// mirror the previous hardcoded constants. Captured in orb profiles so the
    /// future configurator can tune "how strongly it reacts to your voice".
    pub orb_noise_floor: f32,
    pub orb_gain: f32,
    pub orb_gamma: f32,
    /// Per-state orb colors (hex). `idle` = resting, `working` = recording AND
    /// transcribing (the "busy" states), `done` = finished. These supersede the
    /// legacy single `orb_color_theme` dropdown — that field is kept only so old
    /// configs deserialize; its value is folded into `orb_color_idle` once via the
    /// `orb_colors_migrated` guard. `error` is the warning tint shown when something
    /// fails; it defaults to amber but is now user-themable like the rest.
    pub orb_color_idle: String,
    pub orb_color_working: String,
    pub orb_color_done: String,
    pub orb_color_error: String,
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

    /// Deterministic, zero-latency filler-word strip ("äh"/"ähm"/"hmm" → gone).
    /// A local text pass (no `/v1/cleanup` round trip), so it's the "light
    /// cleanup" that costs nothing even with the AI cleanup off. ON by default
    /// (v0.5.84): universally wanted and precision-safe (never cuts real words).
    #[serde(default = "default_true")]
    pub filler_removal_enabled: bool,
    /// One-time guard that flips `filler_removal_enabled` ON for configs that
    /// predate the default flip. Old configs saved `false`, so changing the
    /// default alone would never reach them — this migrates them exactly once,
    /// then respects a later opt-out forever.
    #[serde(default)]
    pub filler_removal_migrated: bool,

    pub long_form_threshold_seconds: i32,
    pub long_form_cleanup_style: String,

    pub synapse_save_enabled: bool,

    /// Global hotkey toggling the floating Prompt Console (empty = disabled).
    pub prompt_console_hotkey: String,
    /// "Konsole als Ziel": route every finished transcript into the Prompt
    /// Console instead of pasting it into the app behind. Toggled from the
    /// console header and in Settings.
    pub prompt_console_as_target: bool,
    /// Glass intensity of the Prompt Console shell: "clear" (most transparent,
    /// default) | "regular" | "rich". Cycled from the console header.
    pub prompt_console_glass: String,

    /// toggle | hold (push-to-talk, default)
    pub recording_mode: String,

    pub account_email: String,
    /// User-facing identity for the greeting + bottom-left account panel.
    /// `display_name` is auto-seeded from the JWT `name` claim on login IF still
    /// empty (see auth.rs); `nickname` (Spitzname) is always user-entered. Both
    /// local-first; container #[serde(default)] seeds old configs to "".
    pub display_name: String,
    pub nickname: String,
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
    /// Appearance: "light" | "liquid" (illuminated Liquid-Glass showpiece) |
    /// "dark". Reflected on <html data-theme> in ConfigContext.
    pub ui_theme: String,
    /// Liquid-glass frost strength: 0 = off (flat, solid surfaces) … 3 = strong
    /// frost. Drives --glass-mul on the document root; 2 = the standard look.
    /// Old configs lack it → container #[serde(default)] seeds the Default (2).
    pub glass_strength: i32,
    /// Overall UI scale (CSS `zoom` on the document root) so the whole app can be
    /// shrunk into a compact "module" — 1.0 = normal, down to ~0.6. Applied in
    /// ConfigContext; the window min-size is small enough to follow it.
    pub ui_scale: f32,

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

    /// Live WS streaming dictation mode (cloud only). The server decodes the
    /// take incrementally while the key is held (stable-prefix) so release pays
    /// only for the tail (~5× lower press→paste latency, the SAME full-quality
    /// text as batch). Three modes:
    ///   "off"   — classic one-shot upload (no streaming)
    ///   "final" — stream for speed, paste the full final ONCE on release
    ///   "live"  — type the server-committed (stable) text into the target AS
    ///             you speak; the still-volatile tail stays on-screen only and
    ///             completes on release. Only ever injects text the server
    ///             marked stable, so no word it later revises is written →
    ///             no garbage in the document, no quality loss.
    /// Any WS failure falls back to batch automatically; this never gates
    /// dictation. New field → container `#[serde(default)]` seeds existing
    /// installs from `Config::default()`, so the promotion needs no migration guard.
    pub streaming_mode: String,

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

    /// Master switch for the whole vocabulary feature — Whisper bias prompt AND
    /// the deterministic whole-word post-replace ("Sky" → "SCAI"). Independent of
    /// `cleanup_enabled`: with this on, replacements apply on EVERY path (batch +
    /// streaming, cleanup on or off). Old configs default to on.
    #[serde(default = "default_true")]
    pub vocab_enabled: bool,

    pub vocabulary: Vec<VocabEntry>,
    #[serde(skip)]
    pub vocab_regex_cache: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, regex::Regex>>>,

    pub vocabulary_default_seeded: bool,
    /// Which `VOCAB_SEED_VERSION` batch this config has merged. Lets us push new
    /// default terms/aliases to already-seeded users without resurrecting their
    /// deletions every launch (only on a version bump). Old configs default to 0.
    #[serde(default)]
    pub vocab_seed_version: u32,

    /// DACH text formatting (currency/percent/units → symbols, abbreviations,
    /// German quotes). Deterministic + zero-latency. ON by default (v0.5.85);
    /// existing configs are flipped once via `dach_format_migrated`.
    #[serde(default = "default_true")]
    pub dach_format_enabled: bool,
    /// One-time guard flipping `dach_format_enabled` ON for configs that predate
    /// the default change; a later opt-out is then respected forever.
    #[serde(default)]
    pub dach_format_migrated: bool,

    pub history_size: i32,
    /// Lossless passthrough of history entries (shape owned by the transcription path).
    pub history: Vec<Value>,
    pub history_enabled: bool,
    /// Long-form recordings (>= long_form_threshold_seconds) kept separately.
    pub meetings: Vec<Value>,

    pub total_transcriptions: i64,
    pub total_audio_seconds: f64,
    /// One-time guard: has the legacy global counters → per-account `account_stats`
    /// seed run yet? Set true after the first post-upgrade startup so the historical
    /// totals are attributed to one account exactly once (never double-counted).
    pub stats_seeded: bool,
    /// Seed schema version for `account_stats`. Bumped when the seed logic changes
    /// so already-seeded installs get repaired: v1 backfilled historical words from
    /// the tiny retained-history window → wildly inconsistent with the lifetime
    /// audio total, which clamped "time saved" to zero. v2 estimates historical
    /// words from the audio instead.
    pub stats_seed_version: i32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            hotkey: "<ctrl>+<space>".to_string(),
            mode: "local".to_string(),
            local_model: "base".to_string(),
            local_fallback_autofetch: true,
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
            orb_trigger: "click".to_string(),
            orb_speed: 0.6,
            // Retuned 2026-07-03 (TJ: "präzise, aber nicht so sensibel"): higher
            // gate kills breath/room noise, lower gain + higher gamma stop the
            // old everything-saturates-to-1.0 — soft vs normal vs loud speech now
            // deflect visibly differently. Old (0.01/7.5/0.55): rms 0.05→0.52,
            // 0.15→1.0, 0.3→1.0 (flat). New: 0.05→0.24, 0.15→0.72, 0.3→1.0.
            orb_noise_floor: 0.02,
            orb_gain: 5.0,
            orb_gamma: 0.75,
            orb_color_idle: "#22d3ee".to_string(),
            orb_color_working: "#ff5c5c".to_string(),
            orb_color_done: "#50dc82".to_string(),
            orb_color_error: "#ffc450".to_string(),
            orb_colors_migrated: false,

            diarization_enabled: false,
            diarization_max_speakers: 8,

            cleanup_enabled: false,
            cleanup_style: "prompt".to_string(),
            cleanup_auto_mode: false,
            auto_mode_overrides: HashMap::new(),
            filler_removal_enabled: true,
            filler_removal_migrated: false,

            long_form_threshold_seconds: 240,
            long_form_cleanup_style: "raw".to_string(),

            synapse_save_enabled: false,

            prompt_console_hotkey: "<ctrl>+<shift>+p".to_string(),
            prompt_console_as_target: false,
            prompt_console_glass: "clear".to_string(),

            recording_mode: "hold".to_string(),

            account_email: String::new(),
            display_name: String::new(),
            nickname: String::new(),
            last_cloud_mode: "subunit".to_string(),
            auto_update_check: true,
            meeting_autodetect: true,
            autostart_enabled: true,
            autostart_migrated: false,
            has_seen_onboarding: false,
            ui_language: "de".to_string(),
            ui_theme: "dark".to_string(),
            glass_strength: 2,
            ui_scale: 1.0,

            plan: "free".to_string(),
            trial_started_at: 0,

            subunit_access_token: String::new(),
            subunit_refresh_token: String::new(),
            subunit_token_issued_at: 0.0,
            subunit_token_expires_in: 0,
            subunit_workspace_id: String::new(),

            cloud_quality_mode: "quality".to_string(),
            gpu_aware_migrated: false,

            streaming_mode: "final".to_string(),

            sound_enabled: true,
            sound_volume: 0.6,
            sound_start_enabled: true,
            sound_paste_enabled: true,
            sound_start_id: "standard".to_string(),
            sound_paste_id: "standard".to_string(),
            sound_split_migrated: false,

            vocab_enabled: true,
            vocabulary: Vec::new(),
            vocab_regex_cache: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            vocabulary_default_seeded: false,
            vocab_seed_version: 0,

            dach_format_enabled: true,
            dach_format_migrated: false,

            history_size: 50,
            history: Vec::new(),
            history_enabled: true,
            meetings: Vec::new(),

            total_transcriptions: 0,
            total_audio_seconds: 0.0,
            stats_seeded: false,
            stats_seed_version: 0,
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
        c.filler_removal_migrated = true; // fresh installs already default filler-removal on
        c.dach_format_migrated = true; // fresh installs already default DACH formatting on
        c.route_default_engine();
        c.seed_default_vocabulary();
        c.merge_default_vocab_updates();
        c.build_vocab_regex_cache();
        let _ = c.save();
        c
    }

    /// Migration ladder (mirrors Config.load in config.py).
    /// Streaming-live typing and `instant_live_typing` are both keystroke-typing
    /// modes; enabling both is redundant and invites overlap. Streaming-live wins.
    pub fn enforce_typing_exclusivity(&mut self) {
        if self.streaming_mode == "live" {
            self.instant_live_typing = false;
        }
    }

    fn migrate(&mut self) {
        // Guard the UI scale against a corrupt/out-of-range value (never an
        // invisible-or-giant UI); 1.0 = normal, floor at 0.6 (compact module).
        self.ui_scale = if self.ui_scale.is_finite() && self.ui_scale > 0.0 {
            self.ui_scale.clamp(0.6, 1.0)
        } else {
            1.0
        };
        // Guard the glass-strength step against corrupt/out-of-range values.
        self.glass_strength = self.glass_strength.clamp(0, 3);
        // Live streaming ALREADY types progressively as you speak, so the separate
        // "instant live typing" (type the final at the end) is redundant with it —
        // two live-typing settings at once are confusing ("doppelt gemoppelt") and a
        // foot-gun. Enforce mutual exclusivity: streaming-live wins. (Belt for the
        // actual interleave fix in stream.rs; also runs in set_config on every save.)
        self.enforce_typing_exclusivity();
        // NOTE: "tidy" used to be force-migrated to "prompt" here (it was an old
        // deprecated default). As of 2026-06-28 "tidy" is a first-class,
        // user-selectable style again (lightest-touch cleanup) — so we must NOT
        // rewrite it, or a deliberate Tidy pick would silently revert on save.
        // Orb reactivity retune (2026-07-03): saved configs carry the OLD default
        // triple (0.01/7.5/0.55) verbatim, so just changing the defaults would
        // never reach existing users. Fold exactly-the-old-defaults onto the new
        // curve; anyone who hand-tuned reactivity (any deviation) keeps theirs.
        if self.orb_noise_floor == 0.01 && self.orb_gain == 7.5 && self.orb_gamma == 0.55 {
            self.orb_noise_floor = 0.02;
            self.orb_gain = 5.0;
            self.orb_gamma = 0.75;
        }
        if self.cloud_quality_mode.is_empty()
            || matches!(self.cloud_quality_mode.as_str(), "auto" | "fast" | "instant")
        {
            // auto's instant/fast tiers degraded German accuracy and are gone from
            // the UI — fold any saved value onto quality (turbo). "highest" (full
            // large-v3, best accuracy) passes through unchanged.
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
        // v0.5.84: filler-word removal ("äh"/"ähm"/"hmm") is now on by default —
        // universally wanted, precision-safe, zero-latency. Existing configs saved
        // it as false (the old opt-in default), so flip it ON exactly once; a later
        // deliberate opt-out is then respected forever (the guard never re-runs).
        if !self.filler_removal_migrated {
            self.filler_removal_enabled = true;
            self.filler_removal_migrated = true;
        }
        // v0.5.85: DACH formatting (Euro→€, percent/units, German quotes) is now
        // on by default — deterministic, zero-latency, precision-safe. Flip existing
        // configs (saved false) on exactly once; a later opt-out is respected forever.
        if !self.dach_format_migrated {
            self.dach_format_enabled = true;
            self.dach_format_migrated = true;
        }
        // v0.5.4: drag-set positions store the orb CENTRE ("center-x-y") instead
        // of its top-left ("custom-x-y"), so size changes scale the orb in place
        // around that point instead of letting it drift. Convert legacy values
        // using the currently configured size (the best available estimate of
        // the diameter they were saved with). Self-guarding: once converted, the
        // prefix is "center-" and this never matches again.
        if let Some(rest) = self.orb_position.clone().strip_prefix("custom-") {
            if let Some((x, y)) = crate::overlay::parse_pos_pair(rest) {
                let dim = crate::overlay::orb_dim(self.orb_overlay_size as f64);
                self.orb_position = format!(
                    "center-{}-{}",
                    (x + dim / 2.0).round() as i64,
                    (y + dim / 2.0).round() as i64
                );
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filler_removal_migrates_on_once_then_respects_optout() {
        // A config that predates the v0.5.84 default flip: saved off, never migrated.
        let mut old = Config::default();
        old.filler_removal_enabled = false;
        old.filler_removal_migrated = false;
        old.migrate();
        assert!(old.filler_removal_enabled, "old config must be flipped on once");
        assert!(old.filler_removal_migrated, "guard must trip so it never re-runs");

        // A user who deliberately opts out AFTER the migration stays opted out.
        let mut optout = Config::default();
        optout.filler_removal_enabled = false;
        optout.filler_removal_migrated = true;
        optout.migrate();
        assert!(!optout.filler_removal_enabled, "explicit opt-out must survive migrate");
    }

    #[test]
    fn dach_format_migrates_on_once_then_respects_optout() {
        let mut old = Config::default();
        old.dach_format_enabled = false;
        old.dach_format_migrated = false;
        old.migrate();
        assert!(old.dach_format_enabled, "old config must be flipped on once");
        assert!(old.dach_format_migrated, "guard must trip so it never re-runs");

        let mut optout = Config::default();
        optout.dach_format_enabled = false;
        optout.dach_format_migrated = true;
        optout.migrate();
        assert!(!optout.dach_format_enabled, "explicit opt-out must survive migrate");
    }
}
