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
