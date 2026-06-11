import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export type Section =
  | "home"
  | "history"
  | "meetings"
  | "meetlive"
  | "vocabulary"
  | "settings"
  | "help";

/* Saubere Stroke-Icons statt Glyphen/Emojis (Enterprise-Look, TJ 2026-06-12).
   Einheitlich: 24er viewBox, stroke=currentColor, Breite 2 — erbt die nav-btn-Farbe. */
function Icon({ d, extra }: { d: string; extra?: ReactNode }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
      {extra}
    </svg>
  );
}

const ICONS: Record<Section, ReactNode> = {
  home: <Icon d="M3 11.2 12 3l9 8.2M5.3 9.8V21h13.4V9.8" />,
  history: <Icon d="M12 7v5l3 2" extra={<circle cx="12" cy="12" r="9" />} />,
  // Meetings = Archiv/Aufnahmen: Listen-Zeilen
  meetings: <Icon d="M4 6h16M4 12h16M4 18h9" />,
  // Live-Meeting = Broadcast-Wellen um einen Punkt
  meetlive: (
    <Icon
      d="M8.4 8.4a5.1 5.1 0 0 0 0 7.2M15.6 8.4a5.1 5.1 0 0 1 0 7.2M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 5.5a9.2 9.2 0 0 1 0 13"
      extra={<circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />}
    />
  ),
  vocabulary: <Icon d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />,
  settings: <Icon d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4" />,
  help: (
    <Icon
      d="M9.2 9a3 3 0 0 1 5.8 1c0 2-3 2.6-3 4.4M12 17.6h.01"
      extra={<circle cx="12" cy="12" r="9" />}
    />
  ),
};

const ITEMS: { key: Section; labelKey: string; pro?: boolean }[] = [
  { key: "home", labelKey: "nav.home" },
  { key: "history", labelKey: "nav.history" },
  { key: "meetings", labelKey: "nav.meetings" },
  { key: "meetlive", labelKey: "nav.meetingsLive", pro: true },
  { key: "vocabulary", labelKey: "nav.vocabulary" },
  { key: "settings", labelKey: "nav.settings" },
  { key: "help", labelKey: "nav.help" },
];

export function Sidebar({
  active,
  onSelect,
}: {
  active: Section;
  onSelect: (s: Section) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav className="sidebar">
      {ITEMS.map((it) => (
        <button
          key={it.key}
          className={`nav-btn ${it.key === active ? "active" : ""}`}
          onClick={() => onSelect(it.key)}
        >
          <span className="glyph" aria-hidden>
            {ICONS[it.key]}
          </span>
          {t(it.labelKey)}
          {it.pro && <span className="tier-badge nav-pro">Pro</span>}
        </button>
      ))}
    </nav>
  );
}
