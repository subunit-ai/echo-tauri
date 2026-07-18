/** A hanko (name seal) stamp rendering a score. A round Shu-red seal with a
 *  hand-cut irregular outer edge, an inner ring, a faint carved grain, and the
 *  score pressed into the middle. Replaces the naked score number in both the
 *  Dojo and the Kata result.
 *
 *  Shu-red rides the --shu token (dojo.css), which the black theme overrides to
 *  a light grey — the seal stays monochrome in the zero-hue theme. The stamp
 *  animation (scale 1.6 → 1 + a hair of rotation, once) is defined in dojo.css
 *  and disabled under prefers-reduced-motion. `score` is any 0–100 number;
 *  `size` is the diameter in px (default 96). */
export function HankoSeal({ score, size = 96 }: { score: number; size?: number }) {
  const n = Math.round(score);
  return (
    <div
      className="hanko"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${n} / 100`}
    >
      <svg className="hanko-seal" viewBox="0 0 100 100" aria-hidden="true">
        {/* Outer stamped edge — deliberately not a perfect circle (hand-carved,
            ink builds unevenly at the rim). */}
        <path
          className="hanko-edge"
          d="M50 4
             C 68 3, 84 12, 92 28
             C 98 40, 98 60, 91 73
             C 83 89, 66 97, 50 96
             C 33 97, 16 88, 9 72
             C 2 59, 3 39, 10 27
             C 18 12, 33 4, 50 4 Z"
        />
        {/* Inner hairline ring — the classic double border of a carved seal. */}
        <circle className="hanko-ring" cx="50" cy="50" r="37" />
        {/* Carved grain: a few negative-space nicks so the fill reads as pressed
            ink, not a flat disc. */}
        <g className="hanko-grain" aria-hidden="true">
          <path d="M28 30 l3 2 M70 26 l-2 3 M74 70 l-3-2 M27 72 l2-3" />
        </g>
      </svg>
      <span className="hanko-score">{n}</span>
    </div>
  );
}
