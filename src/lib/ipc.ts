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
  mode: string; // local | subunit | openai | groq | custom
  local_model: string;
  local_device: string;
  language: string;

  subunit_endpoint: string;
  subunit_api_key: string;
  openai_api_key: string;
  openai_model: string;
  groq_api_key: string;
  groq_model: string;
  custom_endpoint: string;
  custom_api_key: string;
  custom_model: string;
  openrouter_api_key: string;

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

  diarization_enabled: boolean;
  diarization_max_speakers: number;

  cleanup_enabled: boolean;
  cleanup_style: string;
  cleanup_auto_mode: boolean;
  auto_mode_overrides: Record<string, string>;

  long_form_threshold_seconds: number;
  long_form_cleanup_style: string;

  synapse_save_enabled: boolean;
  recording_mode: string; // toggle | hold
  account_email: string;
  last_cloud_mode: string;
  auto_update_check: boolean;
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
  live_type: boolean;
  cloud_superfast: boolean;

  sound_enabled: boolean;
  sound_volume: number;

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
