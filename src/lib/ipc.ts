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
export const learningSuggestions = (days = 30) =>
  invoke<LearningSuggestions>("learning_suggestions", { days });

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
  kind: "word_of_day" | "coach_word";
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

export interface LeaderboardRow {
  rank: number;
  name: string;
  xp: number;
  words: number;
  me?: boolean;
}
export interface Leaderboard {
  available: boolean;
  week?: LeaderboardRow[];
  total?: LeaderboardRow[];
  me?: { rank_week: number | null; rank_total: number | null };
}
export const learningLeaderboard = () => invoke<Leaderboard>("learning_leaderboard");

export interface LearningReward {
  events: { kind: "word_of_day" | "coach_word"; word: string; xp: number }[];
  xp_total: number;
  level: number;
}
export const onLearningReward = (cb: (r: LearningReward) => void): Promise<UnlistenFn> =>
  listen<LearningReward>("echo://learning-reward", (e) => cb(e.payload));
