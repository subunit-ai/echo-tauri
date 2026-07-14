// RadarChart — six-axis rhetoric radar. Pure SVG, no external lib, theme-
// agnostic: every colour resolves from tokens (--cyan for the current polygon,
// --ink*/--line for the chrome), so Dark / Light / Liquid / Schwarz all fall out
// for free — in the zero-hue "black" theme --cyan is already a light grey, so the
// whole radar goes monochrome with no special-casing here.
//
// The current profile is a filled polygon; the "ghost" (previous window) sits
// behind it as a dimmed, dashed outline, so improvement reads as the solid shape
// pushing outward past the ghost. reduced-motion-safe: nothing here animates —
// any entrance flourish lives in CSS and is disabled under prefers-reduced-motion.

/** viewBox is a fixed square the SVG scales into (width: 100%), so the radar
 *  shrinks cleanly in a narrow column. Labels live in the outer margin. */
const VB = 300;
const CENTER = VB / 2;
/** Polygon radius at score 100. Leaves ~44px of margin for the axis labels. */
const R = 92;
/** Where the axis captions sit — just past the outermost grid ring. */
const LABEL_R = R + 22;
/** Concentric grid rings (as fractions of R). */
const RINGS = [1 / 3, 2 / 3, 1];

export interface RadarAxis {
  key: string;
  label: string;
  /** 0–100. */
  score: number;
}

/** Vertex for axis `i` (of `n`) at radius `r`, first axis pointing straight up
 *  and the rest laid out clockwise. */
function vertex(i: number, n: number, r: number): [number, number] {
  const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  return [CENTER + r * Math.cos(angle), CENTER + r * Math.sin(angle)];
}

function polygon(points: [number, number][]): string {
  return points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

export function RadarChart({
  axes,
  ghost = null,
  size = 300,
}: {
  axes: RadarAxis[];
  ghost?: Record<string, number> | null;
  size?: number;
}) {
  const n = axes.length;
  if (n < 3) return null;

  const clamp = (v: number) => Math.max(0, Math.min(100, v)) / 100;

  const currentPts = axes.map((a, i) => vertex(i, n, R * clamp(a.score)));
  const ghostPts = ghost
    ? axes.map((a, i) => vertex(i, n, R * clamp(ghost[a.key] ?? 0)))
    : null;

  return (
    <svg
      className="radar-chart"
      width="100%"
      viewBox={`0 0 ${VB} ${VB}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={
        "Sprechprofil-Radar: " +
        axes.map((a) => `${a.label} ${Math.round(a.score)}`).join(", ")
      }
      style={{ display: "block", maxWidth: size, margin: "0 auto", overflow: "visible" }}
    >
      {/* Grid rings — concentric hexagons connecting the axis directions. */}
      {RINGS.map((f, ri) => (
        <polygon
          key={`ring-${ri}`}
          className="radar-ring"
          points={polygon(axes.map((_, i) => vertex(i, n, R * f)))}
          fill="none"
        />
      ))}

      {/* Spokes from the centre to each axis vertex. */}
      {axes.map((a, i) => {
        const [x, y] = vertex(i, n, R);
        return (
          <line key={`spoke-${a.key}`} className="radar-spoke" x1={CENTER} y1={CENTER} x2={x} y2={y} />
        );
      })}

      {/* Ghost (previous window) — dashed, dimmed, drawn first so it sits behind. */}
      {ghostPts && (
        <polygon className="radar-ghost" points={polygon(ghostPts)} />
      )}

      {/* Current profile — filled cyan polygon. */}
      <polygon className="radar-area" points={polygon(currentPts)} />

      {/* A dot per current vertex. */}
      {currentPts.map(([x, y], i) => (
        <circle key={`dot-${axes[i].key}`} className="radar-dot" cx={x} cy={y} r={3} />
      ))}

      {/* Axis captions, anchored by side so left/right labels don't overlap the shape. */}
      {axes.map((a, i) => {
        const [x, y] = vertex(i, n, LABEL_R);
        const dx = x - CENTER;
        const anchor = dx > 3 ? "start" : dx < -3 ? "end" : "middle";
        return (
          <text
            key={`label-${a.key}`}
            className="radar-label"
            x={x}
            y={y}
            textAnchor={anchor}
            dominantBaseline="middle"
          >
            {a.label}
          </text>
        );
      })}
    </svg>
  );
}
