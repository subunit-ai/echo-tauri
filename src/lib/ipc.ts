// Typed bridge to the Rust backend. Field names mirror `config.rs` 1:1.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface VocabEntry {
  sounds_like: string;
  write_as: string;
  aliases: string[];
  category: string;
}

export interface Config {
  hotkey: string;
  /** Hold-duration threshold (ms) before a single-key/-modifier hotkey arms
   *  dictation. Ignored for multi-key combos, which fire instantly. */
  hotkey_hold_ms: number;
  mode: string; // local | subunit
  local_model: string;
  local_device: string;
  local_fallback_autofetch: boolean;
  language: string;

  subunit_endpoint: string;
  subunit_api_key: string;

  autopaste: boolean;
  target_lock: boolean;
  show_bubble: boolean;
  mic_device_name: string;

  use_orb_overlay: boolean;
  orb_color_theme: string;
  orb_position: string;
  orb_idle_pulse: boolean;
  orb_overlay_style: string;
  orb_overlay_size: number;
  orb_overlay_auto_hide: boolean;
  /** Idle behaviour: "normal" | "dim" | "hide". */
  orb_idle_mode: string;
  /** Materialize animation on (re)appear: "bloom" | "pop" | "fade" | "none". */
  orb_appear_anim: string;
  /** Pill color mode: "color" | "idle_glass" | "glass" (always colorless). */
  orb_pill_color_mode: string;
  /** Pill reaction type (V2 dome bars): "dynamik" | "klassisch". */
  orb_pill_reaction: string;
  /** Pill visualizer: "standard" | "laufband" | "zentrum" | "welle" | "matrix". */
  orb_pill_visual: string;
  /** Pill illumination: "aus" | "status" | "siri". */
  orb_pill_glow: string;
  /** How the islands are revealed: "hover" | "click". */
  orb_trigger: string;
  orb_speed: number;
  /** Voice-reactivity of the orb/bubble meters (perceptual VU mapping). */
  orb_noise_floor: number;
  orb_gain: number;
  orb_gamma: number;
  /** Per-state orb colors (hex). working = recording + transcribing. */
  orb_color_idle: string;
  orb_color_working: string;
  orb_color_done: string;
  orb_color_error: string;

  diarization_enabled: boolean;
  diarization_max_speakers: number;

  cleanup_enabled: boolean;
  cleanup_style: string;
  cleanup_auto_mode: boolean;
  auto_mode_overrides: Record<string, string>;
  filler_removal_enabled: boolean;
  filler_removal_migrated: boolean;

  long_form_threshold_seconds: number;
  long_form_cleanup_style: string;

  synapse_save_enabled: boolean;
  /** Personal LLM coach. OFF by default and opt-in: the one learning feature
   *  that sends dictation EXCERPTS to the server (everything else stays local). */
  coach_llm_enabled: boolean;
  /** Global hotkey toggling the floating Prompt Console (empty = disabled). */
  prompt_console_hotkey: string;
  /** "Konsole als Ziel": transcripts go into the Prompt Console, not the app. */
  prompt_console_as_target: boolean;
  /** Fallback: no editable field focused → dictation lands in the Prompt Console. */
  prompt_fallback_enabled: boolean;
  /** Glass intensity of the Prompt Console: "clear" | "regular" | "rich". */
  prompt_console_glass: string;
  /** iOS native frost behind the terminal: true = hand over to desktop-blur on
   *  settle; false = stay in the flat pill-toned glass (no material switch). */
  prompt_terminal_blur: boolean;
  /** Prompt Terminal theme: "dark" | "light". */
  prompt_terminal_theme: string;
  recording_mode: string; // toggle | hold
  account_email: string;
  display_name: string; // full name — auto-seeded from JWT on login, user-editable
  nickname: string; // Spitzname — how Echo addresses the user (greeting + account panel)
  /** Equipped Wortdex title: an achievement id (learning.titles.<id>) or "" —
   *  shown on the account card and carried into the leaderboard. */
  learning_title: string;
  /** Account profile picture: versioned public URL (auth.subunit.ai, 512×512
   *  WebP) or null. Mirrored from the JWT `picture` claim on login/refresh and
   *  updated instantly after uploadAvatar/deleteAvatar. Use verbatim in <img>. */
  avatar_url: string | null;
  last_cloud_mode: string;
  auto_update_check: boolean;
  autostart_enabled: boolean;
  has_seen_onboarding: boolean;
  ui_language: string;
  ui_theme: string; // light | liquid | dark
  glass_strength: number; // liquid-glass frost step: 0 = off … 3 = strong (2 = standard)
  ui_scale: number; // overall UI zoom (1.0 = normal, down to ~0.6 = compact)

  plan: string; // free | trial | pro
  trial_started_at: number;

  subunit_access_token: string;
  subunit_refresh_token: string;
  subunit_token_issued_at: number;
  subunit_token_expires_in: number;
  subunit_workspace_id: string;

  cloud_quality_mode: string;
  gpu_aware_migrated: boolean;
  /** Live WS streaming dictation: "off" | "final" | "live". off = classic
   *  one-shot upload; final = stream for speed, paste full result on release;
   *  live = type the server-committed (stable) text into the target as you speak,
   *  tail completes on release. Cloud only; falls back to batch on any WS error. */
  streaming_mode: string;
  instant_live_typing: boolean;

  sound_enabled: boolean;
  sound_volume: number;
  /** Independent cues + selectable tone per cue (ids → lib/sounds.ts). */
  sound_start_enabled: boolean;
  sound_paste_enabled: boolean;
  sound_reward_enabled: boolean;
  sound_start_id: string;
  sound_paste_id: string;
  /** Release/stop cue on key release — its own on/off, so it no longer rides
   *  the start toggle. */
  sound_stop_enabled: boolean;
  /** Which release-cue tone plays ("standard" / "tief" / "ausklang", v0.5.93) —
   *  ids → lib/sounds.ts `STOP_SOUND_PRESETS`. */
  sound_stop_id: string;

