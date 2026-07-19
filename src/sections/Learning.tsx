import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  achievementsList,
  dojoRecordCancel,
  dojoRecordLevel,
  dojoRecordStart,
  dojoRecordStop,
  dojoToday,
  fillerRemovedCounts,
  kataList,
  learningAnalysis,
  learningDailyTasks,
  learningLeaderboard,
  learningSuggestions,
  learningSuggestionsLlm,
  learningXp,
  onHistoryChanged,
  onLearningReward,
  onWordFind,
  onWeeklyReport,
  promptCoachStats,
  promptPatternToday,
  PROMPT_RUBRIC_KEYS,
  questsGet,
  speechProfile,
  speechProfileTrend,
  weeklyReportGet,
  wordOfDay,
  wordPackFetch,
  wordPackGet,
  wordsProgress,
  wortdexList,
  type Achievement,
  type Band,
  type Belt,
  type DailyTasks,
  type DojoKind,
  type DojoResult,
  type DojoToday,
  type KataList,
  type KataResult,
  type Leaderboard,
  type LeaderboardRow,
  type LearningAnalysis,
  type LearningEvent,
  type LearningSuggestions,
  type LearningXp,
  type PromptCoachStats,
  type PromptPatternToday,
  type Quest,
  type SpeechDimension,
  type SpeechInsight,
  type SpeechProfile,
  type SpeechTrend,
  type WeeklyReport,
  type WordFind,
  type WordFreq,
  type WordOfDay,
  type WordPack,
  type WordProgress,
  type WordsProgress,
  type WordStage,
  type WortdexData,
} from "../lib/ipc";
import { useToast } from "../state/ToastContext";
import { Avatar } from "../components/Avatar";
import { TierRing } from "../components/TierRing";
import { MemberProfile } from "../components/MemberProfile";
import { RadarChart, type RadarAxis } from "../components/charts/RadarChart";
import { Sparkline } from "../components/charts/Sparkline";
import { levelForXp } from "../lib/level";
import { useConfig } from "../state/ConfigContext";
import { DojoStage } from "../components/dojo/DojoStage";
import { KataPath } from "../components/dojo/KataPath";
import { HankoSeal } from "../components/dojo/HankoSeal";
import { BrushDivider } from "../components/dojo/BrushDivider";
import { type BeltRank } from "../components/dojo/ObiBelt";

/** Range presets steering the analysis window (days). Labels reuse the
 *  shared activity.range* keys so both sections speak the same language. */
const RANGES = [7, 30, 90] as const;

/** Below this many analysed words the per-card insights are statistically
 *  meaningless — cards fall back to the needMoreData hint instead. */
const MIN_WORDS = 30;

/** Every counter list in this section shows its top ten. One number, one rule —
 *  the uniformity is the point: the section used to mix a word cloud, a bar
 *  chart and three chip styles, which read as clutter. */
const RANK_LIMIT = 10;

// Small stroke-SVG glyphs (enterprise UI: no emojis), same 24er-viewBox
// convention as the Sidebar icons.
const CheckIcon = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

/** Hollow circle — the "criterion not met" counterpart to CheckIcon in the
 *  golf-drill rubric list (stroke-SVG, no emojis). */
const CircleOutlineIcon = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.1"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="8.5" />
  </svg>
);

const ArrowIcon = () => (
  <svg
    className="upgrade-arrow"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12h14" />
    <path d="m13 6 6 6-6 6" />
  </svg>
);

/** Trophy glyph for the achievements feed (stroke-SVG, no emojis). */
const TrophyIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z" />
    <path d="M7 6H4a1 1 0 0 0-1 1c0 2.2 1.8 4 4 4M17 6h3a1 1 0 0 1 1 1c0 2.2-1.8 4-4 4" />
  </svg>
);

// ── Generic achievement glyphs (stroke-SVG, inherit currentColor so the black
//    theme greys them for free). One per milestone family. ──
const StarIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 3 2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 17.8 6.4 20.1l1.4-6.3L3 9.5l6.4-.6L12 3Z" />
  </svg>
);
const FlameIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3c.6 3 2.4 4.3 3.6 5.9A6 6 0 0 1 17 12.5a5 5 0 0 1-10 .4c0-1.8.8-3.1 1.7-4 .2 1 .8 1.6 1.4 2C10.8 8.7 12 6.4 12 3Z" />
  </svg>
);
const BookIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 6.4C10.4 5 8 4.4 4 4.4V18c4 0 6.4.6 8 2 1.6-1.4 4-2 8-2V4.4c-4 0-6.4.6-8 2Z" />
    <path d="M12 6.4V20" />
  </svg>
);
const MedalIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8.4 3 6 8M15.6 3 18 8" />
    <circle cx="12" cy="15" r="5.2" />
    <path d="m12 12.4.95 1.9 2.1.3-1.52 1.48.36 2.1L12 17.2l-1.85.98.36-2.1L9 14.6l2.1-.3.9-1.9Z" />
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

/** Highest defined level title — levels above it reuse the top title. */
const MAX_LEVEL_TITLE = 9;

/** The one counter-list primitive behind every ranked tally in this section
 *  (most-used words, stripped fillers, fillers left in the text): rank, the
 *  word spelled out IN FULL, a proportional track, and the count.
 *
 *  Deliberately plain DOM rather than the shared BarChart: that one draws into
 *  a 640-unit viewBox with `preserveAspectRatio="none"`, so inside a narrow
 *  card every glyph is squeezed horizontally and long labels are cut to an
 *  ellipsis — which is precisely why the filler words were unreadable. Text
 *  that has to be *read* does not belong in a non-uniformly scaled SVG. */
function RankList({
  items,
  tone = "neutral",
  limit = RANK_LIMIT,
  columns = 1,
}: {
  items: WordFreq[];
  tone?: "neutral" | "warn" | "accent";
  limit?: number;
  columns?: 1 | 2;
}) {
  const shown = items.slice(0, limit);
  // Track scales against the leader, so rank 1 is always a full bar and every
  // other row reads as a share of it.
  const max = shown.reduce((m, i) => Math.max(m, i.count), 0);
  return (
    <ol className={`rank-list tone-${tone}${columns === 2 ? " cols-2" : ""}`}>
      {shown.map((w, i) => (
        <li key={w.word} className="rank-row">
          <span className="rank-num">{i + 1}</span>
          <span className="rank-word">{w.word}</span>
          <span className="rank-track" aria-hidden="true">
            <span
              className="rank-fill"
              style={{ width: `${max > 0 ? Math.max(2, (w.count / max) * 100) : 0}%` }}
            />
          </span>
          <span className="rank-count">{w.count}&times;</span>
        </li>
      ))}
    </ol>
  );
}

/** XP header strip: level badge + title, progress to the next level, weekly
 *  XP and the distinct-words tally. Pure display — all math is backend truth. */
function XpCard({ xp }: { xp: LearningXp }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || "en";
  const span = xp.next_level_xp - xp.level_floor_xp;
  const pct = span > 0 ? Math.min(100, Math.round(((xp.xp_total - xp.level_floor_xp) / span) * 100)) : 0;
  return (
    <div className="xp-card">
      <div className="xp-badge" aria-hidden="true">
        {xp.level}
      </div>
      <div className="xp-main">
        <div className="xp-row">
          <span className="xp-rank">
            {t(`learning.levelTitle${Math.min(xp.level, MAX_LEVEL_TITLE)}`)}
          </span>
          <span className="xp-total">{xp.xp_total.toLocaleString(lang)} XP</span>
        </div>
        <div className="xp-bar">
          <div className="xp-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="xp-meta">
          <span>{t("learning.xpWeek", { xp: xp.xp_week.toLocaleString(lang) })}</span>
          <span>
            {t("learning.nextLevel", {
              xp: Math.max(0, xp.next_level_xp - xp.xp_total).toLocaleString(lang),
            })}
          </span>
          <span>{t("learning.wordsUsed", { count: xp.distinct_words })}</span>
        </div>
      </div>
    </div>
  );
}

/** "Wort des Tages" — prominent daily-word card (§12d). Loads once on mount,
 *  deliberately independent of the range switcher below. */
