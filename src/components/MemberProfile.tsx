import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Avatar } from "./Avatar";
import { TierRing } from "./TierRing";
import { levelForXp } from "../lib/level";
import type { LeaderboardRow } from "../lib/ipc";

/** The milestone ids, in the exact order of the Rust `ACHIEVEMENTS` table.
 *  A row's `achievements` array carries the earned subset of these. */
export const ACHIEVEMENT_IDS = [
  "first_notable",
  "first_rare",
  "first_legendary",
  "finds_10",
  "finds_50",
  "finds_200",
  "wod_7",
  "wod_30",
  "coach_25",
  "streak_7",
  "streak_30",
  "level_5",
  "level_10",
] as const;

// ── Milestone glyphs (stroke-SVG, inherit currentColor). Mirrors the set in
//    Learning.tsx so the profile reads the same as the Erfolge tab. ──
const TrophyIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z" />
    <path d="M7 6H4a1 1 0 0 0-1 1c0 2.2 1.8 4 4 4M17 6h3a1 1 0 0 1 1 1c0 2.2-1.8 4-4 4" />
  </svg>
);
const StarIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 3 2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 17.8 6.4 20.1l1.4-6.3L3 9.5l6.4-.6L12 3Z" />
  </svg>
);
const FlameIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3c.6 3 2.4 4.3 3.6 5.9A6 6 0 0 1 17 12.5a5 5 0 0 1-10 .4c0-1.8.8-3.1 1.7-4 .2 1 .8 1.6 1.4 2C10.8 8.7 12 6.4 12 3Z" />
  </svg>
);
const BookIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 6.4C10.4 5 8 4.4 4 4.4V18c4 0 6.4.6 8 2 1.6-1.4 4-2 8-2V4.4c-4 0-6.4.6-8 2Z" />
    <path d="M12 6.4V20" />
  </svg>
);
const MedalIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8.4 3 6 8M15.6 3 18 8" />
    <circle cx="12" cy="15" r="5.2" />
    <path d="m12 12.4.95 1.9 2.1.3-1.52 1.48.36 2.1L12 17.2l-1.85.98.36-2.1L9 14.6l2.1-.3.9-1.9Z" />
  </svg>
);
const CloseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

/** Icon by achievement family — id prefixes map 1:1 to the ACHIEVEMENTS table. */
function achIcon(id: string) {
  if (id.startsWith("level_")) return <TrophyIcon />;
  if (id.startsWith("streak_")) return <FlameIcon />;
  if (id.startsWith("finds_")) return <BookIcon />;
  if (id.startsWith("coach_")) return <BookIcon />;
  if (id.startsWith("wod_")) return <MedalIcon />;
  return <StarIcon />; // first_notable / first_rare / first_legendary
}

/** Tap-through profile for one leaderboard member: level standing, XP progress,
 *  the achievement wall (earned vs locked) and the Wortdex collection tallies.
 *  Everything past the header degrades gracefully — sections tied to
 *  server-only fields (`achievements`, `bands`) simply vanish on old servers. */
export function MemberProfile({ row, onClose }: { row: LeaderboardRow; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || "en";
  const closeRef = useRef<HTMLButtonElement>(null);

  const xp = row.xp_total ?? 0;
  const level = levelForXp(xp);
  const floor = 100 * level * level;
  const next = 100 * (level + 1) * (level + 1);
  const span = next - floor;
  const pct = span > 0 ? Math.max(0, Math.min(100, Math.round(((xp - floor) / span) * 100))) : 0;
  const xpToNext = Math.max(0, next - xp);

  // Focus the close button on open, and wire Escape to dismiss.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const displayName = row.me ? t("learning.lbYou", { name: row.name }) : row.name;
  const earnedCount = row.achievements?.length ?? 0;

  return (
    <div className="mp-overlay" role="presentation" onClick={onClose}>
      <div
        className="mp-panel"
        role="dialog"
        aria-modal="true"
        aria-label={displayName}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          ref={closeRef}
          type="button"
          className="mp-close"
          onClick={onClose}
          aria-label={t("learning.profileClose")}
        >
          <CloseIcon />
        </button>

        {/* Header — level ring, name, level standing, equipped title. */}
        <div className="mp-head">
          <TierRing level={level} size={44}>
            {/* Member's account picture (server-mirrored from their last score
                push); no avatar → initials. */}
            <Avatar name={row.name} src={row.avatar} size={44} />
          </TierRing>
          <div className="mp-head-info">
            <div className="mp-name">{displayName}</div>
            <div className="mp-sub">
              <span className="mp-level">{t("learning.levelLabel", { level })}</span>
              <span className="mp-level-title">
                {t(`learning.levelTitle${Math.min(level, 9)}`)}
              </span>
            </div>
            {row.title && (
              <span className="mp-title-chip">{t(`learning.titles.${row.title}`)}</span>
            )}
          </div>
        </div>

        {/* Level progress — XP still owed to the next level. */}
        <div className="mp-progress">
          <div className="xp-bar">
            <div className="xp-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="mp-progress-text">
            {t("learning.xpToLevel", { xp: xpToNext.toLocaleString(lang), level: level + 1 })}
          </div>
        </div>

        {/* Achievement wall — hidden entirely on old servers (undefined array),
            so we never render a discouraging all-locked grid we can't trust. */}
        {row.achievements && (
          <div className="mp-section">
            <div className="mp-section-head">
              <span className="mp-section-title">{t("learning.achTitle")}</span>
              <span className="mp-section-count">
                {t("learning.achCount", {
                  earned: earnedCount,
                  total: ACHIEVEMENT_IDS.length,
                })}
              </span>
            </div>
            <div className="mp-ach-grid">
              {ACHIEVEMENT_IDS.map((id) => {
                const earned = row.achievements?.includes(id) ?? false;
                return (
                  <div
                    key={id}
                    className={`mp-ach ${earned ? "is-earned" : "is-locked"}`}
                    title={t(`learning.ach.${id}.name`)}
                  >
                    <span className="mp-ach-icon">{achIcon(id)}</span>
                    <span className="mp-ach-name">{t(`learning.ach.${id}.name`)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Wortdex collection — likewise hidden when the server omits it. */}
        {row.bands && (
          <div className="mp-section">
            <div className="mp-section-head">
              <span className="mp-section-title">{t("learning.wortdexSection")}</span>
            </div>
            {/* The three prestige tiers (server slots carry Episch/Mythisch/Legendär). */}
            <div className="mp-band-row">
              <span className="mp-band band-1">
                <span className="mp-band-n">{row.bands.notable}</span>
                {t("learning.bandEpic")}
              </span>
              <span className="mp-band band-2">
                <span className="mp-band-n">{row.bands.rare}</span>
                {t("learning.bandMythic")}
              </span>
              <span className="mp-band band-3">
                <span className="mp-band-n">{row.bands.legendary}</span>
                {t("learning.bandLegendary")}
              </span>
            </div>
          </div>
        )}

        {/* Footer — words owned + lifetime XP. */}
        <div className="mp-foot">
          <span>{t("learning.lbWords", { count: row.words })}</span>
          <span className="mp-foot-xp">{xp.toLocaleString(lang)} XP</span>
        </div>
      </div>
    </div>
  );
}