  vocab_enabled: boolean;
  vocabulary: VocabEntry[];
  vocabulary_default_seeded: boolean;
  dach_format_enabled: boolean;
  dach_format_migrated: boolean;
  de_comma_enabled: boolean;
  de_comma_migrated: boolean;

  history_size: number;
  history: Array<Record<string, unknown>>;
  history_enabled: boolean;
  meetings: Array<Record<string, unknown>>;

  total_transcriptions: number;
  total_audio_seconds: number;
}

export const getConfig = () => invoke<Config>("get_config");
export const setConfig = (config: Config) => invoke<void>("set_config", { config });
/** Toggle launch-at-login (flips the OS autostart entry + persists). */
export const setAutostart = (enabled: boolean) =>
  invoke<void>("set_autostart", { enabled });
/** Upload a new account profile picture (raw file bytes + MIME). Resolves to
 *  the new versioned avatar URL; config.avatar_url is mirrored Rust-side
 *  (+ config-changed). Rejects with a stable error code ("too_large",
 *  "unsupported_image", "rate_limited", "unauthorized", "network", …). */
export const uploadAvatar = (bytes: number[], mime: string) =>
  invoke<string>("upload_avatar", { bytes, mime });
/** Remove the account profile picture (server + local mirror). */
export const deleteAvatar = () => invoke<void>("delete_avatar");
/** Persist a drag-set orb position (logical screen px). Takes the orb square's
 *  top-left; Rust stores the CENTRE ("center-x-y") so resizes scale in place. */
export const setOrbPosition = (x: number, y: number) =>
  invoke<void>("set_orb_position", { x, y });

// ---- Orb satellites (inline quick controls around the overlay) ----
export interface OrbQuick {
  /** "local" | "cloud" */
  mode: string;
  /** language code or "auto" */
  language: string;
  /** cleanup style, or "off" */
  cleanup: string;
}
export const orbQuick = () => invoke<OrbQuick>("orb_quick");
export const orbCycle = (which: "mode" | "language" | "cleanup") =>
  invoke<OrbQuick>("orb_cycle", { which });
/** Set one satellite directly (expanded island panels pick instead of cycling). */
export const orbSet = (which: "mode" | "language" | "cleanup", value: string) =>
  invoke<OrbQuick>("orb_set", { which, value });
/** Report the overlay's interactive rectangles (logical px, window-local: the
 *  orb plus any visible chips / the open panel) so the Rust hit-test makes the
 *  window mouse-opaque ONLY over them — the transparent gaps between stay
 *  click-through, so clicks land on the app behind the overlay. `panel` labels a
 *  satellite's zone (mode/language/cleanup) so the Rust poll can tell us which
 *  panel to OPEN — DOM hover doesn't fire while the overlay window isn't focused. */
export const overlaySetHotRects = (
  rects: { x: number; y: number; w: number; h: number; panel?: string }[],
) => invoke<void>("overlay_set_hot_rects", { rects });

// ---- Orb profiles (per-account, local-first, cloud-synced) ----------------
// A profile is the FULL orb look. `payload` is an opaque blob (forward-compatible
// for the future configurator); the known shape today:
export interface OrbProfilePayload {
  colors?: { idle?: string; working?: string; done?: string; error?: string };
  style?: string;
  speed?: number;
  idle_mode?: string;
  idle_pulse?: boolean;
  size?: number;
  reactivity?: { noise_floor?: number; gain?: number; gamma?: number };
}
export interface OrbProfile {
  id: string;
  name: string;
  payload: OrbProfilePayload;
  updated_at: number;
}
/** All of the current account's saved orb profiles (newest-first). */
export const listOrbProfiles = () => invoke<OrbProfile[]>("list_orb_profiles");
/** Create (omit id) or update a profile. payload omitted → snapshot current look. Returns id. */
export const saveOrbProfile = (name: string, payload?: OrbProfilePayload, id?: string) =>
  invoke<string>("save_orb_profile", { id: id ?? null, name, payload: payload ?? null });
/** Apply a saved profile's look to the live orb. */
export const applyOrbProfile = (id: string) => invoke<void>("apply_orb_profile", { id });
export const renameOrbProfile = (id: string, name: string) =>
  invoke<void>("rename_orb_profile", { id, name });
export const deleteOrbProfile = (id: string) => invoke<void>("delete_orb_profile", { id });
export const duplicateOrbProfile = (id: string, name: string) =>
  invoke<string>("duplicate_orb_profile", { id, name });

export const appVersion = () => invoke<string>("app_version");
/** "Echo fragen" — grounded help assistant. Resolves to the answer, throws on failure. */
export const helpAsk = (question: string, knowledge: string, language: string) =>
  invoke<string>("help_ask", { question, knowledge, language });
export const listAudioDevices = () => invoke<string[]>("list_audio_devices");
/** Copy text to the clipboard (History action). */
export const copyText = (text: string) => invoke<void>("copy_text", { text });
/** Open ~/.config/echo in the OS file manager. */
export const openConfigDir = () => invoke<void>("open_config_dir");
/** Open an external URL in the default browser. */
export const openExternal = (url: string) => invoke<void>("open_external", { url });
// ---- History + meetings (SQLite store, echo.db) ----
export interface HistoryEntry {
  id: number;
  ts: number;
  text: string;
  quality_mode: string;
  style: string;
  latency_ms: number | null;
  duration_s: number | null;
}
/** Newest-first history page; `query` = substring search on the text. */
export const historyList = (query = "", limit = 200, offset = 0) =>
  invoke<HistoryEntry[]>("history_list", { query, limit, offset });
/** Total stored history entries. */
export const historyCount = () => invoke<number>("history_count");

/** Real, account-scoped lifetime usage for the Home dashboard. Accumulated from
 * every completed dictation; `time_saved_seconds` is a genuine typing-vs-speaking
 * calculation, not a decorative multiplier. */
