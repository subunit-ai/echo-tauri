import { useState, type KeyboardEvent } from "react";

/** One bar: category label + numeric value. */
export interface BarDatum {
  label: string;
  value: number;
}

/** Internal viewBox coordinate space for the axis that stretches to fill the
 *  container width (never a fixed pixel width, so the chart can't force
 *  horizontal scroll — same convention as HourlyChart.tsx). The
 *  perpendicular axis (bar length for vertical bars / row stack for
 *  horizontal bars) always equals the real `height` prop 1:1. */
const VB_W = 640;

const FONT_VALUE = 11;
const FONT_LABEL = 11;

/** Rough label truncation so category text never overruns its slot — SVG
 *  <text> doesn't wrap/ellipsize on its own. Approximate on purpose (the
 *  x-axis is non-uniformly scaled by the responsive viewBox); a <title> on
 *  every bar always carries the untruncated label + formatted value. */
function truncateLabel(label: string, maxUnits: number, fontSize: number): string {
  if (maxUnits <= 0) return "";
  const avgCharUnits = fontSize * 0.62;
  const maxChars = Math.max(1, Math.floor(maxUnits / avgCharUnits));
  if (label.length <= maxChars) return label;
  if (maxChars <= 1) return label.slice(0, 1);
  return `${label.slice(0, maxChars - 1)}…`;
}

interface BarGeom {
  d: BarDatum;
  rectX: number;
  rectY: number;
  rectW: number;
  rectH: number;
  rectRx: number;
  labelX: number;
  labelY: number;
  labelAnchor: "start" | "middle" | "end";
  valueX: number;
  valueY: number;
  valueAnchor: "start" | "middle" | "end";
  hoverRect: { x: number; y: number; w: number; h: number };
  labelText: string;
}

/** Vertical or horizontal bar chart — word frequency, filler words, and any
 *  other ranked-category data. Pure, self-contained inline-SVG, no chart
 *  lib. Every colour resolves from CSS custom properties (default accent
 *  `--cyan`), so it renders correctly across every theme. Bars always carry
 *  a value label, respond to hover/keyboard-focus with a highlight, and are
 *  click + keyboard actionable when `onBarClick` is passed. */
