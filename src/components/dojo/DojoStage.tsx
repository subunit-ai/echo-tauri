import { useTranslation } from "react-i18next";
import type { Belt } from "../../lib/ipc";
import { ObiBelt, type BeltRank } from "./ObiBelt";

/** The wide "stage" banner that crowns both halls of the Dojo. An inline-SVG
 *  sumi-e scene — an ensō (incomplete brush circle) as the zen sun, three
 *  mountain-ridge depth layers, drifting mist bands, and a classical torii
 *  silhouette (two posts, a curved kasagi double top beam, a nuki crossbeam,
 *  the central gakuzuka strut) standing on the front ridge.
 *
 *  Motion is deliberate and cheap: the ensō and ground line draw themselves once
 *  (stroke-dashoffset via pathLength=1), the ridges + torii rise in once, and the
 *  mist is the SINGLE perpetual animation — a transform-only horizontal drift.
 *  Everything is disabled under prefers-reduced-motion (dojo.css). No CJK, no
 *  bitmap assets: the Japan reads purely from form. Monochrome but for nothing —
 *  the accent Shu-red lives only on the Hanko/focus, never here.
 *
 *  `variant` picks the copy + a subtle per-hall tint; `belt` (when loaded) draws
 *  the ObiBelt top-right; `beltUp` plays the promotion sweep once. */
export function DojoStage({
  variant,
  belt,
  beltUp = null,
}: {
  variant: "rhetoric" | "prompt";
  belt: Belt | null;
  beltUp?: BeltRank | null;
}) {
  const { t } = useTranslation();
  return (
    <div className={`dojo-stage dojo-stage--${variant}`}>
      <svg
        className="dojo-stage-svg"
        viewBox="0 0 820 220"
        preserveAspectRatio="xMidYMax slice"
        aria-hidden="true"
      >
        {/* ── Ensō — the zen sun, an incomplete brush ring of variable width ── */}
        <g className="stage-enso">
          <path className="stage-enso-a" pathLength={1} d="M452 135 A 58 58 0 1 1 435 45" />
          <path className="stage-enso-b" pathLength={1} d="M372 145 A 58 58 0 0 1 356 78" />
        </g>

        {/* ── Mountain ridges — back (faint/high) → front (dark/low) ── */}
        <path
          className="stage-ridge stage-ridge--1"
          d="M0 150 C 120 120, 200 140, 300 118 S 500 100, 620 128 S 760 112, 820 132 L820 220 L0 220 Z"
        />
        <path
          className="stage-ridge stage-ridge--2"
          d="M0 172 C 140 150, 240 168, 360 150 S 560 140, 700 164 S 800 156, 820 168 L820 220 L0 220 Z"
        />

        {/* ── Mist bands — the only perpetual motion (transform drift) ── */}
        <g className="stage-mist" aria-hidden="true">
          <path className="stage-mist--a" d="M-60 148 h 360" />
          <path className="stage-mist--b" d="M520 178 h 360" />
        </g>

        <path
          className="stage-ridge stage-ridge--3"
          d="M0 196 C 160 182, 300 200, 430 188 S 640 178, 760 198 S 810 194, 820 200 L820 220 L0 220 Z"
        />

        {/* ── Torii — classical silhouette, rises in on mount ── */}
        <g className="stage-torii">
          <path className="stage-torii-ink" d="M362 80 L378 80 L381 186 L359 186 Z" />
          <path className="stage-torii-ink" d="M442 80 L458 80 L461 186 L439 186 Z" />
          {/* Kasagi — curved top beam with flared ends. */}
          <path className="stage-torii-ink" d="M326 76 C 380 62, 440 62, 494 76 L486 58 C 438 48, 382 48, 334 58 Z" />
          {/* Shimaki — the slim second beam hugging the kasagi. */}
          <path className="stage-torii-ink" d="M340 82 C 385 74, 435 74, 480 82 L478 90 C 434 82, 386 82, 342 90 Z" />
          {/* Nuki — the straight crossbeam, extending past the posts. */}
          <path className="stage-torii-ink" d="M348 104 L472 104 L472 116 L348 116 Z" />
          {/* Gakuzuka — the short central strut. */}
          <path className="stage-torii-ink" d="M404 90 L416 90 L416 104 L404 104 Z" />
        </g>

        {/* ── Ground line — a single dry brush stroke, draws on ── */}
        <path
          className="stage-ground"
          pathLength={1}
          d="M10 190 C 200 186, 400 192, 620 188 S 800 190, 812 189"
        />
      </svg>

      <div className="dojo-stage-copy">
        <h2 className="dojo-stage-title">{t(`learning.dojoWorld.stage.${variant}.title`)}</h2>
        <p className="dojo-stage-sub">{t(`learning.dojoWorld.stage.${variant}.subtitle`)}</p>
      </div>

      {belt && (
        <div className="dojo-stage-belt">
          <ObiBelt belt={belt} up={!!beltUp} />
        </div>
      )}
    </div>
  );
}