export interface AccountStats {
  transcriptions: number;
  audio_seconds: number;
  words: number;
  chars: number;
  time_saved_seconds: number;
}
export const accountStats = () => invoke<AccountStats>("account_stats");
/** Delete one history entry by its store id. */
export const deleteHistoryEntry = (id: number) =>
  invoke<void>("delete_history_entry", { id });
/** Clear the whole transcription history. */
export const clearHistory = () => invoke<void>("clear_history");

// ── Auto-vocabulary ────────────────────────────────────────────────────────
/** A detected recurring mis-heard term (cluster of spelling variants). */
export type VocabCandidate = {
  key: string;
  /** [variant, count] pairs, most frequent first. */
  variants: [string, number][];
  total: number;
  /** Backend-guessed correct spelling (null if it couldn't guess). */
  suggestion: string | null;
  confidence: number | null;
  status: "pending" | "added" | "ignored";
  added_term: string | null;
  updated_at: number;
};
/** Candidates by status: "pending" (ask) or "added" (auto-learned). */
export const vocabCandidates = (status: "pending" | "added" = "pending") =>
  invoke<VocabCandidate[]>("vocab_candidates", { status });
/** Trigger a background scan of recent history for new candidates. */
export const vocabScan = () => invoke<void>("vocab_scan");
/** Confirm a pending suggestion (spelling may be edited) → learn it. */
export const vocabConfirm = (key: string, spelling: string) =>
  invoke<void>("vocab_confirm", { key, spelling });
/** Dismiss a candidate so it never resurfaces. */
export const vocabIgnore = (key: string) => invoke<void>("vocab_ignore", { key });
/** Undo an auto-learned term (removes its vocab entry). */
export const vocabUndo = (key: string) => invoke<void>("vocab_undo", { key });
/** Fired after a transcription lands in the store — refresh history views. */
export const onHistoryChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("echo://history-changed", () => cb());

export interface MeetingEntry {
  id: number;
  ts: number;
  text: string;
  quality_mode?: string;
  duration_s?: number;
  speaker_text?: string;
}
/** All stored meetings, newest first. */
export const meetingsList = () => invoke<MeetingEntry[]>("meetings_list");
/** Re-process a stored meeting with a cleanup style → returns the styled text. */
export const processMeeting = (id: number, style: string) =>
  invoke<string>("process_meeting", { id, style });

// ---- Local whisper models ----
export interface ModelInfo {
  key: string;
  label: string;
  downloaded: boolean;
  size_mb: number;
}
export interface ModelProgress {
  model: string;
  received?: number;
  total?: number;
  done?: boolean;
  error?: string;
}
export interface HardwareInfo {
  summary: string;
  recommended_model: string;
  ram_gb: number;
  cpu_cores: number;
  gpu_build: boolean;
  /** std::env::consts::OS / ARCH — shown in the local-meet device scan. */
  os: string;
  arch: string;
}
export const hardwareInfo = () => invoke<HardwareInfo>("hardware_info");
export const listLocalModels = () => invoke<ModelInfo[]>("list_local_models");
export const downloadModel = (model: string) => invoke<void>("download_model", { model });
export const deleteLocalModel = (model: string) => invoke<void>("delete_local_model", { model });
export const onModelProgress = (cb: (p: ModelProgress) => void): Promise<UnlistenFn> =>
  listen<ModelProgress>("echo://model-progress", (e) => cb(e.payload));

// ---- Engine events (emitted from Rust) ----
export type EngineState =
  | "idle"
  | "recording"
  | "transcribing"
  | "done"
  | "error";

export interface StatePayload {
  state: EngineState;
  detail?: string;
}
export interface LevelPayload {
  level: number;
}
export interface TranscriptPayload {
  text: string;
  quality_mode: string;
}

export const onState = (cb: (p: StatePayload) => void): Promise<UnlistenFn> =>
  listen<StatePayload>("echo://state", (e) => cb(e.payload));
/** Emitted by Rust when the config changed from outside the main window (e.g. an
 *  orb-satellite cycle or a drag) — the main window should reload to stay in sync. */
export const onConfigChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("echo://config-changed", () => cb());
export const onLevel = (cb: (p: LevelPayload) => void): Promise<UnlistenFn> =>
  listen<LevelPayload>("echo://mic-level", (e) => cb(e.payload));
export const onTranscript = (
  cb: (p: TranscriptPayload) => void,
): Promise<UnlistenFn> =>
  listen<TranscriptPayload>("echo://transcript", (e) => cb(e.payload));
/** Live partial transcript while streaming dictation — DISPLAY ONLY (a live
 *  caption); never drives the paste. Fires only when streaming_mode != "off". */
export const onStreamPartial = (cb: (text: string) => void): Promise<UnlistenFn> =>
  listen<string>("echo://stream-partial", (e) => cb(e.payload));

// ---- Auto-update ----
/** Check for an update; resolves to the new version string, or null if current. */
export const checkForUpdates = () => invoke<string | null>("check_for_updates");
/** One-click: download + install + relaunch (silent). Resolves false if nothing
 *  to install; on success the app restarts and this never resolves. */
export const installUpdate = () => invoke<boolean>("install_update");
/** Emitted by the startup auto-check when a newer version is available. */
export const onUpdateAvailable = (cb: (version: string) => void): Promise<UnlistenFn> =>
  listen<string>("echo://update-available", (e) => cb(e.payload));
/** Download progress (0–100) while installing an update. */
export const onUpdateProgress = (cb: (pct: number) => void): Promise<UnlistenFn> =>
  listen<number>("echo://update-progress", (e) => cb(e.payload));

// ---- Session / auth state ----
/** True when the user was signed in but the cloud session is gone (a rejected
 *  refresh dropped both tokens). Queried on mount to seed the re-login banner;
 *  thereafter the session-expired/restored events keep it live. */
