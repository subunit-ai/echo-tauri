import { useTranslation } from "react-i18next";

export type Section =
  | "home"
  | "history"
  | "meetings"
  | "vocabulary"
  | "settings"
  | "help";

const ITEMS: { key: Section; labelKey: string; glyph: string }[] = [
  { key: "home", labelKey: "nav.home", glyph: "⌂" },
  { key: "history", labelKey: "nav.history", glyph: "⏱" },
  { key: "meetings", labelKey: "nav.meetings", glyph: "🎙" },
  { key: "vocabulary", labelKey: "nav.vocabulary", glyph: "📖" },
  { key: "settings", labelKey: "nav.settings", glyph: "⚙" },
  { key: "help", labelKey: "nav.help", glyph: "ⓘ" },
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
            {it.glyph}
          </span>
          {t(it.labelKey)}
        </button>
      ))}
    </nav>
  );
}
