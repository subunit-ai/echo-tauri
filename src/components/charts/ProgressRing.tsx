import type { ReactNode } from "react";

/** Ring-shaped progress indicator (goal tracking, e.g. "words today / daily
 *  goal"). Pure inline-SVG, no chart lib — a static track circle plus a
 *  progress arc whose `stroke-dashoffset` is driven by `value`/`max`. An
 *  optional centred label (a count, a percentage, an icon, …) is passed as
 *  `children` and overlaid via a plain flex div, so it can be any ReactNode.
 *
 *  Self-contained: sizing works purely from inline styles (no dependency on
 *  activity.css), and every colour resolves from the active theme's CSS
 *  custom properties (`--cyan`, `--line2`, `--ink`) so the ring stays correct
 *  across dark/light/liquid/schwarz without any hard-coded black/white.
 *  `role="progressbar"` + `aria-value*` describe the ring for screen readers;
 *  the decorative SVG and the (usually already-textual) centre label are
 *  hidden from the accessibility tree to avoid announcing the value twice. */
export function ProgressRing({
  value,
  max,
  size = 96,
  stroke = 8,
  color = "var(--cyan)",
  children,
}: {
  value: number;
  max: number;
  size?: number;
  stroke?: number;
  color?: string;
  children?: ReactNode;
}) {
  const radius = Math.max((size - stroke) / 2, 0);
  const circumference = 2 * Math.PI * radius;

  // Robust against empty/invalid data (max<=0, NaN, negative value): fall back
  // to a neutral, fully-empty ring instead of propagating NaN/Infinity into
  // the SVG dasharray.
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
  const ratio = safeMax > 0 ? safeValue / safeMax : 0;
  const fraction = Math.min(Math.max(ratio, 0), 1);
  const dashoffset = (1 - fraction) * circumference;
  const pct = Math.round(fraction * 100);

  return (
    <div
      className="progress-ring"
      role="progressbar"
      aria-valuenow={safeValue}
      aria-valuemin={0}
      aria-valuemax={safeMax || 1}
      aria-valuetext={`${pct}%`}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        maxWidth: size,
        aspectRatio: "1 / 1",
      }}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        preserveAspectRatio="xMidYMid meet"
        width="100%"
        height="100%"
        aria-hidden="true"
        style={{ display: "block", overflow: "visible" }}
      >
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line2)" strokeWidth={stroke} />
        {fraction > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashoffset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: "stroke-dashoffset 0.4s var(--ease-out, ease)" }}
          />
        )}
      </svg>
      {children != null && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            color: "var(--ink)",
            pointerEvents: "none",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