export const authSessionExpired = () => invoke<boolean>("auth_session_expired");
/** Fired when a background token refresh is rejected → the user must sign in again. */
export const onSessionExpired = (cb: () => void): Promise<UnlistenFn> =>
  listen("echo://session-expired", () => cb());
/** Fired when the session is restored (successful refresh or a fresh sign-in). */
export const onSessionRestored = (cb: () => void): Promise<UnlistenFn> =>
  listen("echo://session-restored", () => cb());

/** Allocate + open a meeting (meet.subunit.ai). */
export const startMeeting = () => invoke("start_meeting");
/** Start local dual-audio meeting recording (mic + system loopback). Windows-only. */
export const startMeetingRecording = () => invoke<void>("start_meeting_recording");
/** Stop + transcribe the meeting recording; resolves to the transcript text. */
export const stopMeetingRecording = () => invoke<string>("stop_meeting_recording");
/** Emitted when a Teams/Zoom/Meet meeting is auto-detected (see meeting_detect.rs). */
export const onMeetingDetected = (cb: (app: string) => void): Promise<UnlistenFn> =>
  listen<{ app: string }>("echo://meeting-detected", (e) => cb(e.payload.app));

/** macOS only: emitted when auto-paste was blocked because the app lacks the
 *  Accessibility permission (synthetic Cmd+V silently no-ops without it). The
 *  text is already on the clipboard, so a manual paste still works. */
export const onNeedsAccessibility = (cb: () => void): Promise<UnlistenFn> =>
  listen("echo://needs-accessibility", () => cb());

// ---- Mode helpers (BigModeSwitch <-> config) ----
export type UiMode = "local" | "cloud";

export function uiModeOf(c: Config): UiMode {
  return c.mode === "local" ? "local" : "cloud";
}

export function patchForUiMode(m: UiMode): Partial<Config> {
  switch (m) {
    case "local":
      return { mode: "local" };
    case "cloud":
      return { mode: "subunit", last_cloud_mode: "subunit" };
  }
}

// ---- Lokales Meet-Backend (Pro, Cargo-Feature local-meet) ----

export interface MeetLocalAvailability {
  built: boolean;
  plan_ok: boolean;
  hw_ok: boolean;
  speaker_model: boolean;
  active: boolean;
}

export interface MeetLocalParticipant {
  name: string;
  code: string;
  enrolled: boolean;
}

export interface MeetLocalSnapshot {
  phase: "recording" | "processing" | "done" | "error";
  message?: string;
  meeting_id: string;
  duration_s: number;
  participants: MeetLocalParticipant[];
  checkin_active: string | null;
  checkin_result: string | null;
  segments_done: number;
  level: number;
}

export const meetLocalAvailable = () => invoke<MeetLocalAvailability>("meet_local_available");
export const meetLocalStart = () => invoke<void>("meet_local_start");
export const meetLocalAddParticipant = (name: string) =>
  invoke<string>("meet_local_add_participant", { name });
export const meetLocalCheckin = (name: string) => invoke<void>("meet_local_checkin", { name });
export const meetLocalStatus = () => invoke<MeetLocalSnapshot | null>("meet_local_status");
export const meetLocalStop = () => invoke<void>("meet_local_stop");
export const meetLocalDismiss = () => invoke<void>("meet_local_dismiss");
export const meetLocalList = () => invoke<Record<string, unknown>[]>("meet_local_list");
export const meetLocalGet = (id: string) =>
  invoke<{ meeting: Record<string, unknown>; transcript: string }>("meet_local_get", { id });
export const onMeetLocal = (cb: (s: MeetLocalSnapshot) => void): Promise<UnlistenFn> =>
  listen<MeetLocalSnapshot>("echo://meet-local", (e) => cb(e.payload));

// ---- Activity & Learning ----

export interface ActivityDay {
  day: string;
  transcriptions: number;
  words: number;
  audio_seconds: number;
  time_saved_seconds: number;
}
export const activityDaily = (days = 30) => invoke<ActivityDay[]>("activity_daily", { days });

export interface ActivityHour {
  hour: number;
  transcriptions: number;
}
export const activityHourly = (days = 30) => invoke<ActivityHour[]>("activity_hourly", { days });

export interface WordFreq {
  word: string;
  count: number;
}
export const activityWordFrequency = (limit = 40, days = 90) =>
  invoke<WordFreq[]>("activity_word_frequency", { limit, days });

export interface Streak {
  current: number;
  longest: number;
  last_active_day: string | null;
  active_today: boolean;
}
export const activityStreak = () => invoke<Streak>("activity_streak");

export interface ActivityTotals {
  transcriptions: number;
  words: number;
  audio_seconds: number;
  time_saved_seconds: number;
}
export interface PeriodSum {
  words: number;
  transcriptions: number;
  time_saved_seconds: number;
}
export interface ActivityOverview {
  total: ActivityTotals;
  /** Earliest day with day-resolved stats — everything before it only exists
   *  in the lifetime totals (drives the honest partial-range hint). */
  daily_since: string | null;
  daily_words: number;
  daily_transcriptions: number;
  today: PeriodSum;
  this_week: PeriodSum;
  streak: { current: number; longest: number };
  goals: { daily_word_goal: number; weekly_word_goal: number };
}
export const activityOverview = () => invoke<ActivityOverview>("activity_overview");

export interface LearningAnalysis {
  window_days: number;
  sample_transcriptions: number;
  total_words: number;
  unique_words: number;
  type_token_ratio: number;
  avg_sentence_length: number;
  filler_counts: WordFreq[];
  top_words: WordFreq[];
  overused_words: { word: string; count: number; ratio: number }[];
  weak_words: WordFreq[];
}
export const learningAnalysis = (days = 30) => invoke<LearningAnalysis>("learning_analysis", { days });

export interface WordAlternative {
  word: string;
  note?: string;
}
export interface WordSuggestion {
  word: string;
  count: number;
  alternatives: WordAlternative[];
  example?: string;
}
export interface LearningSuggestions {
  source: "local" | "llm";
  suggestions: WordSuggestion[];
}
/** Curated local suggestions — instant, and guaranteed never to touch the
 *  network. Paint these first. */
