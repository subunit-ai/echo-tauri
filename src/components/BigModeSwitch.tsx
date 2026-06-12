import { useTranslation } from "react-i18next";
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
  // cloud
  return (
    <svg {...common}>
      <path d="M7 17a4 4 0 01-.4-7.98A5.5 5.5 0 0117.5 8.5 3.75 3.75 0 0117 17H7z" />
    </svg>
  );
}

const SEGS: { key: UiMode; titleKey: string; subKey: string }[] = [
  { key: "local", titleKey: "mode.localTitle", subKey: "mode.localSub" },
  { key: "cloud", titleKey: "mode.cloudTitle", subKey: "mode.cloudSub" },
];

export function BigModeSwitch({
  value,
  onChange,
}: {
  value: UiMode;
  onChange: (m: UiMode) => void;
}) {
  const { t } = useTranslation();
  const idx = Math.max(0, SEGS.findIndex((s) => s.key === value));
  return (
    <div className="mode-switch" role="radiogroup" aria-label={t("mode.ariaLabel")}>
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
          <span className="seg-title">{t(s.titleKey)}</span>
          <span className="seg-sub">{t(s.subKey)}</span>
        </button>
      ))}
    </div>
  );
}
