/** A single sumi-e brush stroke used to separate sections in the Prompt-Dojo.
 *  Pure inline SVG — a slightly irregular tapered ink line (never a flat CSS
 *  border), optionally captioned. The stroke draws itself once on mount
 *  (stroke-dashoffset via pathLength=1); reduced-motion shows it already drawn.
 *  Monochrome — rides --ink3 so the black theme greys it for free. */
export function BrushDivider({ label }: { label?: string }) {
  return (
    <div className="brush-divider" role="separator" aria-label={label ?? undefined}>
      <svg
        className="brush-divider-svg"
        viewBox="0 0 600 20"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {/* Tapered ink smear: thin → swells → thin, with a faint dry-brush echo. */}
        <path
          className="brush-divider-stroke"
          pathLength={1}
          d="M6 11 C 90 6, 150 14, 240 10 S 400 6, 500 12 S 570 9, 594 10"
        />
        <path
          className="brush-divider-echo"
          pathLength={1}
          d="M20 13 C 120 10, 200 15, 300 12 S 470 10, 580 12"
        />
      </svg>
      {label && <span className="brush-divider-label">{label}</span>}
    </div>
  );
}