export const learningSuggestions = (days = 30) =>
  invoke<LearningSuggestions>("learning_suggestions", { days });

/** The LLM-refined variant of the same list. Split out on purpose: it may cross
 *  the network (the server curates with an LLM), which used to stall the whole
 *  coach behind a 30 s round trip on every dictation. Callers render the local
 *  set immediately and swap this in when — and only if — it lands. */
export const learningSuggestionsLlm = (days = 30) =>
  invoke<LearningSuggestions>("learning_suggestions_llm", { days });

/** Fillers Echo actually STRIPPED from your dictations, counted at removal
 *  time. They cannot be recovered from the history: what gets stored is the
 *  already-cleaned transcript, so the removed ones are gone from it by
 *  definition — hence their own counter. */
export const fillerRemovedCounts = (days = 30) =>
  invoke<WordFreq[]>("filler_removed_counts", { days });

export interface Goals {
  daily_word_goal: number;
  weekly_word_goal: number;
}
export const goalsGet = () => invoke<Goals>("goals_get");
export const goalsSet = (goals: Goals) => invoke<void>("goals_set", { goals });

export const activityExport = (kind: "csv" | "json" | "png", filename: string, contentsB64: string) =>
  invoke<string>("activity_export", { kind, filename, contentsB64 });

export interface WordOfDay {
  word: string;
  meaning: string;
  example: string;
  synonyms: string[];
  /** Used in a dictation TODAY (XP ledger truth, not the old 30-day scan). */
  already_used: boolean;
  xp: number;
}
export const wordOfDay = () => invoke<WordOfDay>("word_of_day");

// ---- Learning gamification (XP, rewards, leaderboard) ----

export interface LearningEvent {
  ts: number;
  day: string;
  kind: "word_of_day" | "coach_word" | "word_find" | "prompt_pattern";
  word: string;
  xp: number;
}
export interface LearningXp {
  xp_total: number;
  xp_week: number;
  level: number;
  level_floor_xp: number;
  next_level_xp: number;
  wod_used_today: boolean;
  distinct_words: number;
  events: LearningEvent[];
}
export const learningXp = () => invoke<LearningXp>("learning_xp");

/** Leaderboard prestige tiers as the server returns them: three positional
 *  slots (legacy field names) now carrying [Episch, Mythisch, Legendär]. */
export interface LeaderboardBands {
  notable: number; // Episch
  rare: number; // Mythisch
  legendary: number; // Legendär
}
export interface LeaderboardRow {
  rank: number;
  name: string;
  xp: number;
  words: number;
  me?: boolean;
  /** Server-side additions (newer servers only — treat as optional). `xp_total`
   *  is the lifetime XP that drives the row's level ring; `title` is an equipped
   *  achievement id (learning.titles.<id>). Both may be absent on old servers. */
  xp_total?: number;
  title?: string;
  /** Earned achievement ids (see ACHIEVEMENTS / learning.ach.<id>). Absent on
   *  old servers — callers must degrade gracefully (hide, don't show all-locked). */
  achievements?: string[];
  /** The member's three PRESTIGE Wortdex tiers [Episch, Mythisch, Legendär] —
   *  the top three of the six local tiers. The server keeps three band slots
   *  (legacy field names), so this stays a 3-field object, decoupled from the
   *  local 6-tier BandCounts. Absent on old servers. */
  bands?: LeaderboardBands;
  /** Account profile-picture URL (auth.subunit.ai), mirrored from the member's
   *  last score push. Absent on old servers / old clients → the row falls back
   *  to initials. */
  avatar?: string | null;
}
export interface Leaderboard {
  available: boolean;
  week?: LeaderboardRow[];
  total?: LeaderboardRow[];
  me?: { rank_week: number | null; rank_total: number | null };
}
export const learningLeaderboard = () => invoke<Leaderboard>("learning_leaderboard");

/** Every kind the award paths actually emit — vocabulary, dojo drills, katas
 *  and prompt patterns all celebrate through this one event. */
export type RewardKind =
  | "word_of_day"
  | "coach_word"
  | "dojo"
  | "kata"
  | "kata_train"
  | "prompt_pattern";

export interface LearningReward {
  events: { kind: RewardKind; word: string; xp: number }[];
  xp_total: number;
  level: number;
}
export const onLearningReward = (cb: (r: LearningReward) => void): Promise<UnlistenFn> =>
  listen<LearningReward>("echo://learning-reward", (e) => cb(e.payload));

/** Today's XP menu for the daily-tasks card — every way to earn XP right now,
 *  each with its reward and done state, straight from the local ledgers. */
export interface DailyTasks {
  wod: { word: string; xp: number; done: boolean };
  coach: { words: string[]; xp_each: number; earned_today: number; cap: number };
  dojo: { kind: string; xp: number; done: boolean };
  kata: { train_done: boolean; train_xp: number; next: string | null; next_xp: number };
  pattern: { id: string; xp: number; done: boolean };
  finds: { today: number; cap: number };
}
export const learningDailyTasks = () => invoke<DailyTasks>("learning_daily_tasks");

// ---- Wortdex (collectible rare words) + achievements ----

/** Rarity band of a collectible word (higher = rarer, mirrors rarity::Band):
 *  1 Gewöhnlich · 2 Ungewöhnlich · 3 Selten · 4 Episch · 5 Mythisch · 6 Legendär. */
export type Band = 1 | 2 | 3 | 4 | 5 | 6;

/** Per-band find totals, indexed by band-1: [0]=Gewöhnlich … [5]=Legendär. */
export type BandCounts = [number, number, number, number, number, number];

/** One collected word in the Wortdex. `dex` is its immutable "Nr." in the
 *  rarity table; `context` is the (possibly empty) first-sighting sentence;
 *  `count` is how often it has been spoken. Epoch SECONDS for the timestamps. */
