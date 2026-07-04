import { useTranslation } from "react-i18next";

/** Live WS streaming dictation modes (mirrors config.streaming_mode in Rust). */
export const STREAMING_MODES = ["off", "final", "live"] as const;
export type StreamingMode = (typeof STREAMING_MODES)[number];

/** The recommended mode, highlighted with a ★ badge. */
const RECOMMENDED: StreamingMode = "final";

/** A sliding 3-way segmented control for the streaming dictation mode.
 *  A glass thumb springs to the active segment (same sliding-pill language as
 *  BigModeSwitch); the recommended mode gets a ★ badge above it; a one-line
 *  description below updates with the selection. Styled via the .stream-switch
 *  block in app.css (both Settings and Home load it globally). Greyed in local
 *  mode — streaming is cloud-only. */
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
    <div className="stream-switch" data-disabled={disabled || undefined}>
      {/* ★ recommended badge, centred over the recommended segment */}
      <div className="stream-rec">
        <span
          className="stream-rec-badge"
          style={{ left: `${(recIdx + 0.5) * (100 / 3)}%` }}
        >
          ★ {t("settings.streamingRecommended")}
        </span>
      </div>

      {/* sliding track */}
      <div className="stream-track" role="radiogroup" aria-label={t("settings.streamingAria")}>
        {/* glass thumb (width == one column, so translateX(idx*100%) snaps to the segment) */}
        <div
          className={`stream-thumb ${current}`}
          aria-hidden
          style={{ transform: `translateX(${idx * 100}%)` }}
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
              className={`stream-seg ${active ? "active" : ""}`}
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
