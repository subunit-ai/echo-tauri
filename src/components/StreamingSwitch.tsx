import { useTranslation } from "react-i18next";

/** Live WS streaming dictation modes (mirrors config.streaming_mode in Rust). */
export const STREAMING_MODES = ["off", "final", "live"] as const;
export type StreamingMode = (typeof STREAMING_MODES)[number];

/** A self-contained 3-way segmented switch for the streaming dictation mode.
 *  Inline-styled (no CSS-file dependency) so it renders identically on Settings
 *  and Home. Disabled (greyed) in local mode — streaming is cloud-only. */
export function StreamingSwitch({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (m: StreamingMode) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const label: Record<StreamingMode, string> = {
    off: t("settings.streamingOff"),
    final: t("settings.streamingFinal"),
    live: t("settings.streamingLive"),
  };
  return (
    <div
      role="radiogroup"
      aria-label={t("settings.streamingAria")}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: 6,
        opacity: disabled ? 0.45 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
    >
      {STREAMING_MODES.map((m) => {
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(m)}
            style={{
              padding: "10px 8px",
              borderRadius: 12,
              border: active
                ? "1px solid var(--accent, #22d3ee)"
                : "1px solid var(--border, rgba(127,127,127,0.28))",
              background: active ? "var(--accent-soft, rgba(34,211,238,0.15))" : "transparent",
              color: "inherit",
              fontWeight: active ? 700 : 500,
              fontSize: 13,
              cursor: "pointer",
              transition: "background 120ms, border-color 120ms",
            }}
          >
            {label[m]}
          </button>
        );
      })}
    </div>
  );
}
