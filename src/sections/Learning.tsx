import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  achievementsList,
  fillerRemovedCounts,
  learningAnalysis,
  learningLeaderboard,
  learningSuggestions,
  learningSuggestionsLlm,
  learningXp,
  onHistoryChanged,
  onLearningReward,
  onWordFind,
  wordOfDay,
  wortdexList,
  type Achievement,
  type Band,
  type Leaderboard,
  type LearningAnalysis,
  type LearningSuggestions,
  type LearningXp,
  type WordFind,
  type WordFreq,
  type WordOfDay,
  type WortdexData,
} from "../lib/ipc";
import { Avatar } from "../components/Avatar";
import { TierRing } from "../components/TierRing";
import { levelForXp } from "../lib/level";
import { useConfig } from "../state/ConfigContext";

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

/** The Coach tab: the whole existing learning surface, unchanged apart from the
 *  leaderboard rows now carrying a level-ring avatar + worn title, the XP feed
 *  learning the new "word_find" kind, and the gamification header refreshing on
 *  a word-find too. */
function CoachTab() {
  const { t, i18n } = useTranslation();

  const [wod, setWod] = useState<WordOfDay | null>(null);
  const [xp, setXp] = useState<LearningXp | null>(null);
  const [lb, setLb] = useState<Leaderboard | null>(null);
  const [days, setDays] = useState<number>(30);
  const [analysis, setAnalysis] = useState<LearningAnalysis | null>(null);
  const [suggestions, setSuggestions] = useState<LearningSuggestions | null>(null);
  const [refining, setRefining] = useState(false);
  // Fillers Echo actually stripped. Their own counter, because by the time a
  // transcript reaches the history they are *gone* from it — counting the
  // history could never surface them.
  const [stripped, setStripped] = useState<WordFreq[]>([]);

  // Word of the day + XP state: range-independent, but BOTH change the moment
  // a dictation uses a taught word OR lands a new collectible word — refresh on
  // both the reward event and the word-find event (and on history-changed).
  useEffect(() => {
    const refreshGamification = () => {
      wordOfDay().then(setWod).catch(() => {});
      learningXp().then(setXp).catch(() => {});
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
      {xp && <XpCard xp={xp} />}
      {wod && <WordOfDayCard wod={wod} />}

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
                  {t(
                    e.kind === "word_of_day"
                      ? "learning.kindWod"
                      : e.kind === "coach_word"
                        ? "learning.kindCoach"
                        : "learning.kindFind",
                  )}
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

      {/* Leaderboard — likewise its own box, so names and scores fit. */}
      {lb?.available && (lb.week?.length ?? 0) > 0 && (
        <div className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">{t("learning.lbTitle")}</div>
              <div className="chart-sub">{t("learning.lbSub")}</div>
            </div>
          </div>
          <div className="xp-feed">
            {(lb.week ?? []).slice(0, 5).map((row) => (
              <div key={row.rank} className={`xp-feed-row${row.me ? " me" : ""}`}>
                <span className="lb-rank">{row.rank}</span>
                {/* Level ring only materialises when the server sends xp_total
                    and it clears level 3 — old servers → bare avatar. */}
                <TierRing level={levelForXp(row.xp_total ?? 0)} size={22}>
                  <Avatar name={row.name} size={22} />
                </TierRing>
                <span className="xp-feed-word">
                  {row.me ? t("learning.lbYou", { name: row.name }) : row.name}
                </span>
                {row.title && (
                  <span className="lb-title">{t(`learning.titles.${row.title}`)}</span>
                )}
                <span className="xp-feed-kind">{t("learning.lbWords", { count: row.words })}</span>
                <span className="xp-feed-xp">{row.xp.toLocaleString(i18n.language)} XP</span>
              </div>
            ))}
            {lb.me?.rank_week != null && !(lb.week ?? []).slice(0, 5).some((r) => r.me) && (
              <div className="xp-feed-row me">
                <span className="lb-rank">{lb.me.rank_week}</span>
                <span className="xp-feed-word">{t("learning.lbYou", { name: "" })}</span>
                <span className="xp-feed-xp">
                  {(xp?.xp_week ?? 0).toLocaleString(i18n.language)} XP
                </span>
              </div>
            )}
          </div>
        </div>
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

export function Learning() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"coach" | "dex" | "achievements">("coach");
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
          className={`sub-tab ${tab === "achievements" ? "active" : ""}`}
          onClick={() => setTab("achievements")}
        >
          {t("learning.tabAchievements")}
        </button>
      </div>

      {tab === "coach" && <CoachTab />}
      {tab === "dex" && <WortdexTab data={wortdex} />}
      {tab === "achievements" && <AchievementsTab />}
    </div>
  );
}
