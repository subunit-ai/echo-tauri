// Zeitreihen-Primitive für Activity/Learning-Dashboards: sanfte Linie + optionale
// Flächenfüllung, reines inline-SVG (keine Chart-Lib). Theme-agnostisch — jede
// Farbe kommt aus CSS-Tokens (tokens.css) bzw. dem `color`-Prop, nichts hart-kodiert.
// Selbst-vermessen per ResizeObserver → viewBox deckt sich 1:1 mit dem gerenderten
// Container (keine Verzerrung von Kreisen/Text, kein horizontales Scrollen).
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

export interface XYDatum {
  x: string;
  y: number;
}

type Point = { x: number; y: number };

const DEFAULT_HEIGHT = 180;
const PAD = { top: 16, right: 12, bottom: 20, left: 10 };
const MAX_X_TICKS = 6;

const identityX = (x: string): string => x;
const identityY = (y: number): string => String(Math.round(y * 100) / 100);

/** Catmull-Rom → kubische Bézier-Segmente: sanfte Kurve durch alle Punkte, ohne
 *  eine Lib zu ziehen. Fällt bei 0/1/2 Punkten sauber auf Punkt/Linie zurück. */
function smoothPath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  const d: string[] = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : points.length - 1];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d.push(`C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`);
  }
  return d.join(" ");
}

