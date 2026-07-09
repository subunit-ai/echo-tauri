import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  learningAnalysis,
  learningLeaderboard,
  learningSuggestions,
  learningXp,
  onHistoryChanged,
  onLearningReward,
  wordOfDay,
  type Leaderboard,
  type LearningAnalysis,
  type LearningSuggestions,
  type LearningXp,
  type WordFreq,
  type WordOfDay,
} from "../lib/ipc";
import { BarChart } from "../components/charts/BarChart";
import { WordCloud } from "../components/charts/WordCloud";
import { useConfig } from "../state/ConfigContext";
import { useToast } from "../state/ToastContext";

/** Range presets steering the analysis window (days). Labels reuse the
 *  shared activity.range* keys so both sections speak the same language. */
const RANGES = [7, 30, 90] as const;

/** Below this many analysed words the per-card insights are statistically
 *  meaningless — cards fall back to the needMoreData hint instead. */
const MIN_WORDS = 30;

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

const PlusIcon = () => (
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
    <path d="M12 5v14M5 12h14" />
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

/** Highest defined level title — levels above it reuse the top title. */
const MAX_LEVEL_TITLE = 9;

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

export function Learning() {
  const { config, patch } = useConfig();
  const toast = useToast();
  const { t, i18n } = useTranslation();

  const [wod, setWod] = useState<WordOfDay | null>(null);
  const [xp, setXp] = useState<LearningXp | null>(null);
  const [lb, setLb] = useState<Leaderboard | null>(null);
  const [days, setDays] = useState<number>(30);
  const [analysis, setAnalysis] = useState<LearningAnalysis | null>(null);
  const [suggestions, setSuggestions] = useState<LearningSuggestions | null>(null);
  // Words added to the vocabulary in this session — marks the chip "added"
  // immediately, even before the config round-trip lands.
  const [added, setAdded] = useState<Set<string>>(new Set());

  // Word of the day + XP state: range-independent, but BOTH change the moment
  // a dictation uses a taught word — refresh on the reward event (and on
  // history-changed, which fires for every dictation anyway).
  useEffect(() => {
    const refreshGamification = () => {
      wordOfDay().then(setWod).catch(() => {});
      learningXp().then(setXp).catch(() => {});
    };
    refreshGamification();
    const un = onLearningReward(refreshGamification);
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Leaderboard: one round-trip on mount (pushes the own score first). NOT
  // re-fetched per dictation — the server is not a realtime scoreboard.
  useEffect(() => {
    learningLeaderboard().then(setLb).catch(() => setLb(null));
  }, []);

  // Analysis + suggestions follow the range switcher; both are 100% local
  // IPC (never network), so firing them together is cheap. Live-refresh when
  // a dictation lands, same pattern as History.
  const refresh = useCallback((d: number) => {
    learningAnalysis(d).then(setAnalysis).catch(() => {});
    learningSuggestions(d).then(setSuggestions).catch(() => {});
  }, []);
  useEffect(() => refresh(days), [days, refresh]);
  useEffect(() => {
    const un = onHistoryChanged(() => refresh(days));
    return () => {
      un.then((f) => f());
    };
  }, [days, refresh]);

  const inVocab = useCallback(
    (word: string) => {
      const canon = word.trim().toLowerCase();
      return (
        added.has(canon) ||
        (config?.vocabulary ?? []).some((e) => e.write_as.trim().toLowerCase() === canon)
      );
    },
    [added, config],
  );

  // §5 mechanism, verbatim: reuse the Dictionary persist path via patch().
  // ONLY distinctive/rare words land here — synonym upgrades stay advisory
  // (a VocabEntry would let apply_vocab_replace rewrite every occurrence).
  const addToVocabulary = (word: string) => {
    if (!config) return;
    const canon = word.trim().toLowerCase();
    if (!canon || config.vocabulary.some((e) => e.write_as.trim().toLowerCase() === canon)) return; // dedupe
    patch({
      vocabulary: [
        ...config.vocabulary,
        { sounds_like: word, write_as: word, aliases: [], category: "Other" },
      ],
    })
      .then(() => {
        setAdded((prev) => new Set(prev).add(canon));
        toast(t("learning.addedToVocab"), "success");
      })
      .catch(() => {});
  };

  // Distinctive/rare words: recurring content words that are NOT weak, filler,
  // overused or upgrade candidates — the user's own names/jargon Echo should
  // learn to spell (§5's non-destructive integration). Rarest first.
  const distinctive = useMemo<WordFreq[]>(() => {
    if (!analysis) return [];
    const excluded = new Set<string>();
    for (const f of analysis.filler_counts) excluded.add(f.word.toLowerCase());
    for (const w of analysis.weak_words) excluded.add(w.word.toLowerCase());
    for (const o of analysis.overused_words) excluded.add(o.word.toLowerCase());
    for (const s of suggestions?.suggestions ?? []) excluded.add(s.word.toLowerCase());
    return analysis.top_words
      .filter((w) => w.word.length >= 5 && w.count >= 2 && !excluded.has(w.word.toLowerCase()))
      .sort((a, b) => a.count - b.count || b.word.length - a.word.length)
      .slice(0, 12);
  }, [analysis, suggestions]);

  if (!config) return null;

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

  const fillerTotal = analysis
    ? analysis.filler_counts.reduce((sum, f) => sum + f.count, 0)
    : 0;
  const fillerRate =
    analysis && analysis.total_words > 0 ? (fillerTotal / analysis.total_words) * 100 : 0;

  const sourceBadge = suggestions && (
    <span className={`upgrade-source source-${suggestions.source}`}>
      {t(suggestions.source === "llm" ? "learning.sourceLlm" : "learning.sourceLocal")}
    </span>
  );

  return (
    <div>
      <h1 className="section-title">{t("learning.title")}</h1>
      <p className="section-sub">{t("learning.subtitle")}</p>

      {xp && <XpCard xp={xp} />}
      {wod && <WordOfDayCard wod={wod} />}

      {((xp?.events.length ?? 0) > 0 || (lb?.available && (lb.week?.length ?? 0) > 0)) && (
        <div className="chart-grid-2" style={{ marginBottom: 16 }}>
          {/* Achievements feed — the last rewarded words */}
          {xp && xp.events.length > 0 && (
            <div className="card" style={{ marginBottom: 0 }}>
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
                      {t(e.kind === "word_of_day" ? "learning.kindWod" : "learning.kindCoach")}
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

          {/* Community leaderboard — most vocabulary XP this week */}
          {lb?.available && (lb.week?.length ?? 0) > 0 && (
            <div className="card" style={{ marginBottom: 0 }}>
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
                    <span className="xp-feed-word">
                      {row.me ? t("learning.lbYou", { name: row.name }) : row.name}
                    </span>
                    <span className="xp-feed-kind">
                      {t("learning.lbWords", { count: row.words })}
                    </span>
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
          <div className="chart-grid-2">
            {/* Vocabulary richness */}
            <div className="card" style={{ marginBottom: 0 }}>
              <div className="chart-head">
                <div>
                  <div className="chart-title">{t("learning.vocabRichness")}</div>
                  <div className="chart-sub">
                    {t("learning.subtitle")}
                  </div>
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

            {/* Filler words */}
            <div className="chart-card" style={{ marginBottom: 0 }}>
              <div className="chart-head">
                <div>
                  <div className="chart-title">{t("learning.fillerTitle")}</div>
                  <div className="chart-sub">{t("learning.fillerSub")}</div>
                </div>
                {analysis.filler_counts.length > 0 && (
                  <span className="filler-rate">
                    {t("learning.fillerRate")} {fillerRate.toFixed(1)}%
                  </span>
                )}
              </div>
              {analysis.filler_counts.length > 0 ? (
                <div className="chart-wrap">
                  <BarChart
                    data={analysis.filler_counts.map((f) => ({ label: f.word, value: f.count }))}
                    horizontal
                    maxBars={8}
                  />
                </div>
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

          {/* Most used words — prominent, with the distinctive-word →
              vocabulary hand-off (§5). */}
          <div className="chart-card">
            <div className="chart-head">
              <div>
                <div className="chart-title">{t("learning.topWordsTitle")}</div>
                <div className="chart-sub">{t("learning.topWordsSub")}</div>
              </div>
            </div>
            {analysis.top_words.length > 0 ? (
              <WordCloud words={analysis.top_words} max={40} />
            ) : (
              <div className="empty">{t("learning.needMoreData")}</div>
            )}
            {distinctive.length > 0 && (
              <>
                <div className="wod-synonyms-label" style={{ marginTop: 16 }}>
                  {t("learning.distinctiveTitle")}
                </div>
                <p className="chart-sub" style={{ margin: "4px 0 10px" }}>
                  {t("learning.distinctiveSub")}
                </p>
                <div className="chip-row">
                  {distinctive.map((w) => {
                    const isIn = inVocab(w.word);
                    return (
                      <span key={w.word} className="filler-chip">
                        {w.word}
                        <span className="count">{w.count}×</span>
                        <button
                          className={`upgrade-add${isIn ? " added" : ""}`}
                          disabled={isIn}
                          onClick={() => addToVocabulary(w.word)}
                          title={t(isIn ? "learning.addedToVocab" : "learning.addToVocab")}
                        >
                          {isIn ? <CheckIcon /> : <PlusIcon />}
                          {t(isIn ? "learning.addedToVocab" : "learning.addToVocab")}
                        </button>
                      </span>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Upgrade coach — advisory only, never writes to the vocabulary
              (a synonym VocabEntry would destructively rewrite transcripts). */}
          <div className="chart-card">
            <div className="chart-head">
              <div>
                <div className="chart-title">{t("learning.upgradeTitle")}</div>
                <div className="chart-sub">{t("learning.upgradeSub")}</div>
              </div>
              {sourceBadge}
            </div>
            {suggestions && suggestions.suggestions.length > 0 ? (
              <div className="upgrade-list">
                {suggestions.suggestions.map((s) => (
                  <div key={s.word} className="upgrade-row">
                    <span className="upgrade-word">{s.word}</span>
                    <span className="upgrade-count">{s.count}×</span>
                    <ArrowIcon />
                    <div className="upgrade-alts">
                      {s.alternatives.map((a) => (
                        <span key={a.word} className="alt-item">
                          <span className="alt-chip">{a.word}</span>
                          {a.note && <span className="alt-note">{a.note}</span>}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">{t("learning.needMoreData")}</div>
            )}
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
                  <span
                    key={o.word}
                    className="warn-chip"
                    title={`×${o.ratio.toFixed(1)}`}
                  >
                    {o.word}
                    <span className="count">{o.count}×</span>
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
