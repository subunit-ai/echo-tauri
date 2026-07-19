// Learning level ↔ XP, a 1:1 mirror of the Rust rule in commands.rs
// (`level_for_xp`): level l is reached while 100·(l+1)² <= xp. So the level
// thresholds are 100·n² XP (100, 400, 900, 1600, …) and the current level is the
// largest n with 100·n² <= xp.
//
// Kept as its own tiny module so anything client-side that only has an XP number
// (e.g. a leaderboard row's `xp_total`) can derive the level for a TierRing
// without a round-trip to Rust.

/** Level for a given XP total. Mirrors the backend integer loop exactly (the
 *  float sqrt is only a fast starting guess — the loops correct any rounding at
 *  the exact square boundaries). Non-finite or negative input → level 0. */
export function levelForXp(xp: number): number {
  if (!Number.isFinite(xp) || xp < 100) return 0;
  let level = Math.floor(Math.sqrt(xp / 100));
  while (100 * (level + 1) * (level + 1) <= xp) level += 1;
  while (level > 0 && 100 * level * level > xp) level -= 1;
  return level;
}

/** Level plus progress (0..1) toward the next level. Because the level number
 *  is a coarse quadratic bucket (100·n²), two members with different XP can share
 *  a level — this fraction differentiates them: more XP within the band = fuller.
 *  Used for the per-row progress on the leaderboard. */
export function levelProgress(xp: number): { level: number; pct: number } {
  const level = levelForXp(xp);
  const floor = 100 * level * level;
  const next = 100 * (level + 1) * (level + 1);
  const span = next - floor;
  const pct =
    span > 0 && Number.isFinite(xp) ? Math.min(1, Math.max(0, (xp - floor) / span)) : 0;
  return { level, pct };
}

/** Tier of a level ring: below 3 there is no ring at all. The bands mirror the
 *  achievement/title cadence (bronze at 3, up to the animated "eloquenz" gradient
 *  at 16). Returned string doubles as the `.tier-ring--<tier>` CSS modifier. */
export type TierName = "none" | "bronze" | "silber" | "gold" | "platin" | "eloquenz";

export function tierForLevel(level: number): TierName {
  if (level >= 16) return "eloquenz";
  if (level >= 12) return "platin";
  if (level >= 8) return "gold";
  if (level >= 5) return "silber";
  if (level >= 3) return "bronze";
  return "none";
}
