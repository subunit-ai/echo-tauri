export type Section =
  | "home"
  | "history"
  | "meetings"
  | "vocabulary"
  | "settings"
  | "help";

const ITEMS: { key: Section; label: string; glyph: string }[] = [
  { key: "home", label: "Home", glyph: "⌂" },
  { key: "history", label: "Verlauf", glyph: "⏱" },
  { key: "meetings", label: "Meetings", glyph: "🎙" },
  { key: "vocabulary", label: "Vocabulary", glyph: "📖" },
  { key: "settings", label: "Einstellungen", glyph: "⚙" },
  { key: "help", label: "Hilfe", glyph: "ⓘ" },
];

export function Sidebar({
  active,
  onSelect,
}: {
  active: Section;
  onSelect: (s: Section) => void;
}) {
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
          {it.label}
        </button>
      ))}
    </nav>
  );
}
