import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** Live WS streaming dictation modes (mirrors config.streaming_mode in Rust). */
export const STREAMING_MODES = ["off", "final", "live"] as const;
export type StreamingMode = (typeof STREAMING_MODES)[number];

/** The recommended mode, highlighted with a ★ badge. */
const RECOMMENDED: StreamingMode = "final";

const normalize = (v: string): StreamingMode =>
  (STREAMING_MODES as readonly string[]).includes(v) ? (v as StreamingMode) : "final";

/** A sliding 3-way segmented control for the streaming dictation mode.
 *  A vibrant per-mode pill slides to the active segment; the recommended mode
 *  gets a ★ badge above it; a one-line description below updates with the
 *  selection. Styled via the .stream-switch block in app.css.
 *
 *  RESPONSIVENESS: the thumb is driven by LOCAL state and reacts on pointer-DOWN
 *  (not click/release), so it moves the instant you press — never waiting on the
 *  press→release gap. Persisting the choice (which re-renders the whole heavy,
 *  un-memoized Settings tree via the config context) is deferred to the next
 *  frame so that re-render can't block the thumb's paint. The local state syncs
 *  back whenever the config value changes elsewhere. */
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
  const [selected, setSelected] = useState<StreamingMode>(() => normalize(value));
  useEffect(() => setSelected(normalize(value)), [value]);

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
  const idx = STREAMING_MODES.indexOf(selected);
  const recIdx = STREAMING_MODES.indexOf(RECOMMENDED);

  const pick = (m: StreamingMode) => {
    if (disabled || m === selected) return; // dedupe pointerdown+click; no-op re-picks
    setSelected(m); // instant: only this switch re-renders → thumb slides now
    requestAnimationFrame(() => onChange(m)); // persist after paint, off the critical path
  };

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
        {/* per-mode pill (width == one column, so translateX(idx*100%) snaps to the segment) */}
        <div
          className={`stream-thumb ${selected}`}
          aria-hidden
          style={{ transform: `translateX(${idx * 100}%)` }}
        />
        {STREAMING_MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={selected === m}
            // React on press for instant feel; onClick keeps keyboard (Enter/Space)
            // working and is de-duped by the guard in pick().
            onPointerDown={(e) => {
              if (e.button === 0) pick(m);
            }}
            onClick={() => pick(m)}
            className={`stream-seg ${selected === m ? "active" : ""}`}
          >
            {label[m]}
          </button>
        ))}
      </div>

      {/* dynamic one-line description of the selected mode */}
      <div className="hint" style={{ marginTop: 6, minHeight: 16 }}>{desc[selected]}</div>
    </div>
  );
}
