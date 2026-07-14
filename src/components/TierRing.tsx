import type { ReactNode } from "react";
import { tierForLevel } from "../lib/level";

/** Wraps any avatar (or other round badge) in a level-gated tier ring that sits
 *  in the bottom-left corner idiom: the ring is a thin coloured halo around the
 *  child, its colour a function of the learning level (bronze at 3 … the animated
 *  "eloquenz" conic gradient at 16). Below level 3 there is no ring — the child
 *  renders bare, so early users see nothing decorative.
 *
 *  The colours + animation live in activity.css (.tier-ring / .tier-ring--*),
 *  including the [data-theme="black"] zero-hue greyscale override. `size` is the
 *  CHILD's size; the ring adds its own padding around it. */
export function TierRing({
  level,
  size,
  children,
}: {
  level: number;
  size: number;
  children: ReactNode;
}) {
  const tier = tierForLevel(level);
  if (tier === "none") return <>{children}</>;
  return (
    <span
      className={`tier-ring tier-ring--${tier}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {children}
    </span>
  );
}
