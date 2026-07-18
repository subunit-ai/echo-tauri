import { useTranslation } from "react-i18next";
import type { Belt } from "../../lib/ipc";

/** The seven belt ranks, low → high, so the CSS can carry a per-rank colour var
 *  (dojo.css: --belt-<rank>; the black theme remaps them to a grey ramp). */
export const BELT_RANKS = [
  "white",
  "yellow",
  "orange",
  "green",
  "blue",
  "brown",
  "black",
] as const;
export type BeltRank = (typeof BELT_RANKS)[number];

/** The Obi (belt) shown in the stage header of both halls: an SVG sash band
 *  with a knot, coloured by rank, plus the rank name and — from belt.next — a
 *  compact "what's left to the next belt" hint. When `up` is set the band plays
 *  the one-shot promotion sweep (dojo.css), announcing the new colour. */
export function ObiBelt({ belt, up = false }: { belt: Belt; up?: boolean }) {
  const { t } = useTranslation();
  const rank = (BELT_RANKS as readonly string[]).includes(belt.rank)
    ? (belt.rank as BeltRank)
    : "white";

  let hint: string;
  if (!belt.next) {
    hint = t("learning.dojoWorld.next.max");
  } else {
    const parts: string[] = [];
    if (belt.next.need_katas > 0)
      parts.push(t("learning.dojoWorld.next.kata", { count: belt.next.need_katas }));
    if (belt.next.need_days > 0)
      parts.push(t("learning.dojoWorld.next.day", { count: belt.next.need_days }));
    if (belt.next.need_high > 0)
      parts.push(t("learning.dojoWorld.next.high", { count: belt.next.need_high }));
    hint = parts.length
      ? `${t("learning.dojoWorld.next.prefix")} ${parts.join(" · ")}`
      : t("learning.dojoWorld.next.almost");
  }

  return (
    <div className={`obi-belt obi-belt--${rank}${up ? " is-up" : ""}`}>
      <svg className="obi-svg" viewBox="0 0 132 56" aria-hidden="true">
        {/* Sash — a folded fabric band. The two tails fan out from a central
            knot; slight curves read as cloth, not a bar. */}
        <path
          className="obi-band"
          d="M4 20 C 30 14, 46 16, 58 24 L 74 24 C 86 16, 102 14, 128 20
             L 128 34 C 102 30, 86 30, 74 34 L 58 34 C 46 30, 30 30, 4 34 Z"
        />
        {/* Knot (musubi) — a rounded square with a soft highlight fold. */}
        <rect className="obi-knot" x="54" y="14" width="24" height="28" rx="5" />
        <path className="obi-knot-fold" d="M58 20 C 64 24, 68 24, 74 20" />
      </svg>
      <div className="obi-meta">
        <span className="obi-rank">{t(`learning.dojoWorld.belt.${rank}`)}</span>
        <span className="obi-progress">{hint}</span>
      </div>
    </div>
  );
}