export function AreaChart({
  data,
  height = DEFAULT_HEIGHT,
  color = "var(--cyan)",
  fill = true,
  formatX = identityX,
  formatY = identityY,
  goal,
}: {
  data: XYDatum[];
  height?: number;
  color?: string;
  fill?: boolean;
  formatX?: (x: string) => string;
  formatY?: (y: number) => string;
  goal?: number;
}) {
  const gradId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width || 0);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = data.length;
  const vbW = Math.max(Math.round(width), 1);
  const vbH = Math.max(Math.round(height), 1);
  const plotW = Math.max(vbW - PAD.left - PAD.right, 1);
  const plotH = Math.max(vbH - PAD.top - PAD.bottom, 1);
  const hasGoal = typeof goal === "number" && Number.isFinite(goal);

  const geo = useMemo(() => {
    if (n === 0) return null;
    const values = data.map((d) => d.y);
    const rawMax = Math.max(...values, hasGoal ? (goal as number) : -Infinity, 0);
    const rawMin = Math.min(...values, hasGoal ? (goal as number) : Infinity, 0);
    const span = rawMax - rawMin || 1;
    const domainTop = rawMax + span * 0.12;
    const domainBottom = rawMin;
    const domainSpan = domainTop - domainBottom || 1;

    const xAt = (i: number) => PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yAt = (v: number) => PAD.top + (1 - (v - domainBottom) / domainSpan) * plotH;

    const points: Point[] = data.map((d, i) => ({ x: xAt(i), y: yAt(d.y) }));
    const linePath = smoothPath(points);
    const baselineY = yAt(Math.max(domainBottom, 0));
    const areaPath =
      fill && points.length > 0
        ? `${linePath} L ${points[points.length - 1].x} ${baselineY} L ${points[0].x} ${baselineY} Z`
        : "";

    const gridValues = [domainTop, domainBottom + domainSpan / 2, domainBottom];

    const tickStep = n > MAX_X_TICKS ? Math.ceil((n - 1) / (MAX_X_TICKS - 1)) : 1;
    const tickIdx: number[] = [];
    for (let i = 0; i < n; i += tickStep) tickIdx.push(i);
    if (tickIdx[tickIdx.length - 1] !== n - 1) tickIdx.push(n - 1);

    const goalY = hasGoal ? yAt(goal as number) : null;

    return { points, linePath, areaPath, gridValues, tickIdx, goalY, xAt, yAt };
  }, [data, n, goal, hasGoal, fill, plotW, plotH]);

  // Leeres/neutrales Rendering: keine Daten → gedämpfte Basislinie statt Absturz
  // oder leerem Block. Der aufrufende Screen zeigt daneben den echten Empty-State.
  if (!geo) {
    return (
      <div
        ref={wrapRef}
        className="chart-area chart-area--empty"
        role="img"
        aria-label="Keine Daten"
        style={{ width: "100%", height }}
      >
        <svg width="100%" height={height} viewBox={`0 0 ${vbW} ${vbH}`} preserveAspectRatio="none" aria-hidden>
          <line
            x1={PAD.left}
            y1={vbH / 2}
            x2={vbW - PAD.right}
            y2={vbH / 2}
            stroke="var(--line2)"
            strokeWidth={1}
            strokeDasharray="4 5"
          />
        </svg>
      </div>
    );
  }

  const last = data[n - 1];
  const lastPoint = geo.points[n - 1];
  const gradientId = `areachart-fill-${gradId}`;
  const hoverPoint = hover != null ? geo.points[hover] : null;
  const endLabelY = Math.max(lastPoint.y - 8, PAD.top + 8);
  const ariaLabel =
    n === 1
      ? `${formatX(data[0].x)}: ${formatY(data[0].y)}`
      : `${formatX(data[0].x)} – ${formatX(last.x)}: ${formatY(last.y)}`;

  const handlePointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const localX = ((e.clientX - rect.left) / rect.width) * vbW;
    let nearest = 0;
    let nearestDist = Infinity;
    geo.points.forEach((p, i) => {
      const dist = Math.abs(p.x - localX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setHover(nearest);
  };

  return (
    <div
      ref={wrapRef}
      className="chart-area"
      role="img"
      aria-label={ariaLabel}
      style={{ width: "100%", height, position: "relative" }}
    >
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${vbW} ${vbH}`}
        preserveAspectRatio="none"
        aria-hidden
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHover(null)}
      >
        {fill && (
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: `color-mix(in srgb, ${color} 30%, transparent)` }} />
              <stop offset="100%" style={{ stopColor: `color-mix(in srgb, ${color} 0%, transparent)` }} />
            </linearGradient>
          </defs>
        )}

        {geo.gridValues.map((v, i) => {
          const y = geo.yAt(v);
          return (
            <g key={i}>
              <line
                x1={PAD.left}
                y1={y}
                x2={vbW - PAD.right}
                y2={y}
                stroke="var(--line)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <text x={PAD.left + 2} y={Math.max(y - 3, 9)} fontSize={10} fill="var(--ink3)">
                {formatY(v)}
              </text>
            </g>
          );
        })}

        {geo.goalY != null && (
          <g>
            <line
              x1={PAD.left}
              y1={geo.goalY}
              x2={vbW - PAD.right}
              y2={geo.goalY}
              stroke="var(--ink3)"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              vectorEffect="non-scaling-stroke"
            />
            <text x={vbW - PAD.right} y={Math.max(geo.goalY - 5, 9)} textAnchor="end" fontSize={10} fill="var(--ink2)">
              {formatY(goal as number)}
            </text>
          </g>
        )}

        {fill && geo.areaPath && <path d={geo.areaPath} fill={`url(#${gradientId})`} stroke="none" />}

        <path
          d={geo.linePath}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        <circle cx={lastPoint.x} cy={lastPoint.y} r={4} fill={color} />
        <text x={lastPoint.x - 8} y={endLabelY} textAnchor="end" fontSize={11} fill="var(--ink)">
          {formatY(last.y)}
        </text>

        {geo.tickIdx.map((i) => (
          <text
            key={i}
            x={geo.xAt(i)}
            y={vbH - 4}
            textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
            fontSize={10}
            fill="var(--ink2)"
          >
            {formatX(data[i].x)}
          </text>
        ))}

        {hoverPoint && (
          <g aria-hidden>
            <line
              x1={hoverPoint.x}
              y1={PAD.top}
              x2={hoverPoint.x}
              y2={vbH - PAD.bottom}
              stroke="var(--line2)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={hoverPoint.x} cy={hoverPoint.y} r={4} fill={color} />
          </g>
        )}
      </svg>

      {hover != null && hoverPoint && (
        <div
          className="chart-area-tip"
          style={{
            position: "absolute",
            left: Math.min(Math.max(hoverPoint.x, 48), vbW - 48),
            top: Math.max(hoverPoint.y - 14, 4),
            transform: "translate(-50%, -100%)",
            pointerEvents: "none",
          }}
        >
          <strong>{formatY(data[hover].y)}</strong>
          <span>{formatX(data[hover].x)}</span>
        </div>
      )}
    </div>
  );
}
