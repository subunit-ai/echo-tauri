import { type UiMode } from "../lib/ipc";

const SEGS: { key: UiMode; title: string; icon: string; desc: string }[] = [
  { key: "local", title: "Lokal", icon: "🛡", desc: "100% privat · auf deinem PC" },
  { key: "cloud", title: "Cloud", icon: "☁", desc: "DSGVO · DE-Server" },
  { key: "superfast", title: "Superfast", icon: "⚡", desc: "Ultraschnell" },
];

export function BigModeSwitch({
  value,
  onChange,
}: {
  value: UiMode;
  onChange: (m: UiMode) => void;
}) {
  const idx = Math.max(0, SEGS.findIndex((s) => s.key === value));
  const indClass = value === "superfast" ? "superfast" : value === "cloud" ? "cloud" : "";
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Transkriptions-Modus">
      <div
        className={`mode-ind ${indClass}`}
        style={{ transform: `translateX(calc(${idx} * (100% + 4px)))` }}
      />
      {SEGS.map((s) => (
        <button
          key={s.key}
          type="button"
          role="radio"
          aria-checked={s.key === value}
          className={`mode-seg ${s.key === value ? "active" : ""}`}
          onClick={() => onChange(s.key)}
        >
          <span className="seg-title">
            <span aria-hidden>{s.icon}</span>
            {s.title}
          </span>
          <span className="seg-desc">{s.desc}</span>
        </button>
      ))}
    </div>
  );
}
