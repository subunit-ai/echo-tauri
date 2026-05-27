import { type UiMode } from "../lib/ipc";

function Icon({ kind }: { kind: UiMode }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (kind === "local")
    return (
      <svg {...common}>
        <path d="M12 3l7 3v5c0 4.2-2.9 7.3-7 8.4-4.1-1.1-7-4.2-7-8.4V6l7-3z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    );
  if (kind === "cloud")
    return (
      <svg {...common}>
        <path d="M7 17a4 4 0 01-.4-7.98A5.5 5.5 0 0117.5 8.5 3.75 3.75 0 0117 17H7z" />
      </svg>
    );
  // superfast — lightning
  return (
    <svg {...common} fill="currentColor" stroke="none">
      <path d="M13 2L4.5 13.5H10l-1 8.5L19.5 10H13l1-8z" />
    </svg>
  );
}

const SEGS: { key: UiMode; title: string; sub: string }[] = [
  { key: "local", title: "Lokal", sub: "100% privat" },
  { key: "cloud", title: "Cloud", sub: "DSGVO · DE-Server" },
  { key: "superfast", title: "Superfast", sub: "Ultraschnell" },
];

export function BigModeSwitch({
  value,
  onChange,
}: {
  value: UiMode;
  onChange: (m: UiMode) => void;
}) {
  const idx = Math.max(0, SEGS.findIndex((s) => s.key === value));
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Transkriptions-Modus">
      <div
        className={`mode-ind ${value}`}
        style={{ transform: `translateX(calc(${idx} * (100% + 6px)))` }}
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
          <span className="seg-ico">
            <Icon kind={s.key} />
          </span>
          <span className="seg-title">{s.title}</span>
          <span className="seg-sub">{s.sub}</span>
        </button>
      ))}
    </div>
  );
}
