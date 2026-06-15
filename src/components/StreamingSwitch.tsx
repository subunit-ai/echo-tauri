import { useTranslation } from "react-i18next";

/** Live WS streaming dictation modes (mirrors config.streaming_mode in Rust). */
export const STREAMING_MODES = ["off", "final", "live"] as const;
export type StreamingMode = (typeof STREAMING_MODES)[number];

/** The recommended mode, highlighted with a ★ badge. */
const RECOMMENDED: StreamingMode = "final";

/** A sliding 3-way segmented control for the streaming dictation mode.
 *  An animated thumb glides to the active segment; the recommended mode gets a
 *  ★ badge above it; a one-line description below updates with the selection.
 *  Inline-styled (no CSS-file dependency) so it renders identically on Settings
 *  and Home. Greyed in local mode — streaming is cloud-only. */
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
  const desc: Record<StreamingMode, string> = {
    off: t("settings.streamingDescOff"),
    final: t("settings.streamingDescFinal"),
    live: t("settings.streamingDescLive"),
  };
  const idx = Math.max(0, STREAMING_MODES.indexOf(value as StreamingMode));
  const recIdx = STREAMING_MODES.indexOf(RECOMMENDED);
  const current = (STREAMING_MODES[idx] ?? "final") as StreamingMode;

  return (
    <div style={{ opacity: disabled ? 0.45 : 1, pointerEvents: disabled ? "none" : "auto" }}>
      {/* ★ recommended badge, centred over the recommended segment */}
      <div style={{ position: "relative", height: 15, marginBottom: 3 }}>
        <span
          style={{
            position: "absolute",
            left: `${(recIdx + 0.5) * (100 / 3)}%`,
            transform: "translateX(-50%)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.3,
            color: "var(--accent, #22d3ee)",
            whiteSpace: "nowrap",
          }}
        >
          ★ {t("settings.streamingRecommended")}
        </span>
      </div>

      {/* sliding track */}
      <div
        role="radiogroup"
        aria-label={t("settings.streamingAria")}
        style={{
          position: "relative",
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          background: "var(--glass2, rgba(127,127,127,0.12))",
          borderRadius: 12,
          padding: 4,
          border: "1px solid var(--border, rgba(127,127,127,0.22))",
        }}
      >
        {/* animated thumb (its width == one column, so translateX(idx*100%) snaps to the segment) */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 4,
            bottom: 4,
            left: 4,
            width: "calc((100% - 8px) / 3)",
            transform: `translateX(${idx * 100}%)`,
            background: "var(--accent-soft, rgba(34,211,238,0.18))",
            border: "1px solid var(--accent, #22d3ee)",
            borderRadius: 9,
            transition: "transform 220ms cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        />
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
                position: "relative",
                zIndex: 1,
                padding: "9px 6px",
                border: "none",
                background: "transparent",
                color: "inherit",
                fontWeight: active ? 700 : 500,
                fontSize: 13,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {label[m]}
            </button>
          );
        })}
      </div>

      {/* dynamic one-line description of the selected mode */}
      <div className="hint" style={{ marginTop: 6, minHeight: 16 }}>{desc[current]}</div>
    </div>
  );
}