export interface WordFind {
  word: string;
  display: string;
  band: Band;
  dex: number;
  count: number;
  first_ts: number;
  last_ts: number;
  context: string;
  /** How it entered the collection: "found" = spoken spontaneously, "learned" =
   *  a word the coach taught first and you then used. Older rows read "found". */
  origin: string;
}
export interface WortdexData {
  finds: WordFind[];
  counts: BandCounts;
}
/** The whole collection, newest-first, plus per-band totals. 100 % local. */
export const wortdexList = () => invoke<WortdexData>("wortdex_list");

/** A milestone. `id` doubles as an equippable account title
 *  (learning.titles.<id>); `earned_ts` is set only for the datable ones. */
export interface Achievement {
  id: string;
  target: number;
  progress: number;
  earned: boolean;
  earned_ts: number | null;
}
export const achievementsList = () => invoke<Achievement[]>("achievements_list");

/** Fired at most once per dictation, for the rarest NEW collectible word. */
export interface WordFindEvent {
  word: string;
  display: string;
  band: Band;
  dex: number;
  xp: number;
  counts: BandCounts;
}
export const onWordFind = (cb: (f: WordFindEvent) => void): Promise<UnlistenFn> =>
  listen<WordFindEvent>("echo://word-find", (e) => cb(e.payload));

// ---- Sprechprofil (rhetoric analysis radar) --------------------------------
// Deterministic, 100 % local analysis of HOW the user speaks across six
// dimensions. The engine (src-tauri) computes these from the dictation history;
// this UI only displays them. `score` is always 0–100 (higher = better);
// `metrics` carry the raw sub-values that make up the score, each `value` in the
// unit the UI formats per metric key (rates per 1000 words, shares 0–1, counts…).

/** One raw sub-value behind a dimension score (e.g. mtld, hedgeRate). The `key`
 *  drives its label, tooltip and number formatting in the UI. */
export interface SpeechMetric {
  key: string;
  value: number;
}

/** One of the six rhetoric dimensions: variety | precision | clarity |
 *  structure | active | fluency. `score` 0–100, `metrics` its raw inputs. */
export interface SpeechDimension {
  key: string;
  score: number;
  metrics: SpeechMetric[];
}

/** A detected trend worth surfacing. `severity`: 1 = praise/info (green),
 *  2 = neutral hint, 3 = clear amber flag. `delta` is a fraction (0.31 = 31 %),
 *  interpolated into the finding/tip text as a percentage. */
export interface SpeechInsight {
  id: string;
  severity: 1 | 2 | 3;
  delta: number;
}

/** The comparison baseline ("ghost") — the previous window's scores, drawn as a
 *  dimmed polygon behind the current one so progress is visible at a glance. */
export interface SpeechGhost {
  overall: number;
  /** dimension key → score (0–100). */
  scores: Record<string, number>;
}

export interface SpeechProfile {
  window_days: number;
  total_words: number;
  /** False → too few analysed words for meaningful scores; show the hint. */
  enough_data: boolean;
  overall: number;
  dimensions: SpeechDimension[];
  ghost: SpeechGhost | null;
  insights: SpeechInsight[];
}

/** One day in the trend: the overall score, per-dimension scores and the word
 *  count that day. Ascending by day. */
export interface SpeechTrendDay {
  day: string;
  overall: number;
  scores: Record<string, number>;
  words: number;
}

export interface SpeechTrend {
  days: SpeechTrendDay[];
}

/** The full profile over the last `days` (7 / 30 / 90). 100 % local. */
export const speechProfile = (days = 30) =>
  invoke<SpeechProfile>("speech_profile", { days });
/** The day-by-day score trend that feeds the per-dimension sparklines. */
export const speechProfileTrend = (days = 30) =>
  invoke<SpeechTrend>("speech_profile_trend", { days });

// ---- Personal coach (LLM) --------------------------------------------------
// The ONE learning feature that sends dictation excerpts off the device, so it
// only ever returns content when the user opted in (config.coach_llm_enabled).

/** One concrete lever, with a rewrite of the user's OWN sentence when the model
 *  found a fitting one (`before`/`after` may be empty). */
export interface CoachImprovement {
  title: string;
  advice: string;
  before: string;
  after: string;
}
export interface CoachWord {
  word: string;
  why: string;
}
export interface LearningCoachResult {
  /** False whenever the coach is off, not subscribed, has too little history,
   *  or the lane failed — the UI then simply keeps its local content. */
  available: boolean;
  verdict?: string;
  strengths?: string[];
  improvements?: CoachImprovement[];
  words?: CoachWord[];
}
export const learningCoach = (days = 30) =>
  invoke<LearningCoachResult>("learning_coach", { days });

// ---- Lern-Loop (Welle 3): ownership levels, weekly pack, weekly report ------
// The coach stops being a static readout and starts to *teach*: every word Echo
// puts in front of you climbs through ownership levels as you actually use it in
// real dictations (spaced repetition), a personalised 7-word pack is curated for
// you each week, and a Monday week-in-review recaps the momentum. All server
// truth — the UI only renders it.

/** Ownership level of a taught word, earned by using it in real dictations:
 *  used → fortified → mastered (higher = more firmly yours). */
export type WordStage = "used" | "fortified" | "mastered";

/** One taught word's ownership state. `use_days` is the number of DISTINCT days
 *  it was spoken; `due` marks that its next spaced-repetition slot is open — the
 *  word is waiting to be used again to level up. Dates are `YYYY-MM-DD`. */
export interface WordProgress {
  word: string;
  stage: WordStage;
  use_days: number;
  first_day: string;
  last_day: string;
  due: boolean;
}
export interface WordsProgress {
  /** Due words first, then the rest. */
  words: WordProgress[];
  due_count: number;
}
/** Ownership levels for every taught word (spaced repetition over real
 *  dictations). Local truth; refreshes as dictations land. */
