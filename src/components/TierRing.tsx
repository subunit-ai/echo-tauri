import type { CSSProperties, ReactNode } from "react";
import { tierForLevel } from "../lib/level";

/** Wraps any avatar (or other round badge) in a level-gated tier ring that sits
 *  in the bottom-left corner idiom: the ring is a thin coloured halo around the
 *  child, its colour a function of the learning level (bronze at 3 … the animated
 *  "eloquenz" conic gradient at 16). Below level 3 there is no ring — the child
 *  renders bare, so early users see nothing decorative.
 *
 *  Two OPT-IN extras (both off for the plain leaderboard/profile rings, so those
 *  keep exactly today's look):
 *   • `progress` (0..1) turns the halo into a level-progress ring: the full circle
 *     stays visible but DIMMED in the tier colour — der Rang (Bronze/Gold/…) darf
 *     NIE unlesbar werden, das war TJs ausdrückliche Bedingung — und ein Bogen in
 *     voller Tier-Farbe wandert ab 12 Uhr im Uhrzeigersinn darüber, je näher das
 *     nächste Level rückt. Below level 3 (`tier === "none"`) the ring shows in a
 *     NEUTRAL grey so beginners still see progress without implying a tier.
 *   • `showLevel` pins the level number as a small glass badge to the ring's
 *     bottom-right corner.
 *
 *  The colours + animation live in activity.css (.tier-ring / .tier-ring--*),
 *  including the [data-theme="black"] zero-hue greyscale override. `size` is the
 *  CHILD's size; the ring adds its own padding around it. */
export function TierRing({
  level,
  size,
  progress,
  showLevel = false,
  children,
}: {
  level: number;
  size: number;
  /** Fraction (0..1) toward the next level — see `levelProgress()`. Omit for a
   *  plain, non-filling tier halo. */
  progress?: number;
  /** Render the level number as a badge on the ring. */
  showLevel?: boolean;
  children: ReactNode;
}) {
  const tier = tierForLevel(level);
  const hasArc = typeof progress === "number" && Number.isFinite(progress);
  // Nothing decorative to draw at all → render the child bare (today's behaviour
  // for every caller that passes neither extra).
  if (tier === "none" && !hasArc && !showLevel) return <>{children}</>;

  const pct = hasArc ? Math.min(1, Math.max(0, progress)) : 0;
  return (
    <span
      className={`tier-ring tier-ring--${tier}${hasArc ? " tier-ring--progress" : ""}`}
      style={
        {
          width: size,
          height: size,
          // Consumed by the conic arc; registered via @property in activity.css so
          // the sweep animates instead of snapping when XP comes in.
          ...(hasArc ? { "--tr-p": pct } : null),
        } as CSSProperties
      }
      aria-hidden
    >
      {children}
      {hasArc && <span className="tier-ring-arc" />}
      {showLevel && <span className="tier-ring-lvl">{level}</span>}
    </span>
  );
}
