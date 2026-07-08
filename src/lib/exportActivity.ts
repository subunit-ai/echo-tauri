// Client-side Activity export. Builds CSV/JSON text in TS, UTF-8-safe
// base64-encodes it, and hands it to the Rust `activity_export` command,
// which writes it to ~/Downloads and reveals it (no dialog/fs plugin in
// Echo — see blueprint §9 EXTRAS).
import {
  activityExport,
  type ActivityDay,
  type ActivityHour,
  type ActivityOverview,
  type WordFreq,
} from "./ipc";

/** Everything a JSON export bundles — one fetch cycle's worth of Activity
 *  data, mirroring what `Activity.tsx` already has in state. */
export interface ActivityExportPayload {
  overview: ActivityOverview;
  daily: ActivityDay[];
  hourly: ActivityHour[];
  words: WordFreq[];
}

const CSV_COLUMNS = [
  "day",
  "transcriptions",
  "words",
  "audio_seconds",
  "time_saved_seconds",
] as const;

/** Quote a CSV field only when it needs it (comma/quote/newline present). */
function csvField(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build the CSV text for a daily-activity export: header row + one data
 *  row per `ActivityDay`. */
export function buildCsv(daily: ActivityDay[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const d of daily) {
    lines.push(CSV_COLUMNS.map((col) => csvField(d[col])).join(","));
  }
  return lines.join("\r\n");
}

/** Build the pretty-printed JSON text for a full-dashboard export. */
export function buildJson(payload: ActivityExportPayload): string {
  return JSON.stringify(payload, null, 2);
}

/** UTF-8-safe base64 encoding — plain `btoa` throws on non-Latin1 code
 *  points, and German umlauts/foreign words routinely show up in `daily`
 *  and `words`. Chunked to stay clear of call-stack limits on large
 *  exports. */
function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** `YYYY-MM-DD` of the current moment — used in export filenames. */
function isoDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Build the daily-activity CSV, encode it, and persist it via the Rust
 *  `activity_export` command. Resolves to the written file path. */
export function exportCsv(daily: ActivityDay[]): Promise<string> {
  const filename = `echo-activity-${isoDateStamp()}.csv`;
  return activityExport("csv", filename, toBase64Utf8(buildCsv(daily)));
}

/** Build the full-dashboard JSON, encode it, and persist it via the Rust
 *  `activity_export` command. Resolves to the written file path. */
export function exportJson(payload: ActivityExportPayload): Promise<string> {
  const filename = `echo-activity-${isoDateStamp()}.json`;
  return activityExport("json", filename, toBase64Utf8(buildJson(payload)));
}
