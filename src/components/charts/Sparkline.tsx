// Sparkline — Mini-Trendlinie für Stat-Kacheln. Reine SVG-Polyline, kein
// Achsen-Chrom (keine Ticks/Labels/Gridlines). Self-contained, keine externe
// Lib. Theme-agnostisch: Farbe kommt aus --cyan, nichts hart-kodiert.

export interface SparklineDatum {
  value: number;
}

export function Sparkline({
  values,
  width = 96,
  height = 28,
  color = "var(--cyan)",
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const clean = values.filter((v) => Number.isFinite(v));

  if (clean.length === 0) {
    // Neutrales Rendering bei leeren Daten: flache Mittellinie statt Crash/leerem Loch.
    return (
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Kein Trend verfügbar"
        style={{ display: "block", overflow: "visible" }}
      >
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--ink3)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray="2 4"
          opacity={0.5}
        />
      </svg>
    );
  }

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1; // konstante Reihe → flache Linie statt Division durch 0
  const pad = height * 0.12;
  const innerH = height - pad * 2;
  const stepX = clean.length > 1 ? width / (clean.length - 1) : 0;

  const points = clean.map((v, i) => {
    const x = clean.length > 1 ? i * stepX : width / 2;
    const t = (v - min) / range;
    const y = height - pad - t * innerH;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const last = clean[clean.length - 1];
  const first = clean[0];
  const trend = last > first ? "steigend" : last < first ? "fallend" : "stabil";

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Trend: ${trend}`}
      style={{ display: "block", overflow: "visible" }}
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {clean.length === 1 && (
        <circle cx={width / 2} cy={height / 2} r={2} fill={color} />
      )}
    </svg>
  );
}
