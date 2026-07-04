import { Fragment, useEffect, useId, useRef, useState } from "react";
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
 *  gets a ★ badge above it; a one-line description below updates with it.
 *
 *  RESPONSIVENESS: the segments are hidden <input type="radio"> and the thumb is
 *  positioned/coloured entirely in CSS off `:has(:checked)` — so a native radio
 *  click moves the thumb the instant you press, with a pure-CSS transition, with
 *  ZERO React involvement. Persisting the choice (which re-renders the heavy,
 *  un-memoized Settings tree) happens on the radio's onChange but can no longer
 *  block or delay the thumb, because the thumb is not driven by React. The radios
 *  are uncontrolled; an effect re-syncs them if the config value changes
 *  elsewhere. Styled via the .stream-* block in app.css. */
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
  const uid = useId(); // unique radio-group name (this switch renders on Home AND Settings)
  const rootRef = useRef<HTMLDivElement>(null);
  // Local mirror drives ONLY the description line; the thumb is pure CSS.
  const [selected, setSelected] = useState<StreamingMode>(() => normalize(value));

  // Re-sync the (uncontrolled) radios + description when the config value changes
  // from elsewhere (another window, a reset) — never from our own click.
  useEffect(() => {
    const v = normalize(value);
    setSelected(v);
    const el = rootRef.current?.querySelector<HTMLInputElement>(`.stream-radio[value="${v}"]`);
    if (el && !el.checked) el.checked = true;
  }, [value]);

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
  const recIdx = STREAMING_MODES.indexOf(RECOMMENDED);

  return (
    <div className="stream-switch" data-disabled={disabled || undefined} ref={rootRef}>
      {/* ★ recommended badge, centred over the recommended segment */}
      <div className="stream-rec">
        <span
          className="stream-rec-badge"
          style={{ left: `${(recIdx + 0.5) * (100 / 3)}%` }}
        >
          ★ {t("settings.streamingRecommended")}
        </span>
      </div>

      {/* sliding track — thumb is positioned in CSS off the hidden radios */}
      <div className="stream-track" role="radiogroup" aria-label={t("settings.streamingAria")}>
        <div className="stream-thumb" aria-hidden />
        {STREAMING_MODES.map((m) => (
          <Fragment key={m}>
            <input
              type="radio"
              className={`stream-radio r-${m}`}
              name={uid}
              id={`${uid}-${m}`}
              value={m}
              defaultChecked={normalize(value) === m}
              disabled={disabled}
              onChange={() => {
                setSelected(m); // description (cheap); thumb already moved via CSS
                onChange(m); // persist — cannot lag the thumb anymore
              }}
            />
            <label htmlFor={`${uid}-${m}`} className="stream-seg">
              {label[m]}
            </label>
          </Fragment>
        ))}
      </div>

      {/* dynamic one-line description of the selected mode */}
      <div className="hint" style={{ marginTop: 6, minHeight: 16 }}>{desc[selected]}</div>
    </div>
  );
}