export const wordsProgress = () =>
  invoke<WordsProgress>("learning_words_progress");

/** Where a weekly pack came from: `llm` = freshly curated, `none` = not curated
 *  for this week yet, `error` = a fetch attempt failed (keep the cached pack). */
export type WordPackSource = "llm" | "none" | "error";

/** One curated pack word: the word, what it means, a worked example, and a
 *  personal reason it was chosen for THIS speaker. `use_days` mirrors the
 *  ownership counter so the pack can show progress dots. */
export interface WordPackItem {
  word: string;
  meaning: string;
  example: string;
  why: string;
  use_days: number;
}
export interface WordPack {
  /** Monday of the pack's week (`YYYY-MM-DD`). */
  week: string;
  source: WordPackSource;
  words: WordPackItem[];
}
/** This week's personalised 7-word pack. `source: "none"` = not curated yet
 *  (offer the curate button). Instant/local read of the cached pack. */
export const wordPackGet = () => invoke<WordPack>("word_pack_get");
/** Curate this week's pack on the server with an LLM. SLOW — up to ~50 s — so
 *  the caller shows a loading state with the "~40 seconds" hint. Resolves with
 *  `source: "error"` on failure (toast + keep the cached pack). */
export const wordPackFetch = () => invoke<WordPack>("word_pack_fetch");

/** Last completed week's review. `week_prev` is that week's Monday; `xp_before`
 *  is the XP total the week before it, so the card can show a delta. */
export interface WeeklyReport {
  week_prev: string;
  xp: number;
  xp_before: number;
  finds: number;
}
/** The most recent weekly report, or null if none has been generated yet. */
export const weeklyReportGet = () =>
  invoke<WeeklyReport | null>("weekly_report_get");
/** Fired Monday morning when a fresh weekly report is ready — update the card. */
export const onWeeklyReport = (cb: (r: WeeklyReport) => void): Promise<UnlistenFn> =>
  listen<WeeklyReport>("echo://weekly-report", (e) => cb(e.payload));

// ---- Rhetorik-Dojo (Welle 4): spoken micro-workouts ------------------------
// One short spoken drill a day. The server hands out today's exercise (one of
// three kinds), Echo records + transcribes it against a countdown, and the
// server scores it 0–100 with a per-kind breakdown and XP. All server truth —
// this UI only renders the exercise, drives the recorder, and shows the verdict.

/** Which drill today is:
 *  - `gauntlet` (Füllwort-Gauntlet) — speak about `topic` with zero fillers.
 *  - `tabu` (Tabu) — explain `term` without saying any of the `taboo` words.
 *  - `better` (Sag es besser) — reformulate `weak_sentence` more powerfully.
 *  - `golf` (Prompt-Golf) — dictate a prompt for the AI task in `topic`; scored
 *    against the 5-criterion prompt rubric (breakdown carries `rubric`). */
export type DojoKind = "gauntlet" | "tabu" | "better" | "golf";

/** Today's exercise. Which of `topic` / `term`+`taboo` / `weak_sentence` is
 *  populated depends on `kind`; the others are null. `seconds` is the recording
 *  budget (45), `xp` the reward, `done_today` whether it was already completed
 *  for XP today (a repeat is allowed but grants none). */
export interface DojoToday {
  kind: DojoKind;
  topic: string;
  term: string | null;
  taboo: string[] | null;
  weak_sentence: string | null;
  seconds: number;
  xp: number;
  done_today: boolean;
}
export const dojoToday = () => invoke<DojoToday>("dojo_today");

/** The scored per-kind breakdown of one workout. `violations` are the taboo
 *  words that were actually spoken (tabu kind); `fillers` the filler count
 *  (gauntlet); `weak`/`vague`/`elevated` the word-quality tallies (better);
 *  `too_short` flags a take too brief to score fairly. */
export interface DojoBreakdown {
  words: number;
  fillers: number;
  violations: string[];
  weak: number;
  vague: number;
  elevated: number;
  too_short: boolean;
  /** Golf kind only: which of the five prompt-rubric criteria the dictated
   *  prompt satisfied (deterministic, local). Absent for the other kinds. */
  rubric?: PromptRubric;
}
/** A completed workout's verdict. `xp_awarded` is 0 on a same-day repeat. */
export interface DojoResult {
  transcript: string;
  score: number;
  xp_awarded: number;
  breakdown: DojoBreakdown;
}
/** Arm the dojo recorder. Throws "busy" if a dictation is already running. */
export const dojoRecordStart = () => invoke<void>("dojo_record_start");
/** Mic level 0..1 while recording — poll ~80 ms for the pulse visualisation. */
export const dojoRecordLevel = () => invoke<number>("dojo_record_level");
/** Tear the recorder down without scoring (cancel / unmount safety-net). */
export const dojoRecordCancel = () => invoke<void>("dojo_record_cancel");
/** Stop + transcribe + score. Async — takes the transcription time. */
export const dojoRecordStop = () => invoke<DojoResult>("dojo_record_stop");

/** A weekly quest. `id` picks its i18n name/description (learning.dojo.quest.<id>);
 *  `progress`/`target` drive the bar and the completed check. */
export interface Quest {
  id: "workouts_3" | "coach_5" | "find_1";
  progress: number;
  target: number;
}
export interface QuestsData {
  quests: Quest[];
}
/** This week's quests + their live progress. Local truth; refreshes as
 *  dictations and workouts land. */
export const questsGet = () => invoke<QuestsData>("quests_get");

// ---- Prompt-Coach (Welle 5): silent prompt scoring + pattern of the day ------
// Echo now recognises dictations aimed at AI tools (Cursor, Claude, ChatGPT, the
// Prompt Console …) as *prompts* and quietly scores each against a 5-criterion
// rubric (goal · context · constraints · format · negative instructions, 20 pts
// each, deterministic + local). This surface shows how well the user prompts,
// what is systematically missing, and a daily "pattern" to practise. All server/
// engine truth — the UI only renders it.