export function BarChart({
  data,
  height,
  color = "var(--cyan)",
  horizontal = false,
  formatValue,
  maxBars,
  onBarClick,
}: {
  data: BarDatum[];
  height?: number;
  color?: string;
  horizontal?: boolean;
  formatValue?: (n: number) => string;
  maxBars?: number;
  onBarClick?: (d: BarDatum) => void;
}) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  const fmt = formatValue ?? ((n: number) => n.toLocaleString());
  const picked = typeof maxBars === "number" && maxBars > 0 ? data.slice(0, maxBars) : data;
  // Defensive: sanitize non-finite values instead of letting NaN leak into geometry/labels.
  const shown = picked.map((d) => ({ ...d, value: Number.isFinite(d.value) ? d.value : 0 }));
  const n = shown.length;
  const clickable = typeof onBarClick === "function";

  const handleBarClick = (datum: BarDatum) => onBarClick?.(datum);
  const handleBarKeyDown = (datum: BarDatum) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onBarClick?.(datum);
    }
  };
  const setActive = (i: number) => () => setActiveIdx(i);
  const clearActive = (i: number) => () => setActiveIdx((cur) => (cur === i ? null : cur));

  if (n === 0) {
    const emptyH = height ?? (horizontal ? 96 : 220);
    return (
      <svg
        className={`bar-chart bar-chart--empty${horizontal ? " bar-chart--horizontal" : " bar-chart--vertical"}`}
        width="100%"
        height={emptyH}
        viewBox={`0 0 ${VB_W} ${emptyH}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Keine Daten verfügbar"
        style={{ display: "block", overflow: "visible" }}
      >
        <line
          x1={0}
          y1={emptyH / 2}
          x2={VB_W}
          y2={emptyH / 2}
          stroke="var(--ink3)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray="2 4"
          opacity={0.5}
        />
      </svg>
    );
  }

  const maxVal = shown.reduce((m, d) => Math.max(m, d.value), 0);

  let svgHeight: number;
  let bars: BarGeom[];
  let axisLine: { x1: number; y1: number; x2: number; y2: number };

  if (horizontal) {
    const totalH = height ?? n * 34;
    const rowH = totalH / n;
    const barThickness = Math.max(6, Math.min(22, rowH * 0.56));
    const labelColW = Math.min(VB_W * 0.34, 200);
    const valueGutter = 56;
    const barAreaW = Math.max(20, VB_W - labelColW - valueGutter);

    svgHeight = totalH;
    axisLine = { x1: labelColW, y1: 0, x2: labelColW, y2: totalH };
    bars = shown.map((d, i) => {
      const ratio = maxVal > 0 ? d.value / maxVal : 0;
      const w = maxVal > 0 ? Math.max(2, ratio * barAreaW) : 0;
      const rowY = i * rowH;
      const barY = rowY + (rowH - barThickness) / 2;
      return {
        d,
        rectX: labelColW,
        rectY: barY,
        rectW: w,
        rectH: barThickness,
        rectRx: Math.min(5, barThickness / 2),
        labelX: labelColW - 8,
        labelY: rowY + rowH / 2,
        labelAnchor: "end",
        valueX: labelColW + w + 8,
        valueY: rowY + rowH / 2,
        valueAnchor: "start",
        hoverRect: { x: 0, y: rowY, w: VB_W, h: rowH },
        labelText: truncateLabel(d.label, labelColW - 12, FONT_LABEL),
      };
    });
  } else {
    const H = height ?? 220;
    const padTop = 20;
    const padBottom = 26;
    const padX = 4;
    const plotH = Math.max(10, H - padTop - padBottom);
    const baselineY = padTop + plotH;
    const slot = (VB_W - padX * 2) / n;
    const barW = Math.max(4, slot * 0.58);

    svgHeight = H;
    axisLine = { x1: 0, y1: baselineY, x2: VB_W, y2: baselineY };
    bars = shown.map((d, i) => {
      const ratio = maxVal > 0 ? d.value / maxVal : 0;
      const barH = maxVal > 0 ? Math.max(2, ratio * plotH) : 0;
      const x = padX + i * slot + (slot - barW) / 2;
      const y = baselineY - barH;
      return {
        d,
        rectX: x,
        rectY: y,
        rectW: barW,
        rectH: barH,
        rectRx: Math.min(4, barW / 2),
        labelX: x + barW / 2,
        labelY: H - 8,
        labelAnchor: "middle",
        valueX: x + barW / 2,
        valueY: Math.max(FONT_VALUE, y - 6),
        valueAnchor: "middle",
        hoverRect: { x: padX + i * slot, y: padTop, w: slot, h: plotH },
        labelText: truncateLabel(d.label, slot - 4, FONT_LABEL),
      };
    });
  }

  const summary = `Balkendiagramm mit ${n} ${n === 1 ? "Eintrag" : "Einträgen"}`;

  return (
    <svg
      className={`bar-chart${horizontal ? " bar-chart--horizontal" : " bar-chart--vertical"}`}
      width="100%"
      height={svgHeight}
      viewBox={`0 0 ${VB_W} ${svgHeight}`}
      preserveAspectRatio="none"
      role={clickable ? undefined : "img"}
      aria-label={summary}
      style={{ display: "block", overflow: "visible", fontFamily: "var(--font)" }}
    >
      <line x1={axisLine.x1} y1={axisLine.y1} x2={axisLine.x2} y2={axisLine.y2} stroke="var(--line2)" strokeWidth={1} />

      {bars.map((g, i) => {
        const isActive = activeIdx === i;
        return (
          <g
            key={`${g.d.label}-${i}`}
            role={clickable ? "button" : undefined}
            tabIndex={clickable ? 0 : undefined}
            aria-label={`${g.d.label} — ${fmt(g.d.value)}`}
            onClick={clickable ? () => handleBarClick(g.d) : undefined}
            onKeyDown={clickable ? handleBarKeyDown(g.d) : undefined}
            onMouseEnter={setActive(i)}
            onMouseLeave={clearActive(i)}
            onFocus={setActive(i)}
            onBlur={clearActive(i)}
            style={{ cursor: clickable ? "pointer" : "default", outline: "none" }}
          >
            <title>{`${g.d.label} — ${fmt(g.d.value)}`}</title>
            {isActive && (
              <rect
                x={g.hoverRect.x}
                y={g.hoverRect.y}
                width={g.hoverRect.w}
                height={g.hoverRect.h}
                rx={4}
                fill="var(--fill-weak)"
              />
            )}
            <rect
              x={g.rectX}
              y={g.rectY}
              width={g.rectW}
              height={g.rectH}
              rx={g.rectRx}
              fill={color}
              fillOpacity={isActive ? 1 : 0.82}
              stroke={isActive ? "var(--cyan-ink)" : "none"}
              strokeWidth={isActive ? 1 : 0}
            />
            <text
              x={g.labelX}
              y={g.labelY}
              textAnchor={g.labelAnchor}
              dominantBaseline={horizontal ? "middle" : undefined}
              fontSize={FONT_LABEL}
              fill="var(--ink2)"
            >
              {g.labelText}
            </text>
            <text
              x={g.valueX}
              y={g.valueY}
              textAnchor={g.valueAnchor}
              dominantBaseline={horizontal ? "middle" : undefined}
              fontSize={FONT_VALUE}
              fill="var(--ink)"
              opacity={isActive ? 1 : 0.85}
            >
              {fmt(g.d.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
