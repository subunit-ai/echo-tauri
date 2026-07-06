// Notes — the Desktop half of Echo's cross-device voice notes. The wire shape is
// byte-for-byte identical to the Echo iOS app (same `/v1/notes/sync`, same JSON
// keys), so a prompt dictated on the iPhone while walking shows up here, and a
// note made here shows up on the phone. See `src-tauri/src/notes*.rs`.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** The opaque note payload — same property names as the iOS `Note` Codable.
 *  Dates are ISO8601 strings WITHOUT fractional seconds (iOS `.iso8601`), so the
 *  iPhone can decode notes we create. Absent optionals are omitted, never null. */
export interface NotePayload {
  id: string; // UUID (lower- or upper-case; iOS decodes both)
  createdAt: string; // ISO8601, no millis
  title: string;
  rawText: string; // always present (the transcript)
  cleanedText?: string; // preferred for display if non-empty
  duration: number; // seconds
  audioFilename?: string;
  language?: string;
  tags?: string[];
  pinned?: boolean;
  updatedAt?: string; // ISO8601, no millis — drives last-write-wins
  insights?: Record<string, string>;
  folderId?: string; // UUID — denormalized folder membership (syncs)
  folderName?: string; // denormalized folder name (rehydrates folders)
  segments?: { start: number; end: number; text: string; speaker?: string }[];
}

/** Store envelope row returned by `list_notes`. */
export interface NoteRow {
  id: string;
  name: string; // = title
  payload: NotePayload;
  updated_at: number; // epoch SECONDS
}

/** Device-local folder cosmetics (icon + colour). Membership lives on the note. */
export interface NoteFolder {
  id: string;
  name: string;
  icon: string; // an icon key from FOLDER_ICONS
  color: string; // "#rrggbb"
  sort_order: number;
  updated_at: number;
}

/** Result of recording a voice note (from `note_record_stop`). */
export interface NoteTranscript {
  raw_text: string;
  cleaned_text: string | null;
  language: string | null;
  duration_s: number;
  quality_mode: string;
}

// ---- time / id helpers (iOS-parity) ----------------------------------------

/** One instant as BOTH representations the two layers need, from one clock read:
 *  ISO8601 without millis (payload) + epoch seconds (envelope). */
export function stamp(): { iso: string; secs: number } {
  const d = new Date();
  return {
    iso: d.toISOString().replace(/\.\d{3}Z$/, "Z"), // strip millis → iOS `.iso8601`
    secs: Math.floor(d.getTime() / 1000),
  };
}

export const uuid = (): string => crypto.randomUUID();

/** Text shown for a note: cleaned if present, else the raw transcript. */
export const displayText = (p: NotePayload): string =>
  p.cleanedText && p.cleanedText.trim() ? p.cleanedText : p.rawText ?? "";

/** Derive a short title from text (first meaningful line, ~7 words / 48 chars). */
export function deriveTitle(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "Neue Notiz";
  const firstLine = trimmed.split(/\r?\n/)[0] ?? trimmed;
  const short = firstLine.split(/\s+/).slice(0, 7).join(" ");
  const capped = short.length > 48 ? short.slice(0, 48).trim() + "…" : short;
  return capped || "Neue Notiz";
}

// ---- IPC wrappers -----------------------------------------------------------

export const listNotes = () => invoke<NoteRow[]>("list_notes");
export const deleteNote = (id: string) => invoke<void>("delete_note", { id });
export const notesSyncNow = () => invoke<void>("notes_sync_now");
/** Persist a note (create or update). Bumps `updatedAt`/`updated_at` from ONE
 *  clock read so the two encodings stay consistent. Returns the note id. */
export function saveNote(payload: NotePayload): Promise<string> {
  const { iso, secs } = stamp();
  const p: NotePayload = { ...payload, updatedAt: iso };
  return invoke<string>("save_note", { id: p.id, name: p.title, payload: p, updated_at: secs });
}

export const listNoteFolders = () => invoke<NoteFolder[]>("list_note_folders");
export const saveNoteFolder = (
  id: string,
  name: string,
  icon: string,
  color: string,
  sort_order: number,
) => invoke<string>("save_note_folder", { id, name, icon, color, sort_order });
export const deleteNoteFolder = (id: string) => invoke<void>("delete_note_folder", { id });

export const noteRecordStart = () => invoke<void>("note_record_start");
export const noteRecordLevel = () => invoke<number>("note_record_level");
export const noteRecordStop = () => invoke<NoteTranscript>("note_record_stop");
export const noteRecordCancel = () => invoke<void>("note_record_cancel");

/** Fired after a sync reconciles the store (a phone note arrived, or a push
 *  landed) — the Notes view reloads its list. */
export const onNotesChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("echo://notes-changed", () => cb());

// ---- factories --------------------------------------------------------------

/** Build a fresh note payload (new UUID + timestamps). `updatedAt` is filled in
 *  by `saveNote` at persist time. */
export function makeNote(fields: {
  title?: string;
  rawText: string;
  cleanedText?: string;
  duration?: number;
  language?: string;
  tags?: string[];
  folderId?: string;
  folderName?: string;
}): NotePayload {
  const { iso } = stamp();
  const title = (fields.title ?? "").trim() || deriveTitle(fields.cleanedText || fields.rawText);
  const p: NotePayload = {
    id: uuid(),
    createdAt: iso,
    title,
    rawText: fields.rawText,
    duration: fields.duration ?? 0,
  };
  if (fields.cleanedText && fields.cleanedText.trim()) p.cleanedText = fields.cleanedText;
  if (fields.language) p.language = fields.language;
  if (fields.tags && fields.tags.length) p.tags = fields.tags;
  if (fields.folderId) {
    p.folderId = fields.folderId;
    p.folderName = fields.folderName;
  }
  return p;
}

// ---- folder icons (enterprise stroke icons, not emoji; keys are device-local) --

/** SVG path `d` per folder-icon key. Mirrors the iOS icon palette semantically. */
export const FOLDER_ICONS: Record<string, string> = {
  folder: "M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.4H19.5A1.5 1.5 0 0 1 21 9.9V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18Z",
  chat: "M4 5h16v11H8l-4 3.5Z",
  idea: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.5.4.8 1 .8 1.6V16h5.4v-.5c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3Z",
  briefcase: "M4 8.5h16v11H4zM9 8.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v2.5",
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L4.5 9.7l5.9-.9Z",
  bolt: "M13 3 5 13.5h5.5L10 21l8-10.5h-5.5Z",
  tag: "M4 11.5V4.5h7l8.5 8.5-7 7L4 11.5ZM8 8.5h.01",
  tray: "M4 13.5 6.5 6h11L20 13.5M4 13.5V19h16v-5.5M4 13.5h4l1.2 2h5.6l1.2-2H20",
  book: "M5 4.5h11a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2Zm13 15H7M8 8h7M8 11h7",
  flag: "M6 21V4.5M6 5h11l-2 3.5L17 12H6",
  check: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2",
  cart: "M4 5h2l2 11h9l2-7H7M9 20h.01M17 20h.01",
};
export const FOLDER_ICON_KEYS = Object.keys(FOLDER_ICONS);
export const FOLDER_COLORS = [
  "#06b6d4", "#7c5cf0", "#16a34a", "#d97706",
  "#e11d48", "#2563eb", "#0891b2", "#db2777",
];