/** The five prompt-quality criteria, each a boolean (satisfied or not). The same
 *  five back the 0..1 `rubric_rates` in the stats and the golf-drill checks. */
export interface PromptRubric {
  /** A clear ask/objective is stated. */
  goal: boolean;
  /** Relevant background/context is supplied. */
  context: boolean;
  /** Boundaries/requirements are given (length, style, must-haves). */
  constraints: boolean;
  /** The desired output shape is named (list, table, JSON …). */
  format: boolean;
  /** What to avoid is spelled out (negative instructions). */
  negative: boolean;
}

/** The five rubric criteria in canonical display order. */
export const PROMPT_RUBRIC_KEYS = [
  "goal",
  "context",
  "constraints",
  "format",
  "negative",
] as const;
export type PromptRubricKey = (typeof PROMPT_RUBRIC_KEYS)[number];

/** One AI tool the user prompted, with its prompt count and mean score. */
export interface PromptByApp {
  app: string;
  n: number;
  avg: number;
}

/** One day of the prompt-score trend (ascending by day). `avg` is that day's
 *  mean prompt score, `n` the number of prompts. */
export interface PromptTrendDay {
  day: string;
  avg: number;
  n: number;
}

/** One recent prompt: when, which tool, its score, and a short head/preview. */
export interface PromptRecent {
  ts: number;
  app: string;
  score: number;
  head: string;
}

export interface PromptCoachStats {
  /** False → too few scored prompts for meaningful stats; show the empty state. */
  enough: boolean;
  /** Prompts scored in the window. */
  prompts: number;
  /** Mean prompt score (0–100). */
  avg_score: number;
  /** Share (0..1) of prompts satisfying each rubric criterion. */
  rubric_rates: Record<PromptRubricKey, number>;
  by_app: PromptByApp[];
  trend: PromptTrendDay[];
  recent: PromptRecent[];
}
/** Aggregate prompt-coaching stats over the last `days` (7 / 30 / 90). 100 % local. */
export const promptCoachStats = (days = 30) =>
  invoke<PromptCoachStats>("prompt_coach_stats", { days });

/** Today's prompt "pattern" — a single prompting technique to practise (like the
 *  word of the day). `id` picks its i18n name/desc/example (12 ids: role,
 *  context_anchor, constraints_first, output_format, negative, few_shot,
 *  step_by_step, audience, tone, iterate, sources, length). `done_today` is set
 *  once the user actually applied it in a real prompt (grants `xp`, once/day). */
export interface PromptPatternToday {
  id: string;
  xp: number;
  done_today: boolean;
}
export const promptPatternToday = () =>
  invoke<PromptPatternToday>("prompt_pattern_today");

// ---- Kata-Pfad (Prompt-Dojo, Welle 6) --------------------------------------
// The prompting curriculum: seven linear katas, each a spoken mission scored
// against the same 5-criterion prompt rubric. Passing a kata (its focus
// criterion met AND the score ≥ its threshold) unlocks the next and drives the
// belt (Obi) rank. All server/engine truth — this UI renders the path, drives
// the recorder (kata_record_*, mirroring the Dojo quartet) and shows the verdict.

/** A kata's lifecycle: `done` (completed), `open` (the first not-yet-completed —
 *  trainable), `locked` (still sealed). done + open are both trainable. */
export type KataState = "done" | "open" | "locked";

/** The next belt's remaining deltas, or null at the top rank (black). */
export interface BeltNext {
  rank: string;
  need_katas: number;
  need_days: number;
  need_high: number;
}

/** The belt (Obi) standing: rank (white…black) + the three counters that feed
 *  it, plus the deltas to the next rank. Recomputed after every kata take. */
export interface Belt {
  rank: string;
  katas_done: number;
  training_days: number;
  high_scores: number;
  next: BeltNext | null;
}

/** One kata in the path. `idx` is 1-based; `focus` is the criterion the pass
 *  hinges on (`goal`|`context`|`format`|`constraints`|`negative`, `example` for
 *  kata 6, `all` for the master exam); `threshold` is the score bar. */
export interface KataInfo {
  id: string;
  idx: number;
  state: KataState;
  best_score: number;
  threshold: number;
  focus: string;
}

/** The whole path snapshot: the belt, the seven katas, and the recording budget
 *  in seconds (60). */
export interface KataList {
  belt: Belt;
  katas: KataInfo[];
  seconds: number;
}
export const kataList = () => invoke<KataList>("kata_list");

/** A completed kata take's verdict. `rubric` is the same 5-criterion structure
 *  as PromptRubric; `focus_pass` = the focus criterion was met; `passed` =
 *  focus_pass && score ≥ threshold (kata 7: score == 100); `first_pass` = this
 *  take flipped completed 0→1; `belt` is the standing AFTER the update; `belt_up`
 *  is the new rank if this take promoted, else null; `xp_awarded` is the XP
 *  actually credited (0 / 10 / 50 / 60). */
export interface KataResult {
  transcript: string;
  score: number;
  rubric: PromptRubric;
  focus_pass: boolean;
  passed: boolean;
  first_pass: boolean;
  best_score: number;
  xp_awarded: number;
  belt: Belt;
  belt_up: string | null;
}
/** Arm the kata recorder for `kata`. Throws "busy" if a dictation is running,
 *  "locked" if the kata is still sealed. */
export const kataRecordStart = (kata: string) =>
  invoke<void>("kata_record_start", { kata });
/** Mic level 0..1 while recording — poll ~80 ms for the pulse. */
export const kataRecordLevel = () => invoke<number>("kata_record_level");
/** Tear the recorder down without scoring (cancel / unmount safety-net). */
export const kataRecordCancel = () => invoke<void>("kata_record_cancel");
/** Stop + transcribe (raw) + score `kata`. Async — takes the transcription time. */
export const kataRecordStop = (kata: string) =>
  invoke<KataResult>("kata_record_stop", { kata });
