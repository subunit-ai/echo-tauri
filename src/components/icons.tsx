// Zentrales Stroke-Icon-Set — EMOJI-VERBOT (TJ 2026-06-12): UI-Symbole kommen
// ausschließlich von hier (24er viewBox, stroke=currentColor, erbt die
// Textfarbe). Fehlt ein Motiv: NICHT mit einem Emoji überbrücken, sondern
// TJ/Team nach einem passenden Icon fragen.
import type { ReactNode } from "react";

export function StrokeIcon({
  paths,
  size = 16,
  strokeWidth = 2,
  extra,
}: {
  paths: string[];
  size?: number;
  strokeWidth?: number;
  extra?: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flex: "none", verticalAlign: "-2px" }}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
      {extra}
    </svg>
  );
}

export const MIC_PATHS = [
  "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z",
  "M19 10v2a7 7 0 0 1-14 0v-2",
  "M12 19v3",
];

// ---- Orb-Overlay-Inseln (Modus / Sprache / Cleanup / Terminal) ----

/** Lokal-Modus: Schild mit Haken (wie BigModeSwitch). */
export const SHIELD_CHECK_PATHS = [
  "M12 3l7 3v5c0 4.2-2.9 7.3-7 8.4-4.1-1.1-7-4.2-7-8.4V6l7-3z",
  "M9 12l2 2 4-4",
];

/** Cloud-Modus. */
export const CLOUD_PATHS = ["M7 17a4 4 0 01-.4-7.98A5.5 5.5 0 0117.5 8.5 3.75 3.75 0 0117 17H7z"];

/** Sprache: Globus. */
export const GLOBE_PATHS = [
  "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
  "M3 12h18",
  "M12 3c2.4 2.4 3.7 5.6 3.7 9s-1.3 6.6-3.7 9c-2.4-2.4-3.7-5.6-3.7-9s1.3-6.6 3.7-9Z",
];

/** KI-Cleanup: Funkeln (großer + kleiner Stern). */
export const SPARKLES_PATHS = [
  "M11 4l1.7 4.3L17 10l-4.3 1.7L11 16l-1.7-4.3L5 10l4.3-1.7L11 4Z",
  "M18.5 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z",
];

/** Cleanup aus: durchgestrichener Kreis. */
export const BAN_PATHS = ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M5.8 5.8l12.4 12.4"];

/** Prompt-Stil: Terminal-Chevron. */
export const TERMINAL_PATHS = ["M4 17l6-5-6-5", "M12 19h8"];

/** E-Mail-Stil: Briefumschlag. */
export const MAIL_PATHS = [
  "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  "m3 7 9 6 9-6",
];

/** Slack-Stil: Raute. */
export const HASH_PATHS = ["M10 3 8 21", "M16 3l-2 18", "M4 9h17", "M3 15h17"];

/** Formell-Stil: Aktentasche. */
export const BRIEFCASE_PATHS = [
  "M4 8h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z",
  "M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2",
];

/** Auto-Modus (Stil folgt der fokussierten App): Zauberstab mit Funken. */
export const WAND_PATHS = [
  "m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z",
  "m14 7 3 3",
  "M5 6v4",
  "M19 14v4",
  "M10 2v2",
  "M7 8H3",
  "M21 16h-4",
  "M11 3H9",
];

/** Tidy-Stil (leichte Säuberung): Besen. */
export const BROOM_PATHS = [
  "M16 4l4 4",
  "M18 6 8.5 15.5",
  "M8.5 15.5 4 20l4.5 0L13 15.5z",
  "M11 13l3 3",
];

/** Notes-Stil: Stichpunkt-Liste. */
export const LIST_PATHS = [
  "M9 6h11",
  "M9 12h11",
  "M9 18h11",
  "M4.5 6h.01",
  "M4.5 12h.01",
  "M4.5 18h.01",
];

/** Letter-Stil (Brief): Dokument mit Eselsohr + Textzeilen. */
export const LETTER_PATHS = [
  "M6 3h8l5 5v13H6z",
  "M14 3v5h5",
  "M9 13h6",
  "M9 17h6",
];

/** Social-Stil (Post): Megafon. */
export const MEGAPHONE_PATHS = [
  "M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z",
  "M16 8a5 5 0 0 1 0 8",
];

/** Prompt Terminal: Vierzack-Stern (ersetzt das ✦-Textzeichen). */
export const STAR4_PATHS = ["M12 3l2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1L12 3Z"];

export function MicIcon({ size = 15 }: { size?: number }) {
  return <StrokeIcon paths={MIC_PATHS} size={size} />;
}

/** Pulsierender Aufnahme-Punkt — ersetzt das 🔴-Emoji in Recording-Hinweisen. */
export function RecDot({ size = 9 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: 999,
        background: "#ff5c5c",
        boxShadow: "0 0 8px rgba(255, 92, 92, 0.7)",
        animation: "rec-dot-pulse 1.4s ease infinite",
        verticalAlign: "1px",
        marginRight: 7,
        flex: "none",
      }}
    />
  );
}