function WordOfDayCard({ wod }: { wod: WordOfDay }) {
  const { t } = useTranslation();
  return (
    <div className="wod-card">
      <div className="wod-head">
        <span className="wod-eyebrow">{t("learning.wodTitle")}</span>
        {wod.already_used ? (
          <span className="wod-used-badge">
            <CheckIcon />
            {t("learning.wodUsedBadge", { xp: wod.xp })}
          </span>
        ) : (
          <span className="wod-challenge-badge">{t("learning.wodChallenge", { xp: wod.xp })}</span>
        )}
      </div>
      <div className="wod-word">{wod.word}</div>
      <div className="wod-meaning">{wod.meaning}</div>
      <div className="wod-synonyms-label">{t("learning.wodExampleLabel")}</div>
      <div className="wod-example">{wod.example}</div>
      {wod.synonyms.length > 0 && (
        <>
          <div className="wod-synonyms-label">{t("learning.wodSynonymsLabel")}</div>
          <div className="wod-synonyms">
            {wod.synonyms.map((s) => (
              <span key={s} className="wod-synonym">
                {s}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  Lern-Loop (Welle 3) — the coach that actually teaches. Ownership levels per
//  taught word, a "due for reinforcement" queue, a personalised weekly pack,
//  and a Monday week-in-review. All of it sits at the top of the Coach tab.
// ════════════════════════════════════════════════════════════════════════

/** Close/dismiss glyph (stroke-SVG, no emojis). */
const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

/** Stage → i18n label. `used` (Benutzt) → `fortified` (Gefestigt) → `mastered`
 *  (Gemeistert), the three ownership levels a taught word climbs. */
const STAGE_LABEL: Record<WordStage, string> = {
  used: "learning.loop.stageUsed",
  fortified: "learning.loop.stageFortified",
  mastered: "learning.loop.stageMastered",
};

/** Whole-day distance from `day` (YYYY-MM-DD, local midnight) to today, clamped
 *  at 0. Feeds a locale-correct RelativeTimeFormat ("vor 3 Tagen" / "yesterday"). */
function daysSince(day: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const then = new Date(`${day}T00:00:00`);
  return Math.max(0, Math.round((today.getTime() - then.getTime()) / 86400000));
}

/** Three progress dots for how many DISTINCT days a word has been used:
 *  0 → none lit, 1–2 → one, 3–4 → two, 5+ → all three (mastery in reach). */
function UseDots({ days }: { days: number }) {
  const filled = days >= 5 ? 3 : days >= 3 ? 2 : days >= 1 ? 1 : 0;
  return (
    <span className="loop-dots" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className={`loop-dot${i < filled ? " on" : ""}`} />
      ))}
    </span>
  );
}

/** Monday's week-in-review. Sits at the very top of the coach until dismissed
 *  (localStorage, keyed by the reviewed week). XP with its delta to the week
 *  before — arrow + colour — and the week's new collectible finds. */
function WeeklyReportCard({
  report,
  onDismiss,
}: {
  report: WeeklyReport;
  onDismiss: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || "en";
  const delta = report.xp - report.xp_before;
  const date = new Date(`${report.week_prev}T00:00:00`).toLocaleDateString(lang, {
    day: "numeric",
    month: "long",
  });
  return (
    <div className="chart-card loop-report">
      <button
        type="button"
        className="loop-report-close"
        aria-label={t("learning.loop.reportDismiss")}
        onClick={onDismiss}
      >
        <CloseIcon />
      </button>
      <div className="loop-report-eyebrow">{t("learning.loop.reportTitle")}</div>
      <div className="loop-report-stats">
        <div className="loop-report-stat">
          <div className="loop-report-numline">
            <span className="loop-report-num">{report.xp.toLocaleString(lang)}</span>
            {delta !== 0 && (
              <span className={`loop-report-delta ${delta > 0 ? "up" : "down"}`}>
                <DeltaArrow up={delta > 0} />
                {delta > 0 ? "+" : "−"}
                {Math.abs(delta).toLocaleString(lang)}
              </span>
            )}
          </div>
          <span className="loop-report-lbl">{t("learning.loop.reportXpLabel")}</span>
        </div>
        <div className="loop-report-stat">
          <span className="loop-report-num">{report.finds.toLocaleString(lang)}</span>
          <span className="loop-report-lbl">{t("learning.loop.reportFinds")}</span>
        </div>
      </div>
      <div className="loop-report-sub">{t("learning.loop.reportSub", { date })}</div>
    </div>
  );
}

/** The personalised weekly pack. `source: "none"` → an invitation + the curate
 *  button (which crosses the slow LLM path, so it shows a skeleton with the
 *  "~40 seconds" hint); `source: "llm"` → the seven curated words, each with a
 *  meaning, an italic example and its personal "why" as an accent-bordered note. */
function WeekPackCard({
  pack,
  loading,
  onFetch,
}: {
  pack: WordPack | null;
  loading: boolean;
  onFetch: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || "en";
  const date = pack
    ? new Date(`${pack.week}T00:00:00`).toLocaleDateString(lang, { day: "numeric", month: "long" })
    : "";
  return (
    <div className="chart-card loop-pack">
      <div className="chart-head">
        <div>
          <div className="chart-title">{t("learning.loop.packTitle")}</div>
          {pack && <div className="chart-sub">{t("learning.loop.packWeek", { date })}</div>}
        </div>
      </div>
      {loading ? (
        <div className="loop-pack-loading" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="loop-pack-skel" aria-hidden="true">
              <span className="skeleton-bar" style={{ width: "34%" }} />
              <span className="skeleton-bar" style={{ width: "72%" }} />
              <span className="skeleton-bar" style={{ width: "58%" }} />
            </div>
          ))}
          <p className="loop-pack-hint">{t("learning.loop.packCurating")}</p>
        </div>
      ) : !pack || pack.source === "none" || pack.words.length === 0 ? (
        <div className="loop-pack-empty">
          <p className="loop-pack-intro">{t("learning.loop.packEmptyIntro")}</p>
          <button type="button" className="loop-pack-btn" onClick={onFetch}>
            {t("learning.loop.packCurate")}
          </button>
        </div>
      ) : (
        <ol className="loop-pack-list">
          {pack.words.map((w) => (
            <li key={w.word} className="loop-pack-row">
              <div className="loop-pack-wordline">
                <span className="loop-pack-word">{w.word}</span>
                <UseDots days={w.use_days} />
              </div>
              <div className="loop-pack-meaning">{w.meaning}</div>
              <div className="loop-pack-example">{w.example}</div>
              <div className="loop-pack-why">{w.why}</div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The reinforcement queue — the taught words whose next spaced-repetition slot
 *  is open. One row each: word, its ownership-stage chip, and when it was last
 *  used (locale-correct relative time). A count badge rides the title. */
function DueCard({ words, count }: { words: WordProgress[]; count: number }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || "en";
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const due = words.filter((w) => w.due);
  return (
    <div className="chart-card loop-due">
      <div className="chart-head">
        <div>
          <div className="chart-title">
            {t("learning.loop.dueTitle")}
            <span className="loop-badge">{count}</span>
          </div>
          <div className="chart-sub">{t("learning.loop.dueSub")}</div>
        </div>
      </div>
      <div className="loop-due-list">
        {due.map((w) => (
          <div key={w.word} className="loop-due-row">
            <span className="loop-due-word">{w.word}</span>
            <span className={`loop-stage-chip stage-${w.stage}`}>{t(STAGE_LABEL[w.stage])}</span>
            <span className="loop-due-ago">
              {t("learning.loop.dueLastUsed", { when: rtf.format(-daysSince(w.last_day), "day") })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ownership overview — a stat chip per stage (used · fortified · mastered),
 *  same grammar as the Wortdex band chips, plus the level rules behind an info
 *  tooltip (--menu-bg). */
function OwnershipCard({ words }: { words: WordProgress[] }) {
  const { t } = useTranslation();
  const stats: { key: WordStage; n: number }[] = [
    { key: "used", n: words.filter((w) => w.stage === "used").length },
    { key: "fortified", n: words.filter((w) => w.stage === "fortified").length },
    { key: "mastered", n: words.filter((w) => w.stage === "mastered").length },
  ];
  return (
    <div className="chart-card loop-own">
      <div className="chart-head">
        <div>
          <div className="chart-title">
            {t("learning.loop.ownTitle")}
            <InfoDot tip={t("learning.loop.ownLegend")} />
          </div>
          <div className="chart-sub">{t("learning.loop.ownSub")}</div>
        </div>
      </div>
      <div className="loop-stats">
        {stats.map((s) => (
          <div key={s.key} className={`loop-stat loop-stat--${s.key}`}>
            <span className="loop-stat-dot" aria-hidden="true" />
            <span className="loop-stat-num">{s.n}</span>
            <span className="loop-stat-label">{t(STAGE_LABEL[s.key])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The upgrade coach. One suggestion is one line: word, tally, arrow, its
 *  alternatives as chips — every row the same height at rest.
 *
 *  The explanation is no longer printed under each chip permanently: it used to
 *  trail every alternative, which blew the rows up to wildly uneven heights and
 *  buried the suggestions themselves. It now comes on demand — hover shows it as
 *  a tooltip, a click pins it open (the path that keyboard and touch users get,
 *  where there is no hover). */
function UpgradeCoach({
  suggestions,
  loading,
  refining,
}: {
  suggestions: LearningSuggestions | null;
  loading: boolean;
  refining: boolean;
}) {
  const { t } = useTranslation();
  // Which alternative's note is pinned open — exactly one at a time, keyed
  // `word::alternative`, so opening a second one closes the first.
  const [openNote, setOpenNote] = useState<string | null>(null);

  // A pending fetch must never render as "no data" — that is what made the
  // coach look broken while the LLM round trip was in flight.
  if (loading) {
    return (
      <div className="upgrade-list" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="upgrade-row is-skeleton" aria-hidden="true">
            <span className="skeleton-bar" style={{ width: "18%" }} />
            <span className="skeleton-bar" style={{ width: "52%" }} />
          </div>
        ))}
        <p className="upgrade-status">{t("learning.suggestLoading")}</p>
      </div>
    );
  }

  if (!suggestions || suggestions.suggestions.length === 0) {
    return <div className="empty">{t("learning.needMoreData")}</div>;
  }

  return (
    <div className="upgrade-list">
      {suggestions.suggestions.map((s) => {
        const pinned = s.alternatives.find((a) => openNote === `${s.word}::${a.word}` && a.note);
        return (
          <div key={s.word} className="upgrade-row">
            <div className="upgrade-main">
              <span className="upgrade-word">{s.word}</span>
              <span className="upgrade-count">{s.count}&times;</span>
              <ArrowIcon />
              <div className="upgrade-alts">
                {s.alternatives.map((a) => {
                  const key = `${s.word}::${a.word}`;
                  const open = openNote === key;
                  return (
                    <button
                      key={a.word}
                      type="button"
                      className={`alt-chip${a.note ? " has-note" : ""}${open ? " open" : ""}`}
                      // Feeds the CSS hover tooltip — no JS, no layout cost.
                      data-note={a.note || undefined}
                      aria-expanded={a.note ? open : undefined}
                      onClick={() => a.note && setOpenNote(open ? null : key)}
                    >
                      {a.word}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* Pinned explanation — at most one, and only when asked for, so
                every suggestion keeps the same resting height. */}
            {pinned?.note && (
              <p className="upgrade-note">
                <strong>{pinned.word}</strong> — {pinned.note}
              </p>
            )}
          </div>
        );
      })}
      {refining && <p className="upgrade-status">{t("learning.suggestRefining")}</p>}
    </div>
  );
}

/** XP-feed event kind → its i18n label. A prompt_pattern event is the newest
 *  kind (Welle 5); unknown kinds fall back to the word-find label. */
const XP_KIND_LABEL: Record<LearningEvent["kind"], string> = {
  word_of_day: "learning.kindWod",
  coach_word: "learning.kindCoach",
  word_find: "learning.kindFind",
  prompt_pattern: "learning.kindPattern",
};

/** The Coach tab: the whole existing learning surface, unchanged apart from the
 *  leaderboard rows now carrying a level-ring avatar + worn title, the XP feed
 *  learning the new "word_find" kind, and the gamification header refreshing on
 *  a word-find too. */

/** One line of the daily-tasks card: check state, label, optional word/detail,
 *  the XP it pays and an optional progress fraction. Navigable lines render as
 *  buttons with a chevron. */
function TaskRow({
  done,
  label,
  detail,
  xp,
  progress,
  onClick,
}: {
  done: boolean;
  label: string;
  detail?: string;
  xp: string;
  progress?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className={`task-check${done ? " done" : ""}`} aria-hidden="true">
        {done && <CheckIcon />}
      </span>
      <span className="task-body">
        <span className={`task-label${done ? " done" : ""}`}>{label}</span>
        {detail && <span className="task-detail">{detail}</span>}
      </span>
      {progress && <span className="task-progress">{progress}</span>}
      <span className={`task-xp${done ? " done" : ""}`}>{xp}</span>
      {onClick && (
        <svg className="task-go" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            d="M9 6l6 6-6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </>
  );
  return onClick ? (
    <button type="button" className="task-row navigable" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="task-row">{body}</div>
  );
}

/** Daily tasks — today's XP menu. Every line is one way to earn XP right now,
 *  with its reward and done state read from the same ledgers the award paths
 *  write (a checked task can never disagree with the XP header). The coach
 *  line names concrete taught words from the user's own suggestions — the
 *  personalised "say THIS today" — and the dojo/kata/pattern lines navigate
 *  to their tab. */
function DailyTasksCard({
  tasks,
  onNavigate,
}: {
  tasks: DailyTasks;
  onNavigate: (tab: "dojo" | "prompts") => void;
}) {
  const { t } = useTranslation();
  const coachDone = tasks.coach.earned_today >= tasks.coach.cap;
  const findsDone = tasks.finds.today >= tasks.finds.cap;
  const rows = [
    tasks.wod.done,
    coachDone,
    tasks.dojo.done,
    tasks.kata.train_done,
    tasks.pattern.done,
    findsDone,
  ];
  const doneCount = rows.filter(Boolean).length;
  return (
    <div className="chart-card tasks-card">
      <div className="chart-head">
        <div>
          <div className="chart-title">{t("learning.tasks.title")}</div>
          <div className="chart-sub">{t("learning.tasks.sub")}</div>
        </div>
        <span className="tasks-done-chip">
          {t("learning.tasks.doneChip", { done: doneCount, total: rows.length })}
        </span>
      </div>
      <div className="tasks-list">
        <TaskRow
          done={tasks.wod.done}
          label={t("learning.tasks.wod")}
          detail={tasks.wod.word}
          xp={`+${tasks.wod.xp} XP`}
        />
        <TaskRow
          done={coachDone}
          label={t("learning.tasks.coach")}
          detail={tasks.coach.words.length > 0 ? tasks.coach.words.join(" · ") : undefined}
          xp={`+${tasks.coach.xp_each} XP`}
          progress={`${tasks.coach.earned_today}/${tasks.coach.cap}`}
        />
        <TaskRow
          done={tasks.dojo.done}
          label={t("learning.tasks.dojo", {
            name: t(`learning.dojo.kind.${tasks.dojo.kind}.name`),
          })}
          xp={`+${tasks.dojo.xp} XP`}
          onClick={() => onNavigate("dojo")}
        />
        <TaskRow
          done={tasks.kata.train_done}
          label={t("learning.tasks.kataTrain")}
          xp={`+${tasks.kata.train_xp} XP`}
          onClick={() => onNavigate("dojo")}
        />
        {tasks.kata.next && (
          <TaskRow
            done={false}
            label={t("learning.tasks.kataNext", {
              name: t(`learning.kata.${tasks.kata.next}.title`),
            })}
            xp={`+${tasks.kata.next_xp} XP`}
            onClick={() => onNavigate("dojo")}
          />
        )}
        <TaskRow
          done={tasks.pattern.done}
          label={t("learning.tasks.pattern", {
            name: t(`learning.prompts.patterns.${tasks.pattern.id}.name`),
          })}
          xp={`+${tasks.pattern.xp} XP`}
          onClick={() => onNavigate("prompts")}
        />
        <TaskRow
          done={findsDone}
          label={t("learning.tasks.finds")}
          xp={t("learning.tasks.findsXp")}
          progress={`${tasks.finds.today}/${tasks.finds.cap}`}
        />
      </div>
    </div>
  );
}

function CoachTab({ onNavigate }: { onNavigate: (tab: "dojo" | "prompts") => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  // Own account picture — the freshest local truth for the "me" row (shows a
  // just-uploaded avatar even before the next score push has mirrored it).
  const { config } = useConfig();

  const [wod, setWod] = useState<WordOfDay | null>(null);
  const [xp, setXp] = useState<LearningXp | null>(null);
  const [lb, setLb] = useState<Leaderboard | null>(null);
  const [selectedMember, setSelectedMember] = useState<LeaderboardRow | null>(null);
  const [days, setDays] = useState<number>(30);
  const [analysis, setAnalysis] = useState<LearningAnalysis | null>(null);
  const [suggestions, setSuggestions] = useState<LearningSuggestions | null>(null);
  const [refining, setRefining] = useState(false);
  // Fillers Echo actually stripped. Their own counter, because by the time a
  // transcript reaches the history they are *gone* from it — counting the
  // history could never surface them.
  const [stripped, setStripped] = useState<WordFreq[]>([]);

  // ── Lern-Loop (Welle 3) state ──────────────────────────────────────────
  const [progress, setProgress] = useState<WordsProgress | null>(null);
  const [pack, setPack] = useState<WordPack | null>(null);
  const [packLoading, setPackLoading] = useState(false);
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [reportDismissed, setReportDismissed] = useState(
    () => localStorage.getItem("echo:weeklyReportDismissed") ?? "",
  );

  // Word of the day + XP state: range-independent, but BOTH change the moment
  // a dictation uses a taught word OR lands a new collectible word — refresh on
  // both the reward event and the word-find event (and on history-changed).
  const [tasks, setTasks] = useState<DailyTasks | null>(null);

  useEffect(() => {
    const refreshGamification = () => {
      wordOfDay().then(setWod).catch(() => {});
      learningXp().then(setXp).catch(() => {});
      // The daily-tasks card follows the same two events: any award or find
      // flips its check marks / progress fractions.
      learningDailyTasks().then(setTasks).catch(() => {});
    };
    refreshGamification();
    const un = onLearningReward(refreshGamification);
    const unf = onWordFind(refreshGamification);
    return () => {
      un.then((f) => f());
      unf.then((f) => f());
    };
  }, []);

  // Leaderboard: one round-trip on mount (pushes the own score first). NOT
  // re-fetched per dictation — the server is not a realtime scoreboard.
  useEffect(() => {
    learningLeaderboard().then(setLb).catch(() => setLb(null));
  }, []);

  // Ownership levels: local truth that shifts the moment a dictation uses a
  // taught word (it levels up / a due slot closes) or a reward lands — so this
  // follows the same two events the gamification header does.
  useEffect(() => {
    const load = () => wordsProgress().then(setProgress).catch(() => {});
    load();
    const un = onHistoryChanged(load);
    const unr = onLearningReward(load);
    return () => {
      un.then((f) => f());
      unr.then((f) => f());
    };
  }, []);

  // Weekly pack — the cached pack, read once (instant/local). The slow LLM
  // curation is user-triggered, never on the paint path.
  useEffect(() => {
    wordPackGet().then(setPack).catch(() => {});
  }, []);

  // Weekly report — the cached one on mount, then kept live by the Monday event.
  useEffect(() => {
    weeklyReportGet().then(setReport).catch(() => {});
    const un = onWeeklyReport(setReport);
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Curate this week's pack. Up to ~50 s on the server; a failure keeps the
  // cached pack and only toasts, never blanks the card.
  const fetchPack = useCallback(async () => {
    setPackLoading(true);
    try {
      const p = await wordPackFetch();
      if (p.source === "error") toast(t("learning.loop.packError"), "error");
      else setPack(p);
    } catch {
      toast(t("learning.loop.packError"), "error");
    } finally {
      setPackLoading(false);
    }
  }, [toast, t]);

  const dismissReport = useCallback(() => {
    if (!report) return;
    localStorage.setItem("echo:weeklyReportDismissed", report.week_prev);
    setReportDismissed(report.week_prev);
  }, [report]);

  // The fast path: analysis, the curated local suggestions and the strip
  // counters are ALL pure local IPC (never network), so they can safely follow
  // every dictation and every range switch.
  const refresh = useCallback((d: number) => {
    learningAnalysis(d).then(setAnalysis).catch(() => {});
    learningSuggestions(d).then(setSuggestions).catch(() => {});
    fillerRemovedCounts(d).then(setStripped).catch(() => {});
  }, []);
  useEffect(() => refresh(days), [days, refresh]);
  useEffect(() => {
    const un = onHistoryChanged(() => refresh(days));
    return () => {
      un.then((f) => f());
    };
  }, [days, refresh]);

  // The slow path, fenced off from the paint: the server curates the same words
  // with an LLM. This used to run INSIDE the suggestions command, so the coach
  // sat empty behind a network round trip (30 s budget) — and re-ran it on every
  // single dictation. It now follows the range only, never the history, and it
  // upgrades a list that is already on screen.
  useEffect(() => {
    let alive = true;
    setRefining(true);
    learningSuggestionsLlm(days)
      .then((s) => {
        if (alive && s.source === "llm" && s.suggestions.length > 0) setSuggestions(s);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setRefining(false);
      });
    return () => {
      alive = false;
    };
  }, [days]);

  const hasData = analysis !== null && analysis.total_words > 0;
  const enoughData = analysis !== null && analysis.total_words >= MIN_WORDS;

  const ttrPct = analysis ? analysis.type_token_ratio * 100 : 0;
  const ttrQuality =
    analysis === null
      ? ""
      : analysis.type_token_ratio >= 0.5
        ? t("learning.ttrHigh")
        : analysis.type_token_ratio >= 0.3
          ? t("learning.ttrMid")
          : t("learning.ttrLow");

  // Two different truths, deliberately kept apart:
  //   • stripped — hesitations ("ähm", "äh", "hmm") Echo DELETED for you.
  //   • kept     — discourse crutches ("also", "quasi") it leaves standing,
  //                because cutting those would change what you actually said.
  const strippedTotal = useMemo(() => stripped.reduce((n, f) => n + f.count, 0), [stripped]);
  const kept = useMemo(() => analysis?.filler_counts ?? [], [analysis]);
  const keptTotal = useMemo(() => kept.reduce((n, f) => n + f.count, 0), [kept]);
  const fillerRate =
    analysis && analysis.total_words > 0 ? (keptTotal / analysis.total_words) * 100 : 0;

  const sourceBadge = suggestions && (
    <span className={`upgrade-source source-${suggestions.source}`}>
      {t(suggestions.source === "llm" ? "learning.sourceLlm" : "learning.sourceLocal")}
    </span>
  );

  return (
    <div>
      {/* Week-in-review — the very top of the coach, until dismissed. */}
      {report && reportDismissed !== report.week_prev && (
        <WeeklyReportCard report={report} onDismiss={dismissReport} />
      )}

      {xp && <XpCard xp={xp} />}

      {/* Today's XP menu — how to earn, right under the XP header. */}
      {tasks && <DailyTasksCard tasks={tasks} onNavigate={onNavigate} />}

      {wod && <WordOfDayCard wod={wod} />}

      {/* The personalised weekly pack — directly under the word of the day. */}
      <WeekPackCard pack={pack} loading={packLoading} onFetch={fetchPack} />

      {/* Reinforcement queue — only when something is actually due. */}
      {progress && progress.due_count > 0 && (
        <DueCard words={progress.words} count={progress.due_count} />
      )}

      {/* Ownership overview — the stage counters, once any word is being learnt. */}
      {progress && progress.words.length > 0 && <OwnershipCard words={progress.words} />}

      {/* Achievements — its own full-width box now. It used to share a
          two-column grid with the leaderboard, which squeezed the rows until the
          words were cut off mid-ellipsis. */}
      {xp && xp.events.length > 0 && (
        <div className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">{t("learning.feedTitle")}</div>
              <div className="chart-sub">{t("learning.feedSub")}</div>
            </div>
          </div>
          <div className="xp-feed">
            {xp.events.slice(0, 6).map((e) => (
              <div key={`${e.day}-${e.kind}-${e.word}`} className="xp-feed-row">
                <span className="xp-feed-icon">
                  <TrophyIcon />
                </span>
                <span className="xp-feed-word">{e.word}</span>
                <span className="xp-feed-kind">
                  {t(XP_KIND_LABEL[e.kind] ?? "learning.kindFind")}
                </span>
                <span className="xp-feed-xp">+{e.xp}</span>
                <span className="xp-feed-date">
                  {new Date(e.ts * 1000).toLocaleDateString(i18n.language, {
                    day: "numeric",
                    month: "numeric",
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Leaderboard — likewise its own box, so names and scores fit. All-time
          only (TJ: the week view made the numbers look unfair next to the
          lifetime level rings): top-ten by xp_total, every row opens a member
          profile. */}
      {lb?.available && (lb.total?.length ?? 0) > 0 && (() => {
        const shown = (lb.total ?? []).slice(0, 10);
        const meRank = lb.me?.rank_total;
        const meXp = xp?.xp_total;
        return (
          <div className="chart-card">
            <div className="chart-head">
              <div>
                <div className="chart-title">{t("learning.lbTitle")}</div>
                <div className="chart-sub">{t("learning.lbSub")}</div>
              </div>
            </div>
            <div className="xp-feed">
              {shown.map((row) => (
                <button
                  key={row.rank}
                  type="button"
                  className={`xp-feed-row lb-row-btn${row.me ? " me" : ""}`}
                  onClick={() => setSelectedMember(row)}
                >
                  <span className="lb-rank">{row.rank}</span>
                  {/* Level ring only materialises when the server sends xp_total
                      and it clears level 3 — old servers → bare avatar. The photo
                      is the member's account picture (server-mirrored); for me
                      prefer the local config URL so a fresh upload shows at once.
                      No src → initials, exactly as before. */}
                  <TierRing level={levelForXp(row.xp_total ?? 0)} size={22}>
                    <Avatar
                      name={row.name}
                      src={row.me ? (config?.avatar_url ?? row.avatar) : row.avatar}
                      size={22}
                    />
                  </TierRing>
                  <span className="lb-level" aria-hidden="true">
                    {levelForXp(row.xp_total ?? 0)}
                  </span>
                  <span className="xp-feed-word">
                    {row.me ? t("learning.lbYou", { name: row.name }) : row.name}
                  </span>
                  {row.title && (
                    <span className="lb-title">{t(`learning.titles.${row.title}`)}</span>
                  )}
                  <span className="xp-feed-kind">
                    {t("learning.lbWords", { count: row.words })}
                  </span>
                  <span className="xp-feed-xp">{row.xp.toLocaleString(i18n.language)} XP</span>
                </button>
              ))}
              {meRank != null && !shown.some((r) => r.me) && (
                <div className="xp-feed-row me">
                  <span className="lb-rank">{meRank}</span>
                  <TierRing level={levelForXp(xp?.xp_total ?? 0)} size={22}>
                    <Avatar
                      name={config?.nickname || config?.display_name || ""}
                      src={config?.avatar_url}
                      size={22}
                    />
                  </TierRing>
                  <span className="xp-feed-word">{t("learning.lbYou", { name: "" })}</span>
                  <span className="xp-feed-xp">
                    {(meXp ?? 0).toLocaleString(i18n.language)} XP
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {selectedMember && (
        <MemberProfile row={selectedMember} onClose={() => setSelectedMember(null)} />
      )}

      <div className="sub-tabs" style={{ marginBottom: 16 }}>
        {RANGES.map((d) => (
          <button
            key={d}
            className={`sub-tab ${days === d ? "active" : ""}`}
            onClick={() => setDays(d)}
          >
            {t(`activity.range${d}`)}
          </button>
        ))}
      </div>

      {analysis !== null && !hasData ? (
        <div className="empty">{t("learning.empty")}</div>
      ) : analysis === null ? null : (
        <>
          {/* Vocabulary richness */}
          <div className="card">
            <div className="chart-head">
              <div>
                <div className="chart-title">{t("learning.vocabRichness")}</div>
                <div className="chart-sub">{t("learning.subtitle")}</div>
              </div>
            </div>
            <div className="metric-row">
              <div className="label">{t("learning.uniqueWords")}</div>
              <div className="value">{analysis.unique_words.toLocaleString()}</div>
            </div>
            <div className="metric-row">
              <div>
                <div className="label">{t("learning.typeTokenRatio")}</div>
                <div className="hint">{t("learning.ttrHint")}</div>
              </div>
              <div className="value">
                {ttrPct.toFixed(0)}%{enoughData ? ` — ${ttrQuality}` : ""}
              </div>
            </div>
            <div className="metric-row">
              <div className="label">{t("learning.avgSentence")}</div>
              <div className="value">{analysis.avg_sentence_length.toFixed(1)}</div>
            </div>
          </div>

          {/* Most-used words — a plain top-ten ranking with tallies, and nothing
              else. No word cloud, and no "add to vocabulary" hand-off: these are
              your everyday words, not terms Echo needs taught. */}
          <div className="chart-card">
            <div className="chart-head">
              <div>
                <div className="chart-title">{t("learning.topWordsTitle")}</div>
                <div className="chart-sub">{t("learning.topWordsSub")}</div>
              </div>
            </div>
            {analysis.top_words.length > 0 ? (
              <RankList items={analysis.top_words} tone="accent" columns={2} />
            ) : (
              <div className="empty">{t("learning.needMoreData")}</div>
            )}
          </div>

          {/* Filler words — its own big box, and two honest halves. */}
          <div className="chart-card">
            <div className="chart-head">
              <div>
                <div className="chart-title">{t("learning.fillerTitle")}</div>
                <div className="chart-sub">{t("learning.fillerSub")}</div>
              </div>
              {keptTotal > 0 && (
                <span className="filler-rate">
                  {t("learning.fillerRate")} {fillerRate.toFixed(1)}%
                </span>
              )}
            </div>

            <div className="filler-split">
              {/* What Echo threw out for you. */}
              <div className="filler-half">
                <div className="filler-half-head">
                  <span className="filler-half-title">{t("learning.fillerRemovedTitle")}</span>
                  {strippedTotal > 0 && (
                    <span className="filler-total">
                      {t("learning.fillerRemovedTotal", { count: strippedTotal })}
                    </span>
                  )}
                </div>
                <p className="filler-half-sub">{t("learning.fillerRemovedSub")}</p>
                {stripped.length > 0 ? (
                  <RankList items={stripped} tone="accent" />
                ) : (
                  <div className="chip-row">
                    <span className="ok-chip">
                      <CheckIcon />
                      {t("learning.fillerRemovedNone")}
                    </span>
                  </div>
                )}
              </div>

              {/* What it deliberately left standing. */}
              <div className="filler-half">
                <div className="filler-half-head">
                  <span className="filler-half-title">{t("learning.fillerKeptTitle")}</span>
                  {keptTotal > 0 && (
                    <span className="filler-total">
                      {t("learning.fillerKeptTotal", { count: keptTotal })}
                    </span>
                  )}
                </div>
                <p className="filler-half-sub">{t("learning.fillerKeptSub")}</p>
                {kept.length > 0 ? (
                  <RankList items={kept} tone="warn" />
                ) : (
                  <div className="chip-row">
                    <span className="ok-chip">
                      <CheckIcon />
                      {t("learning.fillerNone")}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Upgrade coach — advisory only, never writes to the vocabulary
              (a synonym VocabEntry would destructively rewrite transcripts). */}
          <div className="chart-card">
            <div className="chart-head">
              <div>
                <div className="chart-title">{t("learning.upgradeTitle")}</div>
                <div className="chart-sub">{t("learning.upgradeHint")}</div>
              </div>
              {sourceBadge}
            </div>
            <UpgradeCoach
              suggestions={suggestions}
              loading={suggestions === null}
              refining={refining}
            />
          </div>

          {/* Overused words */}
          <div className="chart-card">
            <div className="chart-head">
              <div>
                <div className="chart-title">{t("learning.overusedTitle")}</div>
              </div>
            </div>
            {analysis.overused_words.length > 0 ? (
              <div className="chip-row">
                {analysis.overused_words.map((o) => (
                  <span key={o.word} className="warn-chip" title={`×${o.ratio.toFixed(1)}`}>
                    {o.word}
                    <span className="count">{o.count}&times;</span>
                  </span>
                ))}
              </div>
            ) : (
              <div className="chip-row">
                <span className="ok-chip">
                  <CheckIcon />
                  {t("learning.overusedNone")}
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Band → CSS accent + i18n label. 1 = notable (cyan), 2 = rare (violet),
 *  3 = legendary (amber); the black theme greys them via activity.css. */
const BAND_LABEL: Record<Band, string> = {
  1: "learning.bandNotable",
  2: "learning.bandRare",
  3: "learning.bandLegendary",
};

/** One collectible word, Pokédex-card style. */
function DexCard({ find }: { find: WordFind }) {
  const { t, i18n } = useTranslation();
  const date = new Date(find.first_ts * 1000).toLocaleDateString(i18n.language, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return (
    <div className={`dex-card dex-card--band${find.band}`}>
      <div className="dex-card-top">
        <span className="dex-word">{find.display}</span>
        {find.count > 1 && (
          <span className="dex-times">{t("learning.dexTimes", { count: find.count })}</span>
        )}
      </div>
      <div className="dex-card-meta">
        <span className="dex-band-chip">{t(BAND_LABEL[find.band])}</span>
        <span className="dex-nr">{t("learning.dexNr", { dex: find.dex })}</span>
      </div>
      <div className="dex-date">{t("learning.dexFirstFound", { date })}</div>
      {find.context.trim() && (
        <p className="dex-quote">{t("learning.dexQuote", { context: find.context.trim() })}</p>
      )}
    </div>
  );
}

/** The Wortdex tab — the collection of rare words spoken in real dictations. */
function WortdexTab({ data }: { data: WortdexData | null }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<"all" | Band>("all");

  if (data === null) {
    return (
      <div className="empty" aria-busy="true">
        {t("learning.dexLoading")}
      </div>
    );
  }

  const { finds, counts } = data;
  const total = counts.notable + counts.rare + counts.legendary;

  if (total === 0) {
    return (
      <div className="dex-empty">
        <div className="dex-empty-title">{t("learning.dexEmpty")}</div>
        <p className="dex-empty-hint">{t("learning.dexEmptyHint")}</p>
      </div>
    );
  }

  const shown = filter === "all" ? finds : finds.filter((f) => f.band === filter);
  const filters: { key: "all" | Band; label: string }[] = [
    { key: "all", label: t("learning.bandAll") },
    { key: 1, label: t("learning.bandNotable") },
    { key: 2, label: t("learning.bandRare") },
    { key: 3, label: t("learning.bandLegendary") },
  ];

  return (
    <div>
      <div className="chart-head" style={{ marginBottom: 14 }}>
        <div>
          <div className="chart-title">{t("learning.dexTitle")}</div>
          <div className="chart-sub">{t("learning.dexSub")}</div>
        </div>
      </div>

      {/* Per-band totals — display stat chips. */}
      <div className="dex-stats">
        {([1, 2, 3] as Band[]).map((b) => (
          <div key={b} className={`dex-stat dex-stat--band${b}`}>
            <span className="dex-dot" aria-hidden="true" />
            <span className="dex-stat-num">
              {b === 1 ? counts.notable : b === 2 ? counts.rare : counts.legendary}
            </span>
            <span className="dex-stat-label">{t(BAND_LABEL[b])}</span>
          </div>
        ))}
      </div>

      {/* Filter chips. */}
      <div className="dex-filters">
        {filters.map((f) => (
          <button
            key={String(f.key)}
            className={`dex-filter${filter === f.key ? " active" : ""}${
              typeof f.key === "number" ? ` dex-filter--band${f.key}` : ""
            }`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="empty">{t("learning.dexFilterEmpty")}</div>
      ) : (
        <div className="dex-grid">
          {shown.map((f) => (
            <DexCard key={`${f.word}-${f.dex}`} find={f} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The Achievements tab — milestone cards, each granting an equippable title. */
function AchievementsTab() {
  const { t, i18n } = useTranslation();
  const { config, patch } = useConfig();
  const [items, setItems] = useState<Achievement[] | null>(null);

  useEffect(() => {
    const load = () => achievementsList().then(setItems).catch(() => {});
    load();
    const un1 = onWordFind(load);
    const un2 = onLearningReward(load);
    const un3 = onHistoryChanged(load);
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
    };
  }, []);

  const worn = config?.learning_title ?? "";

  if (items === null) {
    return (
      <div className="empty" aria-busy="true">
        {t("learning.achLoading")}
      </div>
    );
  }

  return (
    <div>
      <div className="chart-head" style={{ marginBottom: 14 }}>
        <div>
          <div className="chart-title">{t("learning.achTitle")}</div>
          <div className="chart-sub">{t("learning.achSub")}</div>
        </div>
      </div>

      <div className="ach-grid">
        {items.map((a) => {
          const pct = a.target > 0 ? Math.min(100, Math.round((a.progress / a.target) * 100)) : 0;
          const isWorn = worn === a.id;
          const earnedDate =
            a.earned_ts != null
              ? new Date(a.earned_ts * 1000).toLocaleDateString(i18n.language, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })
              : null;
          return (
            <div key={a.id} className={`ach-card ${a.earned ? "is-earned" : "is-locked"}`}>
              <div className="ach-icon">{achIcon(a.id)}</div>
              <div className="ach-body">
                <div className="ach-name">{t(`learning.ach.${a.id}.name`)}</div>
                <div className="ach-desc">{t(`learning.ach.${a.id}.desc`)}</div>

                {a.earned ? (
                  <div className="ach-earned">
                    <span className="ach-title-name">{t(`learning.titles.${a.id}`)}</span>
                    {earnedDate && (
                      <span className="ach-earned-date">
                        {t("learning.achEarnedOn", { date: earnedDate })}
                      </span>
                    )}
                    <button
                      type="button"
                      className={`ach-title-btn${isWorn ? " worn" : ""}`}
                      onClick={() => patch({ learning_title: isWorn ? "" : a.id })}
                    >
                      {isWorn ? t("learning.achRemoveTitle") : t("learning.achWearTitle")}
                    </button>
                  </div>
                ) : (
                  <div className="ach-progress">
                    <div className="xp-bar">
                      <div className="xp-bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="ach-progress-text">
                      {a.progress.toLocaleString(i18n.language)} /{" "}
                      {a.target.toLocaleString(i18n.language)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  Sprechprofil — the rhetoric-analysis radar (§ Learning tab 4).
// ════════════════════════════════════════════════════════════════════════

/** The six dimensions in radar order (top, then clockwise). Also the card
 *  order — the backend already delivers them in this sequence, but pinning it
 *  here keeps the radar and the cards in lock-step regardless. */
const SPEECH_DIMS = ["variety", "precision", "clarity", "structure", "active", "fluency"] as const;

/** How each raw metric value is rendered. One deterministic rule per metric key,
 *  so a value never guesses its own unit:
 *    num1    — one decimal, no unit          (mtld 82.4, rhythmSd 6.8, avgSentence 11.2)
 *    int     — integer, thousands-grouped    (distinctWords 2.140, connBuckets 4, p90Sentence 24)
 *    lixInt  — integer, no grouping          (lix 42)
 *    per1000 — one decimal + "/ 1000 W."     (all *Rate metrics: 1.9 / 1000 W.)
 *    pct     — value×100 + " %"              (all *Share + hapaxRate: 0.42 → 42 %)
 *    ratio2  — two decimals, no unit         (connDensity 0.31, wpmCv 0.22) */
const METRIC_FMT: Record<string, "num1" | "int" | "lixInt" | "per1000" | "pct" | "ratio2"> = {
  mtld: "num1",
  eleganceRate: "per1000",
  distinctWords: "int",
  hapaxRate: "pct",
  weakRate: "per1000",
  vagueRate: "per1000",
  hedgeRate: "per1000",
  lix: "lixInt",
  nestedShare: "pct",
  avgSentence: "num1",
  p90Sentence: "int",
  connDensity: "ratio2",
  connBuckets: "int",
  passiveShare: "pct",
  nominalRate: "per1000",
  fillerRate: "per1000",
  wpmCv: "ratio2",
  rhythmSd: "num1",
};

/** A small circled "i" that reveals a one-line explanation. Same interaction
 *  grammar as the coach's alt-chip (#140): hover shows it, a click pins it open
 *  for keyboard + touch. The bubble anchors to the dot's left edge and extends
 *  rightward (CSS), which stays on-screen for every dot in this section. */
function InfoDot({ tip }: { tip: string }) {
  const [pinned, setPinned] = useState(false);
  return (
    <button
      type="button"
      className={`speech-info${pinned ? " pinned" : ""}`}
      data-tip={tip}
      aria-label={tip}
      aria-expanded={pinned}
      onClick={(e) => {
        e.stopPropagation();
        setPinned((p) => !p);
      }}
      onBlur={() => setPinned(false)}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M12 11v5" strokeLinecap="round" />
        <circle cx="12" cy="7.6" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}

/** Severity glyph for an insight: 1 = praise (check), 2 = neutral hint (info),
 *  3 = clear flag (alert triangle). All stroke-SVG, inherit currentColor. */
function SeverityIcon({ severity }: { severity: 1 | 2 | 3 }) {
  if (severity === 1)
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  if (severity === 3)
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
    );
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

/** Up/down chevron for the overall-vs-ghost delta. */
function DeltaArrow({ up }: { up: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {up ? <path d="m6 15 6-6 6 6" /> : <path d="m6 9 6 6 6-6" />}
    </svg>
  );
}

/** One dimension: score + a slim level bar, the trend sparkline of this
 *  dimension's daily score, and every sub-metric as a labelled row with its own
 *  info tooltip. */
function DimensionCard({
  dim,
  trend,
}: {
  dim: SpeechDimension;
  /** Daily scores for THIS dimension (ascending), feeding the sparkline. */
  trend: number[];
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || "en";
  const nf = (v: number, dec: number) =>
    v.toLocaleString(lang, { minimumFractionDigits: dec, maximumFractionDigits: dec });

  const fmt = (m: { key: string; value: number }): string => {
    const kind = METRIC_FMT[m.key] ?? "num1";
    switch (kind) {
      case "per1000":
        return `${nf(m.value, 1)} ${t("learning.speech.unitPer1000")}`;
      case "pct":
        return `${nf(m.value * 100, 0)} %`;
      case "int":
        return nf(m.value, 0);
      case "lixInt":
        return Math.round(m.value).toString();
      case "ratio2":
        return nf(m.value, 2);
      default:
        return nf(m.value, 1);
    }
  };

  return (
    <div className="speech-dim-card">
      <div className="speech-dim-head">
        <span className="speech-dim-title">
          {t(`learning.speech.dim.${dim.key}.name`)}
          <InfoDot tip={t(`learning.speech.dim.${dim.key}.info`)} />
        </span>
        <span className="speech-dim-score">{Math.round(dim.score)}</span>
      </div>
      <div className="speech-score-bar" aria-hidden="true">
        <span className="speech-score-fill" style={{ width: `${Math.max(0, Math.min(100, dim.score))}%` }} />
      </div>
      <div className="speech-dim-spark">
        <Sparkline values={trend} height={26} />
      </div>
      <div className="speech-metrics">
        {dim.metrics.map((m) => (
          <div key={m.key} className="speech-metric-row">
            <span className="speech-metric-label">
              {t(`learning.speech.metric.${m.key}.name`)}
              <InfoDot tip={t(`learning.speech.metric.${m.key}.info`)} />
            </span>
            <span className="speech-metric-val">{fmt(m)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One recommendation card — severity-tinted icon, the finding, the concrete
 *  tip. Both texts come from i18n by insight id, with {{delta}} interpolated as
 *  a rounded percent (direction is already baked into each id's wording). */
function InsightCard({ insight }: { insight: SpeechInsight }) {
  const { t } = useTranslation();
  const delta = Math.round(Math.abs(insight.delta) * 100);
  return (
    <div className={`speech-insight sev-${insight.severity}`}>
      <span className="speech-insight-icon" aria-hidden="true">
        <SeverityIcon severity={insight.severity} />
      </span>
      <div className="speech-insight-body">
        <div className="speech-insight-finding">
          {t(`learning.speech.insights.${insight.id}.finding`, { delta })}
        </div>
        <div className="speech-insight-tip">
          {t(`learning.speech.insights.${insight.id}.tip`, { delta })}
        </div>
      </div>
    </div>
  );
}

/** The Sprechprofil tab: hero radar + big rhetoric score, the six dimension
 *  cards, and up to four insight recommendations. Refreshes on every dictation
 *  (onHistoryChanged) and on the 7/30/90 range switch. 100 % local. */
function SpeechProfileTab() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || "en";
  const [days, setDays] = useState<number>(30);
  const [profile, setProfile] = useState<SpeechProfile | null>(null);
  const [trend, setTrend] = useState<SpeechTrend | null>(null);

  const refresh = useCallback((d: number) => {
    speechProfile(d).then(setProfile).catch(() => {});
    speechProfileTrend(d).then(setTrend).catch(() => {});
  }, []);
  useEffect(() => refresh(days), [days, refresh]);
  useEffect(() => {
    const un = onHistoryChanged(() => refresh(days));
    return () => {
      un.then((f) => f());
    };
  }, [days, refresh]);

  const rangeSwitcher = (
    <div className="sub-tabs speech-range">
      {RANGES.map((d) => (
        <button key={d} className={`sub-tab ${days === d ? "active" : ""}`} onClick={() => setDays(d)}>
          {t(`activity.range${d}`)}
        </button>
      ))}
    </div>
  );

  // First load — nothing to show yet.
  if (profile === null) {
    return (
      <div>
        {rangeSwitcher}
        <div className="empty" aria-busy="true">
          {t("learning.speech.loading")}
        </div>
      </div>
    );
  }

  // Too little material for meaningful scores → the friendly hint, not a broken
  // radar of zeros.
  if (!profile.enough_data) {
    return (
      <div>
        {rangeSwitcher}
        <div className="speech-empty">
          <div className="speech-empty-title">{t("learning.speech.emptyTitle")}</div>
          <p className="speech-empty-hint">{t("learning.speech.emptyHint", { count: profile.total_words })}</p>
        </div>
      </div>
    );
  }

  // Radar axes — kept in the canonical dimension order so the shape is stable.
  const byKey = new Map(profile.dimensions.map((d) => [d.key, d]));
  const orderedDims = SPEECH_DIMS.map((k) => byKey.get(k)).filter((d): d is SpeechDimension => !!d);
  const axes: RadarAxis[] = orderedDims.map((d) => ({
    key: d.key,
    label: t(`learning.speech.dim.${d.key}.name`),
    score: d.score,
  }));
  const ghostScores = profile.ghost?.scores ?? null;

  // Per-dimension daily trend for the sparklines.
  const dimTrend = (key: string): number[] =>
    (trend?.days ?? []).map((d) => d.scores[key]).filter((v) => Number.isFinite(v));

  const ghostDelta = profile.ghost ? Math.round(profile.overall - profile.ghost.overall) : null;
  const insights = profile.insights.slice(0, 4);

  return (
    <div>
      {rangeSwitcher}

      {/* Hero — radar left, big rhetoric score + ghost delta right. */}
      <div className="chart-card speech-hero">
        <div className="speech-hero-radar">
          <RadarChart axes={axes} ghost={ghostScores} />
        </div>
        <div className="speech-hero-side">
          <div className="speech-hero-label">{t("learning.speech.overallLabel")}</div>
          <div className="speech-hero-score">{Math.round(profile.overall)}</div>
          <div className="speech-hero-of">{t("learning.speech.scoreOf100")}</div>
          {ghostDelta !== null && ghostDelta !== 0 ? (
            <div className={`speech-delta ${ghostDelta > 0 ? "up" : "down"}`}>
              <DeltaArrow up={ghostDelta > 0} />
              <span className="speech-delta-num">
                {ghostDelta > 0 ? "+" : "−"}
                {Math.abs(ghostDelta)}
              </span>
              <span className="speech-delta-label">{t("learning.speech.vsGhost")}</span>
            </div>
          ) : (
            <div className="speech-delta neutral">{t("learning.speech.noGhost")}</div>
          )}
          <div className="speech-hero-words">
            {t("learning.speech.wordsAnalysed", { count: profile.total_words.toLocaleString(lang) })}
          </div>
        </div>
      </div>

      {/* The six dimensions. */}
      <div className="chart-head" style={{ marginBottom: 12, marginTop: 20 }}>
        <div>
          <div className="chart-title">{t("learning.speech.dimTitle")}</div>
          <div className="chart-sub">{t("learning.speech.dimSub")}</div>
        </div>
      </div>
      <div className="speech-dim-grid">
        {orderedDims.map((d) => (
          <DimensionCard key={d.key} dim={d} trend={dimTrend(d.key)} />
        ))}
      </div>

      {/* Recommendations. */}
      {insights.length > 0 && (
        <>
          <div className="chart-head" style={{ marginBottom: 12, marginTop: 20 }}>
            <div>
              <div className="chart-title">{t("learning.speech.insightsTitle")}</div>
              <div className="chart-sub">{t("learning.speech.insightsSub")}</div>
            </div>
          </div>
          <div className="speech-insights">
            {insights.map((ins) => (
              <InsightCard key={ins.id} insight={ins} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  Rhetorik-Dojo (Welle 4) — one spoken micro-workout a day. Today's exercise
//  → a countdown recording → an instant scored verdict with XP. The recorder
//  mirrors the Notes RecordModal state-machine (starting/recording/transcribing)
//  with the VoiceprintPanel auto-stop at the time budget, and the same unmount
//  safety-net that cancels a stranded take.
// ════════════════════════════════════════════════════════════════════════

/** Kind → its badge accent class (all three route through tokens that tokens.css
 *  already greys for the black theme, so no zero-hue override is needed). */
const DOJO_KIND_CLASS: Record<DojoKind, string> = {
  gauntlet: "dojo-kind--gauntlet",
  tabu: "dojo-kind--tabu",
  better: "dojo-kind--better",
  golf: "dojo-kind--golf",
};

/** Score → tier (colour class + qualitative label). ≥80 good (emerald), ≥50 mid
 *  (cyan), else low (dimmed). The colour tokens are greyed for the black theme. */
function dojoTier(score: number): { cls: "good" | "mid" | "low"; label: string } {
  if (score >= 80) return { cls: "good", label: "scoreGreat" };
  if (score >= 50) return { cls: "mid", label: "scoreMid" };
  return { cls: "low", label: "scoreLow" };
}

/** The big task line, rendered by kind: gauntlet → the topic; tabu → the term
 *  plus the red-bordered taboo chips; better → the weak sentence as a quote. */
function DojoTask({ today }: { today: DojoToday }) {
  const { t } = useTranslation();
  if (today.kind === "tabu") {
    return (
      <div className="dojo-task">
        <div className="dojo-term">{today.term}</div>
        {today.taboo && today.taboo.length > 0 && (
          <>
            <div className="dojo-taboo-caption">{t("learning.dojo.tabooLabel")}</div>
            <div className="dojo-taboo-chips">
              {today.taboo.map((w) => (
                <span key={w} className="dojo-taboo-chip">
                  {w}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }
  if (today.kind === "better") {
    return (
      <div className="dojo-task">
        <div className="dojo-taboo-caption">{t("learning.dojo.weakLabel")}</div>
        <p className="dojo-weak-quote">{today.weak_sentence}</p>
      </div>
    );
  }
  return (
    <div className="dojo-task">
      <div className="dojo-topic">{today.topic}</div>
    </div>
  );
}

/** The exercise-of-the-day card: typ badge, the big task, the one-line rule, the
 *  seconds + XP badges, and the start CTA. done_today adds a check + the "no
 *  further XP" hint but still lets you practice again. */
function DojoExerciseCard({ today, onStart }: { today: DojoToday; onStart: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="dojo-card">
      <div className="dojo-card-head">
        <span className="dojo-eyebrow">{t("learning.dojo.todayEyebrow")}</span>
        <span className={`dojo-badge ${DOJO_KIND_CLASS[today.kind]}`}>
          {t(`learning.dojo.kind.${today.kind}.name`)}
        </span>
      </div>

      <DojoTask today={today} />

      <div className="dojo-rule">{t(`learning.dojo.kind.${today.kind}.rule`)}</div>

      <div className="dojo-card-foot">
        <span className="dojo-meta-badge">
          {t("learning.dojo.secondsBadge", { seconds: today.seconds })}
        </span>
        <span className="dojo-xp-badge">{t("learning.dojo.xpBadge", { xp: today.xp })}</span>
        {today.done_today && (
          <span className="dojo-done-badge">
            <CheckIcon />
            {t("learning.dojo.doneToday")}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="dojo-start-btn" onClick={onStart}>
          {today.done_today ? t("learning.dojo.retryBtn") : t("learning.dojo.startBtn")}
        </button>
      </div>

      {today.done_today && <p className="dojo-done-hint">{t("learning.dojo.doneTodayHint")}</p>}
    </div>
  );
}

/** The recording overlay: a big countdown (auto-stops at 0 → score), the pulsing
 *  level orb (scales with the mic level), the taboo words kept in view for a tabu
 *  drill, and a cancel button. The unmount safety-net cancels a still-running
 *  take so the mic + session guard are released, never stranded. */
function DojoRecordModal({
  today,
  onCancel,
  onResult,
  toastErr,
}: {
  today: DojoToday;
  onCancel: () => void;
  onResult: (r: DojoResult) => void;
  toastErr: (m: string) => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"starting" | "recording" | "transcribing" | "error">("starting");
  const [level, setLevel] = useState(0);
  const [remaining, setRemaining] = useState(today.seconds);
  const started = useRef(false);
  const stopping = useRef(false);
  const done = useRef(false); // recorder was cleanly stopped or cancelled
  const deadline = useRef<number | null>(null); // fixed auto-stop instant (ms)

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    dojoRecordStart()
      .then(() => setPhase("recording"))
      .catch((e) => {
        done.current = true;
        setPhase("error");
        const busy = String(e).includes("busy");
        toastErr(
          busy
            ? t("learning.dojo.busyError")
            : t("learning.dojo.recordFailed") + " (" + String(e) + ")",
        );
        onCancel();
      });
  }, [t, toastErr, onCancel]);

  // Safety net: cancel if this modal is torn down while still recording (e.g. a
  // sidebar switch mid-take). No-op once stop/cancel already ran.
  useEffect(() => () => {
    if (!done.current) dojoRecordCancel().catch(() => {});
  }, []);

  const stop = useCallback(async () => {
    if (stopping.current) return;
    stopping.current = true;
    done.current = true; // we own the recorder teardown now
    setPhase("transcribing");
    try {
      const r = await dojoRecordStop();
      onResult(r);
    } catch (e) {
      toastErr(t("learning.dojo.transcribeFailed") + " (" + String(e) + ")");
      onCancel();
    }
  }, [onResult, onCancel, toastErr, t]);

  const cancel = useCallback(async () => {
    done.current = true;
    await dojoRecordCancel().catch(() => {});
    onCancel();
  }, [onCancel]);

  // Level poll (~80 ms) + a countdown against a fixed deadline; at 0 the take
  // auto-stops (VoiceprintPanel MAX_S pattern). The deadline lives in a ref set
  // once, so a stray re-render can never reset the clock mid-take.
  useEffect(() => {
    if (phase !== "recording") {
      deadline.current = null;
      return;
    }
    if (deadline.current === null) deadline.current = Date.now() + today.seconds * 1000;
    const lv = window.setInterval(() => {
      dojoRecordLevel().then(setLevel).catch(() => {});
    }, 80);
    const tm = window.setInterval(() => {
      const left = Math.ceil((deadline.current! - Date.now()) / 1000);
      setRemaining(Math.max(0, left));
      if (left <= 0) void stop();
    }, 250);
    return () => {
      window.clearInterval(lv);
      window.clearInterval(tm);
    };
  }, [phase, today.seconds, stop]);

  const scale = 1 + Math.min(level, 1) * 0.5;
  const showTaboo = today.kind === "tabu" && !!today.taboo && today.taboo.length > 0;

  return (
    <div className="modal-backdrop" onClick={phase === "recording" ? undefined : cancel}>
      <div className="modal-card dojo-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="confirm-title">{t("learning.dojo.recording.title")}</h3>

        <div className="dojo-rec-stage">
          <div className="dojo-rec-orb" style={{ transform: `scale(${scale})` }} />
          {phase === "transcribing" ? (
            <div className="dojo-rec-status">{t("learning.dojo.recording.transcribing")}</div>
          ) : phase === "starting" ? (
            <div className="dojo-rec-status">{t("learning.dojo.recording.starting")}</div>
          ) : (
            <div className="dojo-rec-count">{remaining}</div>
          )}
        </div>

        {showTaboo && phase !== "transcribing" && (
          <div className="dojo-rec-taboo">
            <span className="dojo-taboo-caption">{t("learning.dojo.recording.tabooReminder")}</span>
            <div className="dojo-taboo-chips">
              {today.taboo!.map((w) => (
                <span key={w} className="dojo-taboo-chip">
                  {w}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="confirm-actions">
          <button className="confirm-btn" onClick={cancel} disabled={phase === "transcribing"}>
            {t("common.cancel")}
          </button>
          <button
            className="confirm-btn primary"
            onClick={stop}
            disabled={phase !== "recording"}
          >
            {t("learning.dojo.recording.stopBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The verdict: the big score (colour by tier), the kind-specific breakdown, the
 *  XP line (+15 or "already rewarded"), the expandable transcript, and a
 *  practice-again button. */
function DojoResultModal({
  today,
  result,
  onClose,
  onAgain,
}: {
  today: DojoToday;
  result: DojoResult;
  onClose: () => void;
  onAgain: () => void;
}) {
  const { t } = useTranslation();
  const [showTranscript, setShowTranscript] = useState(false);
  const tier = dojoTier(result.score);
  const b = result.breakdown;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card dojo-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="confirm-title">{t("learning.dojo.result.title")}</h3>

        <div className="dojo-score-stage">
          <HankoSeal score={result.score} size={112} />
          <div className="dojo-score-of">{t("learning.dojo.result.scoreOf100")}</div>
          <div className={`dojo-score-tier dojo-score--${tier.cls}`}>
            {t(`learning.dojo.result.${tier.label}`)}
          </div>
        </div>

        <div className="dojo-breakdown">
          {today.kind === "gauntlet" && (
            <div className="dojo-bd-row">
              <span className="dojo-bd-label">{t("learning.dojo.result.fillers")}</span>
              <span className="dojo-bd-val">{b.fillers}</span>
            </div>
          )}
          {today.kind === "tabu" && (
            <div className="dojo-bd-block">
              <span className="dojo-bd-label">{t("learning.dojo.result.violations")}</span>
              {b.violations.length > 0 ? (
                <div className="dojo-taboo-chips">
                  {b.violations.map((w, i) => (
                    <span key={`${w}-${i}`} className="dojo-taboo-chip">
                      {w}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="dojo-clean-chip">
                  <CheckIcon />
                  {t("learning.dojo.result.violationsNone")}
                </span>
              )}
            </div>
          )}
          {today.kind === "better" && (
            <div className="dojo-bd-stats">
              <div className="dojo-bd-stat">
                <span className="dojo-bd-num">{b.weak}</span>
                <span className="dojo-bd-cap">{t("learning.dojo.result.weak")}</span>
              </div>
              <div className="dojo-bd-stat">
                <span className="dojo-bd-num">{b.vague}</span>
                <span className="dojo-bd-cap">{t("learning.dojo.result.vague")}</span>
              </div>
              <div className="dojo-bd-stat">
                <span className="dojo-bd-num">{b.elevated}</span>
                <span className="dojo-bd-cap">{t("learning.dojo.result.elevated")}</span>
              </div>
            </div>
          )}

          {/* Prompt-Golf — the five rubric criteria as ✓ / ○ rows. */}
          {today.kind === "golf" && b.rubric && (
            <div className="dojo-bd-block">
              <span className="dojo-bd-label">{t("learning.dojo.result.rubricTitle")}</span>
              <div className="dojo-rubric-checks">
                {PROMPT_RUBRIC_KEYS.map((k) => {
                  const ok = !!b.rubric?.[k];
                  return (
                    <div key={k} className={`dojo-rubric-check ${ok ? "on" : "off"}`}>
                      <span className="dojo-rubric-mark" aria-hidden="true">
                        {ok ? <CheckIcon /> : <CircleOutlineIcon />}
                      </span>
                      <span className="dojo-rubric-name">
                        {t(`learning.prompts.rubric.${k}.name`)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="dojo-bd-row">
            <span className="dojo-bd-label">{t("learning.dojo.result.words")}</span>
            <span className="dojo-bd-val">{b.words}</span>
          </div>

          {b.too_short && (
            <div className="dojo-too-short">
              <SeverityIcon severity={3} />
              {t("learning.dojo.result.tooShort")}
            </div>
          )}
        </div>

        <div className={`dojo-xp-line ${result.xp_awarded > 0 ? "earned" : "already"}`}>
          {result.xp_awarded > 0
            ? t("learning.dojo.result.xpAwarded", { xp: result.xp_awarded })
            : t("learning.dojo.result.xpAlready")}
        </div>

        <button
          type="button"
          className="dojo-transcript-toggle"
          aria-expanded={showTranscript}
          onClick={() => setShowTranscript((v) => !v)}
        >
          {showTranscript
            ? t("learning.dojo.result.transcriptHide")
            : t("learning.dojo.result.transcriptShow")}
        </button>
        {showTranscript && <p className="dojo-transcript">{result.transcript.trim() || "—"}</p>}

        <div className="confirm-actions">
          <button className="confirm-btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="confirm-btn primary" onClick={onAgain}>
            {t("learning.dojo.retryBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Canonical quest order (server order is not relied upon). */
const DOJO_QUEST_ORDER: Quest["id"][] = ["workouts_3", "coach_5", "find_1"];

/** "Deine Wochen-Quests": three rows, each a name + description + progress bar,
 *  a check once complete. */
function DojoQuestsCard({ quests }: { quests: Quest[] }) {
  const { t } = useTranslation();
  if (quests.length === 0) return null;
  const byId = new Map(quests.map((q) => [q.id, q]));
  const ordered = DOJO_QUEST_ORDER.map((id) => byId.get(id)).filter((q): q is Quest => !!q);
  return (
    <div className="chart-card dojo-quests">
      <div className="chart-head">
        <div>
          <div className="chart-title">{t("learning.dojo.quests.title")}</div>
          <div className="chart-sub">{t("learning.dojo.quests.sub")}</div>
        </div>
      </div>
      <div className="dojo-quest-list">
        {ordered.map((q) => {
          const pct = q.target > 0 ? Math.min(100, Math.round((q.progress / q.target) * 100)) : 0;
          const complete = q.progress >= q.target;
          return (
            <div key={q.id} className={`dojo-quest${complete ? " is-done" : ""}`}>
              <div className="dojo-quest-top">
                <span className="dojo-quest-name">{t(`learning.dojo.quests.${q.id}.name`)}</span>
                {complete ? (
                  <span className="dojo-quest-check">
                    <CheckIcon />
                    {t("learning.dojo.quests.done")}
                  </span>
                ) : (
                  <span className="dojo-quest-prog">
                    {t("learning.dojo.quests.progress", { progress: q.progress, target: q.target })}
                  </span>
                )}
              </div>
              <div className="dojo-quest-desc">{t(`learning.dojo.quests.${q.id}.desc`)}</div>
              <div className="xp-bar">
                <div className="xp-bar-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The Dojo tab: today's exercise + the weekly quests, plus the record → result
 *  modal flow. Refreshes today (done_today) + quests on a reward and on history. */
function DojoTab() {
  const { t } = useTranslation();
  const toast = useToast();
  const [today, setToday] = useState<DojoToday | null>(null);
  const [quests, setQuests] = useState<Quest[]>([]);
  const [belt, setBelt] = useState<Belt | null>(null);
  const [recording, setRecording] = useState(false);
  const [result, setResult] = useState<DojoResult | null>(null);

  const loadToday = useCallback(() => {
    dojoToday().then(setToday).catch(() => {});
  }, []);
  const loadQuests = useCallback(() => {
    questsGet()
      .then((q) => setQuests(q.quests))
      .catch(() => {});
  }, []);
  // The belt (Obi) is shared across both halls; the rhetoric hall's training
  // days feed it, so refresh it on every reward too.
  const loadBelt = useCallback(() => {
    kataList().then((d) => setBelt(d.belt)).catch(() => {});
  }, []);

  useEffect(() => {
    loadToday();
    loadQuests();
    loadBelt();
    const un = onLearningReward(() => {
      loadToday();
      loadQuests();
      loadBelt();
    });
    const unh = onHistoryChanged(loadQuests);
    return () => {
      un.then((f) => f());
      unh.then((f) => f());
    };
  }, [loadToday, loadQuests, loadBelt]);

  if (today === null) {
    return (
      <div>
        <DojoStage variant="rhetoric" belt={belt} />
        <div className="empty" aria-busy="true">
          {t("learning.dojo.loading")}
        </div>
      </div>
    );
  }

  return (
    <div>
      <DojoStage variant="rhetoric" belt={belt} />
      <DojoExerciseCard today={today} onStart={() => setRecording(true)} />
      <DojoQuestsCard quests={quests} />

      {recording && (
        <DojoRecordModal
          today={today}
          onCancel={() => setRecording(false)}
          onResult={(r) => {
            setRecording(false);
            setResult(r);
            loadToday();
            loadQuests();
          }}
          toastErr={(m) => toast(m, "error")}
        />
      )}
      {result && (
        <DojoResultModal
          today={today}
          result={result}
          onClose={() => setResult(null)}
          onAgain={() => {
            setResult(null);
            setRecording(true);
          }}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
//  Prompt-Coach (Welle 5) — Echo scores dictations aimed at AI tools against a
//  5-criterion rubric and teaches better prompting: an overall score + trend, a
//  rubric breakdown with a "lever" for each weak spot, a daily pattern to
//  practise (word-of-the-day grammar), the tools you prompt, and recent prompts.
// ════════════════════════════════════════════════════════════════════════

/** Score → tier class. Mirrors dojoTier's thresholds (≥80 good, ≥50 mid, else
 *  low) so a prompt score reads the same everywhere. The three colour tokens
 *  (--emerald / --cyan-ink / --ink3) are all greyed for the black theme. */
function promptTier(score: number): "good" | "mid" | "low" {
  return score >= 80 ? "good" : score >= 50 ? "mid" : "low";
}

/** A small colour-coded score pill (≥80 / ≥50 / <50), used in by-app + recent. */
function PromptScoreChip({ score }: { score: number }) {
  return (
    <span className={`prompts-score-chip prompts-score-chip--${promptTier(score)}`}>
      {Math.round(score)}
    </span>
  );
}

/** Locale-correct "x ago" for an epoch-seconds timestamp; unit auto-picked so a
 *  prompt from minutes ago and one from days ago both read naturally. */
function relFromNow(ts: number, lang: string): string {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const diff = Math.round((ts * 1000 - Date.now()) / 1000); // negative = past
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

/** Below this satisfaction rate a rubric criterion surfaces its "lever" — the
 *  one concrete tip for lifting it. */
const RUBRIC_LEVER_THRESHOLD = 0.4;

/** The daily prompt pattern — the WordOfDayCard grammar reused verbatim: name +
 *  explanation + a concrete example, a +XP challenge badge, and the done state. */
function PatternOfDayCard({ pattern }: { pattern: PromptPatternToday }) {
  const { t } = useTranslation();
  const base = `learning.prompts.patterns.${pattern.id}`;
  return (
    <div className="wod-card prompts-pattern">
      <div className="wod-head">
        <span className="wod-eyebrow">{t("learning.prompts.pattern.eyebrow")}</span>
        {pattern.done_today ? (
          <span className="dojo-done-badge">
            <CheckIcon />
            {t("learning.prompts.pattern.doneBadge", { xp: pattern.xp })}
          </span>
        ) : (
          <span className="wod-challenge-badge">
            {t("learning.prompts.pattern.challenge", { xp: pattern.xp })}
          </span>
        )}
      </div>
      <div className="wod-word">{t(`${base}.name`)}</div>
      <div className="wod-meaning">{t(`${base}.desc`)}</div>
      <div className="wod-synonyms-label">{t("learning.prompts.pattern.exampleLabel")}</div>
      <div className="wod-example">{t(`${base}.example`)}</div>
    </div>
  );
}

/** The Prompts tab: hero score + trend, the rubric breakdown, the pattern of the
 *  day, the tools you prompt and recent prompts. 100 % local; refreshes on every
 *  dictation (a new prompt may land) and on the 7/30/90 range switch. */
function PromptsTab() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || "en";
  const toast = useToast();
  const [days, setDays] = useState<number>(30);
  const [stats, setStats] = useState<PromptCoachStats | null>(null);
  const [pattern, setPattern] = useState<PromptPatternToday | null>(null);
  const [kata, setKata] = useState<KataList | null>(null);
  const [beltUp, setBeltUp] = useState<BeltRank | null>(null);

  const refresh = useCallback((d: number) => {
    promptCoachStats(d).then(setStats).catch(() => {});
  }, []);
  useEffect(() => refresh(days), [days, refresh]);
  useEffect(() => {
    const un = onHistoryChanged(() => refresh(days));
    const unr = onLearningReward(() => refresh(days));
    return () => {
      un.then((f) => f());
      unr.then((f) => f());
    };
  }, [days, refresh]);

  // The pattern of the day is range-independent; it flips to done the moment a
  // real prompt applies it (learning-reward), exactly like the word of the day.
  useEffect(() => {
    const load = () => promptPatternToday().then(setPattern).catch(() => {});
    load();
    const un = onLearningReward(load);
    return () => {
      un.then((f) => f());
    };
  }, []);

  // The kata path + belt. A take can flip a station's state or promote the belt,
  // so reload the whole list after every take (onKataResult) and on any reward.
  const loadKata = useCallback(() => {
    kataList().then(setKata).catch(() => {});
  }, []);
  useEffect(() => {
    loadKata();
    const un = onLearningReward(loadKata);
    return () => {
      un.then((f) => f());
    };
  }, [loadKata]);
  const onKataResult = useCallback(
    (r: KataResult) => {
      loadKata();
      if (r.belt_up) {
        setBeltUp(r.belt_up as BeltRank);
        // Let the stage's Obi play its promotion sweep, then clear the flag.
        window.setTimeout(() => setBeltUp(null), 4000);
      }
    },
    [loadKata],
  );

  // The stage + kata path crown the hall in every state (loading / empty / full).
  const dojoHeader = (
    <>
      <DojoStage variant="prompt" belt={kata?.belt ?? null} beltUp={beltUp} />
      {kata && (
        <KataPath data={kata} onResult={onKataResult} toastErr={(m) => toast(m, "error")} />
      )}
      <BrushDivider label={t("learning.prompts.statsDivider")} />
    </>
  );

  const rangeSwitcher = (
    <div className="sub-tabs speech-range">
      {RANGES.map((d) => (
        <button key={d} className={`sub-tab ${days === d ? "active" : ""}`} onClick={() => setDays(d)}>
          {t(`activity.range${d}`)}
        </button>
      ))}
    </div>
  );

  if (stats === null) {
    return (
      <div>
        {dojoHeader}
        {rangeSwitcher}
        <div className="empty" aria-busy="true">
          {t("learning.prompts.loading")}
        </div>
      </div>
    );
  }

  // Empty state — the pattern still shows (useful before any prompt lands), but
  // the stats give way to the "how it works" hint.
  if (!stats.enough) {
    return (
      <div>
        {dojoHeader}
        {rangeSwitcher}
        {pattern && <PatternOfDayCard pattern={pattern} />}
        <div className="prompts-empty">
          <div className="prompts-empty-title">{t("learning.prompts.empty.title")}</div>
          <p className="prompts-empty-hint">{t("learning.prompts.empty.hint")}</p>
        </div>
      </div>
    );
  }

  const trend = stats.trend.map((d) => d.avg);

  return (
    <div>
      {dojoHeader}
      {rangeSwitcher}

      {/* Hero — big average score + prompt count, trend sparkline. */}
      <div className="chart-card prompts-hero">
        <div className="prompts-hero-side">
          <div className="prompts-hero-label">{t("learning.prompts.hero.label")}</div>
          <div className="prompts-hero-score">{Math.round(stats.avg_score)}</div>
          <div className="prompts-hero-of">{t("learning.prompts.hero.of100")}</div>
          <div className="prompts-hero-count">
            {t("learning.prompts.hero.count", { count: stats.prompts })}
          </div>
        </div>
        <div className="prompts-hero-spark">
          <Sparkline values={trend} height={54} />
        </div>
      </div>

      <BrushDivider />

      {/* Rubric — the five criteria, each a rate bar + a lever for the weak ones. */}
      <div className="chart-card">
        <div className="chart-head">
          <div>
            <div className="chart-title">{t("learning.prompts.rubric.title")}</div>
            <div className="chart-sub">{t("learning.prompts.rubric.sub")}</div>
          </div>
        </div>
        <div className="prompts-rubric-list">
          {PROMPT_RUBRIC_KEYS.map((k) => {
            const rate = stats.rubric_rates[k] ?? 0;
            const weak = rate < RUBRIC_LEVER_THRESHOLD;
            const pct = Math.round(rate * 100);
            return (
              <div key={k} className="prompts-rubric-row">
                <div className="prompts-rubric-main">
                  <span className="prompts-rubric-name">
                    {t(`learning.prompts.rubric.${k}.name`)}
                    <InfoDot tip={t(`learning.prompts.rubric.${k}.desc`)} />
                  </span>
                  <span className="prompts-rubric-track" aria-hidden="true">
                    <span
                      className={`prompts-rubric-fill${weak ? " weak" : ""}`}
                      style={{ width: `${Math.max(2, pct)}%` }}
                    />
                  </span>
                  <span className="prompts-rubric-pct">{pct}%</span>
                </div>
                {weak && (
                  <p className="prompts-rubric-lever">{t(`learning.prompts.rubric.${k}.lever`)}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Pattern of the day. */}
      {pattern && <PatternOfDayCard pattern={pattern} />}

      {/* Which tools you prompt — top apps, full names, count + mean score. */}
      {stats.by_app.length > 0 && (
        <div className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">{t("learning.prompts.byApp.title")}</div>
              <div className="chart-sub">{t("learning.prompts.byApp.sub")}</div>
            </div>
          </div>
          <div className="prompts-app-list">
            {stats.by_app.map((a) => (
              <div key={a.app} className="prompts-app-row">
                <span className="prompts-app-name">{a.app}</span>
                <span className="prompts-app-n">
                  {t("learning.prompts.byApp.count", { count: a.n })}
                </span>
                <PromptScoreChip score={a.avg} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent prompts — time, tool, score chip, dimmed head (ellipsis-capped). */}
      {stats.recent.length > 0 && (
        <div className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">{t("learning.prompts.recent.title")}</div>
              <div className="chart-sub">{t("learning.prompts.recent.sub")}</div>
            </div>
          </div>
          <div className="prompts-recent-list">
            {stats.recent.map((r, i) => (
              <div key={`${r.ts}-${i}`} className="prompts-recent-row">
                <span className="prompts-recent-time">{relFromNow(r.ts, lang)}</span>
                <span className="prompts-recent-app">{r.app}</span>
                <PromptScoreChip score={r.score} />
                <span className="prompts-recent-head">{r.head}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Learning() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<
    "coach" | "dex" | "speech" | "dojo" | "prompts" | "achievements"
  >("coach");
  const [wortdex, setWortdex] = useState<WortdexData | null>(null);

  // The collection is loaded once at section level (so the Wortdex tab count
  // badge is live before the tab is opened) and refreshed whenever a dictation
  // lands a new word.
  useEffect(() => {
    const load = () => wortdexList().then(setWortdex).catch(() => {});
    load();
    const un1 = onWordFind(load);
    const un2 = onHistoryChanged(load);
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
    };
  }, []);

  const dexTotal = wortdex
    ? wortdex.counts.notable + wortdex.counts.rare + wortdex.counts.legendary
    : 0;

  return (
    <div>
      <h1 className="section-title">{t("learning.title")}</h1>
      <p className="section-sub">{t("learning.subtitle")}</p>

      <div className="sub-tabs sub-tabs--primary" style={{ marginBottom: 18 }}>
        <button
          className={`sub-tab ${tab === "coach" ? "active" : ""}`}
          onClick={() => setTab("coach")}
        >
          {t("learning.tabCoach")}
        </button>
        <button
          className={`sub-tab ${tab === "dex" ? "active" : ""}`}
          onClick={() => setTab("dex")}
        >
          {t("learning.tabDex")}
          {dexTotal > 0 && (
            <span className="tier-badge" style={{ marginLeft: 8 }}>
              {dexTotal}
            </span>
          )}
        </button>
        <button
          className={`sub-tab ${tab === "speech" ? "active" : ""}`}
          onClick={() => setTab("speech")}
        >
          {t("learning.speech.tab")}
        </button>
        <button
          className={`sub-tab ${tab === "dojo" ? "active" : ""}`}
          onClick={() => setTab("dojo")}
        >
          {t("learning.dojo.tab")}
        </button>
        <button
          className={`sub-tab ${tab === "prompts" ? "active" : ""}`}
          onClick={() => setTab("prompts")}
        >
          {t("learning.prompts.tab")}
        </button>
        <button
          className={`sub-tab ${tab === "achievements" ? "active" : ""}`}
          onClick={() => setTab("achievements")}
        >
          {t("learning.tabAchievements")}
        </button>
      </div>

      {tab === "coach" && <CoachTab onNavigate={setTab} />}
      {tab === "dex" && <WortdexTab data={wortdex} />}
      {tab === "speech" && <SpeechProfileTab />}
      {tab === "dojo" && <DojoTab />}
      {tab === "prompts" && <PromptsTab />}
      {tab === "achievements" && <AchievementsTab />}
    </div>
  );
}
