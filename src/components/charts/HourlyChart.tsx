import { useId, useMemo } from "react";
import { useMeasuredWidth } from "./useMeasuredWidth";

/** Tick hours shown under the axis — 0/6/12/18/24. */
const TICKS = [0, 6, 12, 18, 24] as const;

/** Width assumed for the very first frame, before the container has been
 *  measured. Only ever visible if ResizeObserver is missing entirely. */
const FALLBACK_W = 720;

/** 24-hour distribution — "when do you dictate". Pure, self-contained inline-SVG
 * bar chart (no external chart lib). One bar per hour of day, sequential ramp
 * (opacity ∝ value) on the single `--cyan` accent, with the peak hour called
 * out at full strength. Theme-agnostic: every colour comes from CSS tokens.
 *
 * Self-measured (same convention as AreaChart): the viewBox matches the rendered
 * container 1:1. It used to be a FIXED 720-unit box stretched to 100% width,
 * which scaled the x-axis by (containerWidth / 720) while the y-axis stayed at
 * 1 — so the hour labels were squeezed or stretched sideways by however far the
 * card's real width sat from 720px. */
export function HourlyChart(props: {
  data: { hour: number; value: number }[];
  height?: number;
  color?: string;
}) {
  const { data, height = 160, color = "var(--cyan)" } = props;
  const titleId = useId();
  const glowId = useId();
  const [wrapRef, measured] = useMeasuredWidth<HTMLDivElement>();
  const VB_W = Math.max(Math.round(measured) || FALLBACK_W, 1);

  const hours = useMemo(() => {
    const byHour = new Map<number, number>();
    for (const d of data ?? []) {
      if (d && Number.isFinite(d.hour) && d.hour >= 0 && d.hour <= 23) {
        const v = Number.isFinite(d.value) ? d.value : 0;
        byHour.set(d.hour, (byHour.get(d.hour) ?? 0) + v);
      }
    }
    return Array.from({ length: 24 }, (_, hour) => ({ hour, value: byHour.get(hour) ?? 0 }));
  }, [data]);

  const maxValue = Math.max(0, ...hours.map((h) => h.value));
  const hasData = maxValue > 0;
  const peakHour = hasData
    ? hours.reduce((best, h) => (h.value > best.value ? h : best), hours[0]).hour
    : -1;

  const padTop = 12;
  const padBottom = 22;
  const padX = 2;
  const chartH = height - padTop - padBottom;
  const baselineY = padTop + chartH;
  const slot = (VB_W - padX * 2) / 24;
  const barW = Math.max(2, slot * 0.58);

  const summary = hasData
    ? `Dictation activity by hour of day. Busiest at ${String(peakHour).padStart(2, "0")}:00.`
    : "Dictation activity by hour of day. No data yet.";

  return (
    <div ref={wrapRef} style={{ width: "100%" }}>
      <svg
        className="hourly-chart"
        viewBox={`0 0 ${VB_W} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        role="img"
        aria-labelledby={titleId}
      >
        <title id={titleId}>{summary}</title>
        <defs>
          <filter id={glowId} x="-60%" y="-60%" width="220%" height="220%">
            <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor={color} floodOpacity="0.55" />
          </filter>
        </defs>

        {/* recessive vertical gridlines at the tick hours */}
        {TICKS.map((tick) => {
          const x = padX + Math.min(tick, 23.999) * slot;
          return (
            <line
              key={tick}
              x1={x}
              y1={padTop}
              x2={x}
              y2={baselineY}
              stroke="var(--line)"
              strokeWidth={1}
            />
          );
        })}

        {/* baseline */}
        <line x1={0} y1={baselineY} x2={VB_W} y2={baselineY} stroke="var(--line2)" strokeWidth={1} />

        {/* 24 hourly bars */}
        {hours.map((h) => {
          const ratio = hasData ? h.value / maxValue : 0;
          const isPeak = hasData && h.hour === peakHour;
          const barH = hasData ? Math.max(1.5, ratio * chartH) : 1.5;
          const x = padX + h.hour * slot + (slot - barW) / 2;
          const y = baselineY - barH;
          const fill = hasData
            ? `color-mix(in srgb, ${color} ${Math.round(22 + ratio * 78)}%, transparent)`
            : "var(--line2)";
          return (
            <rect
              key={h.hour}
              x={x}
              y={y}
              width={barW}
              height={barH}
              rx={Math.min(3, barW / 2)}
              fill={isPeak ? color : fill}
              filter={isPeak ? `url(#${glowId})` : undefined}
            >
              <title>{`${String(h.hour).padStart(2, "0")}:00 — ${h.value}`}</title>
            </rect>
          );
        })}

        {/* axis labels: 0 / 6 / 12 / 18 / 24 */}
        {TICKS.map((tick) => {
          const x = padX + Math.min(tick, 23.999) * slot;
          const anchor = tick === 0 ? "start" : tick === 24 ? "end" : "middle";
          const dx = tick === 0 ? 2 : tick === 24 ? -2 : 0;
          return (
            <text
              key={tick}
              x={x + dx}
              y={height - 6}
              fontSize={11}
              fill="var(--ink2)"
              textAnchor={anchor}
            >
              {tick}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
