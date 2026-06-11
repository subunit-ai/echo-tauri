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
  mode: string; // local | subunit  (superfast = subunit + cloud_superfast)
  local_model: string;
  local_device: string;
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
  orb_speed: number;
  /** Per-state orb colors (hex). working = recording + transcribing. */
  orb_color_idle: string;
  orb_color_working: string;
  orb_color_done: string;

  diarization_enabled: boolean;
  diarization_max_speakers: number;

  cleanup_enabled: boolean;
  cleanup_style: string;
  cleanup_auto_mode: boolean;
  auto_mode_overrides: Record<string, string>;

  long_form_threshold_seconds: number;
  long_form_cleanup_style: string;

  synapse_save_enabled: boolean;
  /** Global hotkey toggling the floating Prompt Console (empty = disabled). */
  prompt_console_hotkey: string;
  /** "Konsole als Ziel": transcripts go into the Prompt Console, not the app. */
  prompt_console_as_target: boolean;
  recording_mode: string; // toggle | hold
  account_email: string;
  last_cloud_mode: string;
  auto_update_check: boolean;
  autostart_enabled: boolean;
  has_seen_onboarding: boolean;
  ui_language: string;
  ui_theme: string; // dark | light

  plan: string; // free | trial | pro
  trial_started_at: number;

  subunit_access_token: string;
  subunit_refresh_token: string;
  subunit_token_issued_at: number;
  subunit_token_expires_in: number;
  subunit_workspace_id: string;

  cloud_quality_mode: string;
  gpu_aware_migrated: boolean;
  instant_live_typing: boolean;
  cloud_superfast: boolean;

  sound_enabled: boolean;
  sound_volume: number;
  /** Independent cues + selectable tone per cue (ids → lib/sounds.ts). */
  sound_start_enabled: boolean;
  sound_paste_enabled: boolean;
  sound_start_id: string;
  sound_paste_id: string;

  vocabulary: VocabEntry[];
  vocabulary_default_seeded: boolean;
  dach_format_enabled: boolean;

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
/** Persist a drag-set orb position (logical screen px) as orb_position custom-x-y. */
export const setOrbPosition = (x: number, y: number) =>
  invoke<void>("set_orb_position", { x, y });

// ---- Orb satellites (inline quick controls around the overlay) ----
export interface OrbQuick {
  /** "local" | "cloud" | "superfast" */
  mode: string;
  /** language code or "auto" */
  language: string;
  /** cleanup style, or "off" */
  cleanup: string;
}
export const orbQuick = () => invoke<OrbQuick>("orb_quick");
export const orbCycle = (which: "mode" | "language" | "cleanup") =>
  invoke<OrbQuick>("orb_cycle", { which });
export const appVersion = () => invoke<string>("app_version");
export const listAudioDevices = () => invoke<string[]>("list_audio_devices");
/** Copy text to the clipboard (History action). */
export const copyText = (text: string) => invoke<void>("copy_text", { text });
/** Open ~/.config/echo in the OS file manager. */
export const openConfigDir = () => invoke<void>("open_config_dir");
/** Open an external URL in the default browser. */
export const openExternal = (url: string) => invoke<void>("open_external", { url });
/** Delete one history entry by index (newest = 0). */
export const deleteHistoryEntry = (index: number) =>
  invoke<void>("delete_history_entry", { index });
/** Clear the whole transcription history. */
export const clearHistory = () => invoke<void>("clear_history");
/** Re-process a stored meeting with a cleanup style → returns the styled text. */
export const processMeeting = (index: number, style: string) =>
  invoke<string>("process_meeting", { index, style });

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
export type UiMode = "local" | "cloud" | "superfast";

export function uiModeOf(c: Config): UiMode {
  if (c.mode === "local") return "local";
  return c.cloud_superfast ? "superfast" : "cloud";
}

export function patchForUiMode(m: UiMode): Partial<Config> {
  switch (m) {
    case "local":
      return { mode: "local" };
    case "cloud":
      return { mode: "subunit", cloud_superfast: false, last_cloud_mode: "subunit" };
    case "superfast":
      return { mode: "subunit", cloud_superfast: true };
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
