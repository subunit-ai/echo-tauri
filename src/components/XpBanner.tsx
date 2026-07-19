import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  onLearningReward,
  onWordFind,
  type Band,
  type RewardKind,
} from "../lib/ipc";
import { playReward } from "../lib/sounds";
import { useConfig } from "../state/ConfigContext";

/** Celebration banners for EVERY XP event. Slides in top-center, glass surface
 *  on --menu-bg (it floats over content), an accent per event class, a counting
 *  XP number and a tiered reward chime. Subscribes to the same two events the
 *  old toasts used — `echo://learning-reward` (vocabulary, dojo, kata, prompt
 *  pattern) and `echo://word-find` — and stacks overlapping celebrations
 *  instead of dropping them. A find beyond the daily XP cap still banners
 *  ("new in the Wortdex"), it just carries no XP line. */

interface Banner {
  id: number;
  /** Styling class: reward | find-1..3 | level. */
  cls: string;
  title: string;
  /** The celebrated word / localized exercise name (optional). */
  word?: string;
  /** Secondary line, e.g. "Nr. 128" or "+2 weitere". */
  sub?: string;
  xp: number;
  leaving?: boolean;
}

const SHOW_MS = 4600;
const LEAVE_MS = 320;
const MAX_STACK = 3;

/** XP number that counts up to its target on mount (~0.6 s, rAF). */
function CountUp({ to }: { to: number }) {
  const [n, setN] = useState(to <= 8 ? to : 0);
  useEffect(() => {
    if (to <= 8) return;
    let raf = 0;
    const t0 = performance.now();
    // Clock from performance.now() directly — not the rAF argument — so the
    // count is correct even under rAF shims that pass no timestamp.
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / 600);
      // ease-out cubic — fast start, gentle landing on the real number.
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // rAF can be throttled to nothing (hidden/tray window, headless) — a plain
    // timeout guarantees the number always lands on the real value.
    const settle = window.setTimeout(() => setN(to), 700);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
  }, [to]);
  return <>{n}</>;
}

/** Spark burst for finds/level-ups, check-in-circle for earned rewards —
 *  inline SVGs (no emoji), colored via currentColor by the banner class. */
function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        d="M12 2.5l1.9 6.1 6.1 1.9-6.1 1.9-1.9 6.1-1.9-6.1-6.1-1.9 6.1-1.9L12 2.5z"
        fill="currentColor"
      />
      <circle cx="19.2" cy="5.2" r="1.4" fill="currentColor" opacity="0.7" />
      <circle cx="5.4" cy="18.4" r="1.1" fill="currentColor" opacity="0.55" />
    </svg>
  );
}
function CheckBadgeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8 12.3l2.6 2.7 5.2-5.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function LevelIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        d="M6 13.5l6-6 6 6M6 19l6-6 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function XpBannerHost() {
  const { t } = useTranslation();
  const { config } = useConfig();
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const [banners, setBanners] = useState<Banner[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setBanners((list) => list.map((b) => (b.id === id ? { ...b, leaving: true } : b)));
    window.setTimeout(
      () => setBanners((list) => list.filter((b) => b.id !== id)),
      LEAVE_MS,
    );
  }, []);

  const push = useCallback(
    (b: Omit<Banner, "id">, tier: 1 | 2 | 3) => {
      const id = ++idRef.current;
      setBanners((list) => {
        const next = [...list, { ...b, id }];
        // Overflow: retire the oldest immediately instead of growing a tower.
        if (next.length > MAX_STACK) next.shift();
        return next;
      });
      const c = cfgRef.current;
      if (c?.sound_reward_enabled ?? true) playReward(tier, c?.sound_volume ?? 0.6);
      window.setTimeout(() => dismiss(id), SHOW_MS);
    },
    [dismiss],
  );

  useEffect(() => {
    // The words the reward kinds carry: vocabulary kinds celebrate the word
    // itself; dojo/kata/pattern carry an id that has a localized display name.
    const rewardWord = (kind: RewardKind, word: string): string => {
      switch (kind) {
        case "dojo":
          return t(`learning.dojo.kind.${word}.name`, { defaultValue: word });
        case "kata":
          return t(`learning.kata.${word}.title`, { defaultValue: word });
        case "kata_train":
          return "";
        case "prompt_pattern":
          return t(`learning.prompts.patterns.${word}.name`, { defaultValue: word });
        default:
          return word;
      }
    };

    const unReward = onLearningReward((r) => {
      if (!r.events.length) return;
      // Celebrate the biggest win of the batch, roll the rest into a sub line.
      const events = [...r.events].sort((a, b) => b.xp - a.xp);
      const first = events[0];
      const xp = events.reduce((sum, e) => sum + e.xp, 0);
      push(
        {
          cls: "reward",
          title: t(`learning.banner.kind.${first.kind}`),
          word: rewardWord(first.kind, first.word) || undefined,
          sub:
            events.length > 1
              ? t("learning.banner.more", { count: events.length - 1 })
              : undefined,
          xp,
        },
        xp >= 50 ? 2 : 1,
      );
      // Level-up rides the same event: compare against the last seen level.
      // Only a RISE from a known value banners (a fresh install / account
      // switch just seeds the marker silently).
      const seen = Number(localStorage.getItem("echo:xpLevel") ?? "");
      if (Number.isFinite(seen) && seen > 0 && r.level > seen) {
        push(
          { cls: "level", title: t("learning.banner.levelUp", { level: r.level }), xp: 0 },
          3,
        );
      }
      localStorage.setItem("echo:xpLevel", String(r.level));
    });

    const unFind = onWordFind((f) => {
      // Six-tier band → its localized label, interpolated into the banner title.
      const bandKey: Record<Band, string> = {
        1: "learning.bandCommon",
        2: "learning.bandUncommon",
        3: "learning.bandRare",
        4: "learning.bandEpic",
        5: "learning.bandMythic",
        6: "learning.bandLegendary",
      };
      const capped = f.xp <= 0;
      push(
        {
          cls: `find-${f.band}`,
          title: capped
            ? t("learning.banner.findNoXp")
            : t("learning.banner.find", { tier: t(bandKey[f.band]) }),
          word: f.display,
          sub: t("learning.banner.dexNo", { dex: f.dex }),
          xp: f.xp,
        },
        // Chime tier (3 levels): Mythisch/Legendär → 3, Selten/Episch → 2, rest → 1.
        capped ? 1 : f.band >= 5 ? 3 : f.band >= 3 ? 2 : 1,
      );
    });

    return () => {
      unReward.then((un) => un());
      unFind.then((un) => un());
    };
  }, [t, push]);

  if (banners.length === 0) return null;
  return (
    <div className="xpb-stack" aria-live="polite">
      {banners.map((b) => (
        <div
          key={b.id}
          className={`xpb xpb-${b.cls}${b.leaving ? " xpb-leaving" : ""}`}
          role="status"
          onClick={() => dismiss(b.id)}
        >
          <span className="xpb-icon">
            {b.cls === "level" ? (
              <LevelIcon />
            ) : b.cls.startsWith("find") ? (
              <SparkIcon />
            ) : (
              <CheckBadgeIcon />
            )}
          </span>
          <span className="xpb-body">
            <span className="xpb-title">{b.title}</span>
            {(b.word || b.sub) && (
              <span className="xpb-detail">
                {b.word && <span className="xpb-word">{b.word}</span>}
                {b.sub && <span className="xpb-sub">{b.sub}</span>}
              </span>
            )}
          </span>
          {b.xp > 0 && (
            <span className="xpb-xp">
              +<CountUp to={b.xp} /> XP
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
