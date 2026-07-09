import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AreaChart, type XYDatum } from "../components/charts/AreaChart";
import { BarChart } from "../components/charts/BarChart";
import { EchoWrapped } from "../components/charts/EchoWrapped";
import { HourlyChart } from "../components/charts/HourlyChart";
import { ProgressRing } from "../components/charts/ProgressRing";
import { WordCloud } from "../components/charts/WordCloud";
import { SPARKLES_PATHS, STAR4_PATHS, StrokeIcon } from "../components/icons";
import { exportCsv, exportJson } from "../lib/exportActivity";
import { computeInsights } from "../lib/insights";
import {
  activityDaily,
  activityHourly,
  activityOverview,
  activityWordFrequency,
  goalsSet,
  learningAnalysis,
  onHistoryChanged,
  type ActivityDay,
  type ActivityHour,
  type ActivityOverview,
  type LearningAnalysis,
  type WordFreq,
} from "../lib/ipc";
import { useToast } from "../state/ToastContext";

// ---- Range switcher -------------------------------------------------------
// "Alles" has no real upper bound in the backend query language ("-N days"),
// so it simply asks for a decade — daily_stats is never pruned (blueprint §2b)
// but Echo hasn't existed that long, making this a safe "everything" window.
const ALL_DAYS = 3650;

type RangeKey = "7" | "30" | "90" | "all";
const RANGES: { key: RangeKey; days: number; labelKey: string }[] = [
  { key: "7", days: 7, labelKey: "activity.range7" },
  { key: "30", days: 30, labelKey: "activity.range30" },
  { key: "90", days: 90, labelKey: "activity.range90" },
  { key: "all", days: ALL_DAYS, labelKey: "activity.rangeAll" },
];

// Top words stay pinned to the recent window (last 30 days, blueprint §6) —
// deliberately NOT coupled to the range switcher, which drives daily/hourly.
const WORD_FREQ_DAYS = 30;
const WORD_FREQ_LIMIT = 40;
const TOP_WORD_BARS = 12;

// ---- Local-date helpers (same convention as lib/insights.ts) --------------
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Add (possibly negative) calendar days to a "YYYY-MM-DD" string via local
 *  Date components — stays correct across DST jumps. Malformed input is
 *  returned unchanged (callers guard against that with loop counters). */
function addDays(day: string, delta: number): string {
  const parts = day.split("-").map(Number);
  const [y, m, d] = parts;
  if (!y || !m || !d || parts.length !== 3) return day;
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** Short localized "day.month" tick label for chart x-axes. */
function fmtDayShort(day: string, lang: string): string {
  const parts = day.split("-").map(Number);
  const [y, m, d] = parts;
  if (!y || !m || !d || parts.length !== 3) return day;
  return new Date(y, m - 1, d).toLocaleDateString(lang, { day: "numeric", month: "numeric" });
}

/** Continuous words-per-day series for the AreaChart: the backend returns a
 *  SPARSE list (only active days, blueprint §3), so missing calendar days are
 *  filled with 0 to keep the x-axis continuous. For "Alles" the axis starts
 *  at the earliest recorded day instead of a decade of empty buckets. */
function fillDailyWords(daily: ActivityDay[], days: number, all: boolean): XYDatum[] {
  const today = todayStr();
  const start = all
    ? daily.length > 0 && daily[0].day <= today
      ? daily[0].day
      : today
    : addDays(today, -(days - 1));
  const byDay = new Map<string, number>();
  for (const row of daily) {
    if (row && typeof row.day === "string") byDay.set(row.day, row.words ?? 0);
  }
  const out: XYDatum[] = [];
  // Hard cap keeps a malformed `start` (addDays passthrough) from looping forever.
  let day = start;
  for (let guard = 0; day <= today && guard < ALL_DAYS + 1; guard++) {
    out.push({ x: day, y: byDay.get(day) ?? 0 });
    const next = addDays(day, 1);
    if (next === day) break;
    day = next;
  }
  return out;
}

/** Compact human duration for the "time saved" card — same recipe as Home.tsx
 *  (min under an hour, else one-decimal hours; reuses home.unit* keys). */
function fmtSaved(seconds: number): { value: string; unitKey: string } {
  if (seconds < 3600) return { value: String(Math.round(seconds / 60)), unitKey: "home.unitMin" };
  return { value: (seconds / 3600).toFixed(1), unitKey: "home.unitHour" };
}

// ---- Small stroke icons local to this section (no emojis — enterprise UI) --
const GEAR_PATHS = [
  "M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z",
  "M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6",
];
const DOWNLOAD_PATHS = ["M12 4v11", "m7.5 11 4.5 4.5L16.5 11", "M4.5 20h15"];

export function Activity() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || "en";
  const toast = useToast();

  const [range, setRange] = useState<RangeKey>("30");
  const [overview, setOverview] = useState<ActivityOverview | null>(null);
  const [daily, setDaily] = useState<ActivityDay[]>([]);
  const [hourly, setHourly] = useState<ActivityHour[]>([]);
  const [words, setWords] = useState<WordFreq[]>([]);
  const [analysis, setAnalysis] = useState<LearningAnalysis | null>(null);

  const [showWrapped, setShowWrapped] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Inline goal editor (opens under the rings when a gear is clicked)
  const [editingGoals, setEditingGoals] = useState(false);
  const [goalDailyInput, setGoalDailyInput] = useState("");
  const [goalWeeklyInput, setGoalWeeklyInput] = useState("");

  const rangeDays = RANGES.find((r) => r.key === range)?.days ?? 30;

  // Activity data lives in the SQLite store — fetch on mount + range change,
  // refresh live when a dictation lands (echo://history-changed), same
  // pattern as Home/History.
  const refresh = useCallback(() => {
    activityOverview().then(setOverview).catch(() => {});
    activityDaily(rangeDays).then(setDaily).catch(() => setDaily([]));
    activityHourly(rangeDays).then(setHourly).catch(() => setHourly([]));
    activityWordFrequency(WORD_FREQ_LIMIT, WORD_FREQ_DAYS)
      .then(setWords)
      .catch(() => setWords([]));
    learningAnalysis(WORD_FREQ_DAYS).then(setAnalysis).catch(() => {});
  }, [rangeDays]);
  useEffect(() => refresh(), [refresh]);
  useEffect(() => {
    const un = onHistoryChanged(refresh);
    return () => {
      un.then((f) => f());
    };
  }, [refresh]);

  // ---- Derived series ------------------------------------------------------
  const dailyWords = useMemo(
    () => fillDailyWords(daily, rangeDays, range === "all"),
    [daily, rangeDays, range],
  );

  // WPM per day (§12a): words / (audio_seconds / 60). Days WITHOUT audio are
  // SKIPPED, not drawn as 0 — a zero would distort the pace trend.
  const wpmSeries = useMemo<XYDatum[]>(
    () =>
      daily
        .filter((d) => d && d.audio_seconds > 0)
        .map((d) => ({ x: d.day, y: Math.round(d.words / (d.audio_seconds / 60)) })),
    [daily],
  );

  const hourlyData = useMemo(
    () => hourly.map((h) => ({ hour: h.hour, value: h.transcriptions })),
    [hourly],
  );

  const barData = useMemo(
    () => words.slice(0, TOP_WORD_BARS).map((w) => ({ label: w.word, value: w.count })),
    [words],
  );

  const insights = useMemo(
    () => computeInsights(t, overview, daily, hourly, analysis),
    [t, overview, daily, hourly, analysis],
  );

  // Range-scoped totals: the stat row follows the range switcher (summed from
  // the already-fetched daily buckets). "Alles" uses the lifetime account
  // totals instead — they reach further back than daily_stats, which was
  // backfilled only from the retained history window.
  const rangeTotals = useMemo(() => {
    if (range === "all") return null;
    let words = 0;
    let transcriptions = 0;
    let audio_seconds = 0;
    let time_saved_seconds = 0;
    for (const d of daily) {
      words += d.words;
      transcriptions += d.transcriptions;
      audio_seconds += d.audio_seconds;
      time_saved_seconds += d.time_saved_seconds;
    }
    return { words, transcriptions, audio_seconds, time_saved_seconds };
  }, [daily, range]);

  if (!overview) return null;

  const cardTotals = rangeTotals ?? overview.total;
  const saved = fmtSaved(cardTotals.time_saved_seconds);
  // Ø speaking pace (§12a): words / audio minutes in the window, guarded — "–"
  // instead of a division by zero when nothing has been dictated yet.
  const avgWpm =
    cardTotals.audio_seconds > 0
      ? Math.round(cardTotals.words / (cardTotals.audio_seconds / 60))
      : null;

  const dailyGoal = overview.goals.daily_word_goal;
  const weeklyGoal = overview.goals.weekly_word_goal;
  const todayWords = overview.today.words;
  const weekWords = overview.this_week.words;
  const dailyPct = dailyGoal > 0 ? Math.round((todayWords / dailyGoal) * 100) : 0;
  const weeklyPct = weeklyGoal > 0 ? Math.round((weekWords / weeklyGoal) * 100) : 0;

  const hasAny =
    overview.total.transcriptions > 0 ||
    daily.length > 0 ||
    hourly.some((h) => h.transcriptions > 0);

  const openGoalEditor = () => {
    setGoalDailyInput(String(dailyGoal));
    setGoalWeeklyInput(String(weeklyGoal));
    setEditingGoals(true);
  };
  const saveGoals = async () => {
    const d = Number.parseInt(goalDailyInput, 10);
    const w = Number.parseInt(goalWeeklyInput, 10);
    if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(w) || w <= 0) return;
    try {
      await goalsSet({ daily_word_goal: d, weekly_word_goal: w });
      setEditingGoals(false);
      refresh();
    } catch {
      // keep the editor open so the input isn't lost; nothing was persisted
    }
  };

  const onExport = async (kind: "csv" | "json") => {
    if (exporting) return;
    setExporting(true);
    try {
      if (kind === "csv") {
        await exportCsv(daily);
      } else {
        await exportJson({ overview, daily, hourly, words });
      }
      toast(t("activity.exportDone"), "success");
    } catch {
      toast(t("activity.wrappedSaveError"), "error");
    } finally {
      setExporting(false);
    }
  };

  const gearButton = (
    <button
      className="ring-edit"
      onClick={() => (editingGoals ? setEditingGoals(false) : openGoalEditor())}
      title={t("activity.goalEdit")}
      aria-label={t("activity.goalEdit")}
    >
      <StrokeIcon paths={GEAR_PATHS} size={14} strokeWidth={1.8} />
    </button>
  );

  return (
    <div>
      <h1 className="section-title">{t("activity.title")}</h1>
      <p className="section-sub">{t("activity.subtitle")}</p>

      <div className="sub-tabs" style={{ marginBottom: 16 }}>
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={`sub-tab ${range === r.key ? "active" : ""}`}
            onClick={() => setRange(r.key)}
          >
            {t(r.labelKey)}
          </button>
        ))}
      </div>

      {!hasAny ? (
        <div className="empty">{t("activity.empty")}</div>
      ) : (
        <>
          {/* Header stat cards — 5 tiles (§6 + the §12a WPM tile) */}
          <div
            className="stat-grid"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}
          >
            <div className="card stat-card">
              <div className="label">{t("activity.statWords")}</div>
              <div className="value">{cardTotals.words.toLocaleString(lang)}</div>
            </div>
            <div className="card stat-card">
              <div className="label">{t("activity.statTranscriptions")}</div>
              <div className="value">{cardTotals.transcriptions.toLocaleString(lang)}</div>
            </div>
            <div className="card stat-card">
              <div className="label">{t("activity.statTimeSaved")}</div>
              <div className="value">
                {saved.value}
                <span style={{ fontSize: 13, opacity: 0.6 }}> {t(saved.unitKey)}</span>
              </div>
            </div>
            <div className="card stat-card">
              <div className="label">{t("activity.statStreak")}</div>
              <div
                className="value"
                title={t("activity.streakDays", { count: overview.streak.current })}
              >
                {overview.streak.current.toLocaleString(lang)}
              </div>
            </div>
            <div className="card stat-card">
              <div className="label">{t("activity.statWpm")}</div>
              <div className="value">
                {avgWpm != null ? (
                  <>
                    {avgWpm.toLocaleString(lang)}
                    <span style={{ fontSize: 13, opacity: 0.6 }}> {t("activity.wpmUnit")}</span>
                  </>
                ) : (
                  "–"
                )}
              </div>
            </div>
          </div>

          {/* Goal rings — today vs. daily goal, week vs. weekly goal */}
          <div className="ring-group">
            <div className="ring-card" data-done={dailyGoal > 0 && todayWords >= dailyGoal}>
              <div className="ring-card-head">
                <span className="ring-label">{t("activity.goalDaily")}</span>
                {gearButton}
              </div>
              <div className="ring-figure">
                <ProgressRing value={todayWords} max={dailyGoal} size={110}>
                  <div className="ring-value">
                    {todayWords.toLocaleString(lang)}
                    <small>/ {dailyGoal.toLocaleString(lang)}</small>
                  </div>
                </ProgressRing>
              </div>
              <div className="ring-caption">{dailyPct}%</div>
            </div>

            <div className="ring-card" data-done={weeklyGoal > 0 && weekWords >= weeklyGoal}>
              <div className="ring-card-head">
                <span className="ring-label">{t("activity.goalWeekly")}</span>
                {gearButton}
              </div>
              <div className="ring-figure">
                <ProgressRing value={weekWords} max={weeklyGoal} size={110}>
                  <div className="ring-value">
                    {weekWords.toLocaleString(lang)}
                    <small>/ {weeklyGoal.toLocaleString(lang)}</small>
                  </div>
                </ProgressRing>
              </div>
              <div className="ring-caption">{weeklyPct}%</div>
            </div>

            {editingGoals && (
              <div className="ring-editor">
                <div className="ring-editor-field">
                  <label htmlFor="goal-daily">{t("activity.goalDaily")}</label>
                  <input
                    id="goal-daily"
                    type="number"
                    min={1}
                    value={goalDailyInput}
                    onChange={(e) => setGoalDailyInput(e.target.value)}
                  />
                </div>
                <div className="ring-editor-field">
                  <label htmlFor="goal-weekly">{t("activity.goalWeekly")}</label>
                  <input
                    id="goal-weekly"
                    type="number"
                    min={1}
                    value={goalWeeklyInput}
                    onChange={(e) => setGoalWeeklyInput(e.target.value)}
                  />
                </div>
                <div className="ring-editor-actions">
                  <button className="sub-tab" onClick={() => setEditingGoals(false)}>
                    {t("common.cancel")}
                  </button>
                  <button className="sub-tab active" onClick={saveGoals}>
                    {t("activity.goalSave")}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Daily trend — continuous x-axis (gaps 0-filled) + optional goal line */}
          <div className="chart-card">
            <div className="chart-head">
              <div>
                <h3 className="chart-title">{t("activity.dailyTrend")}</h3>
                <p className="chart-sub">{t("activity.statWords")}</p>
              </div>
              {dailyGoal > 0 && (
                <div className="chart-legend">
                  <span className="chart-legend-item">
                    <span className="legend-dot" />
                    {t("activity.statWords")}
                  </span>
                  <span className="chart-legend-item">
                    <span className="legend-dot goal" />
                    {t("activity.goalDaily")}
                  </span>
                </div>
              )}
            </div>
            <AreaChart
              data={dailyWords}
              height={200}
              formatX={(x) => fmtDayShort(x, lang)}
              formatY={(y) => Math.round(y).toLocaleString(lang)}
              goal={dailyGoal > 0 ? dailyGoal : undefined}
            />
          </div>

          {/* WPM trend (§12a) — days without audio are skipped, never drawn as 0 */}
          {wpmSeries.length >= 2 && (
            <div className="chart-card">
              <div className="chart-head">
                <div>
                  <h3 className="chart-title">{t("activity.wpmTrend")}</h3>
                  <p className="chart-sub">{t("activity.wpmUnit")}</p>
                </div>
              </div>
              <AreaChart
                data={wpmSeries}
                height={180}
                formatX={(x) => fmtDayShort(x, lang)}
                formatY={(y) => `${Math.round(y).toLocaleString(lang)} ${t("activity.wpmUnit")}`}
              />
            </div>
          )}

          {/* Hour-of-day distribution */}
          <div className="chart-card">
            <div className="chart-head">
              <div>
                <h3 className="chart-title">{t("activity.hourlyTitle")}</h3>
                <p className="chart-sub">{t("activity.hourlySub")}</p>
              </div>
            </div>
            <div className="chart-wrap">
              <HourlyChart data={hourlyData} height={160} />
            </div>
          </div>

          {/* Top words — weighted cloud + ranked horizontal bars (last 30 days) */}
          <div className="chart-card">
            <div className="chart-head">
              <div>
                <h3 className="chart-title">{t("activity.topWords")}</h3>
              </div>
            </div>
            {words.length === 0 ? (
              <div className="empty">{t("activity.wordCloudEmpty")}</div>
            ) : (
              <div className="chart-grid-2">
                <WordCloud words={words} max={WORD_FREQ_LIMIT} />
                <div className="chart-wrap">
                  <BarChart
                    data={barData}
                    horizontal
                    maxBars={TOP_WORD_BARS}
                    formatValue={(n) => n.toLocaleString(lang)}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Insight cards — pure TS one-liners from computeInsights() */}
          {insights.length > 0 && (
            <>
              <h2 style={{ fontSize: 15, fontWeight: 700, margin: "6px 0 12px" }}>
                {t("activity.insightsTitle")}
              </h2>
              <div className="insight-card">
                {insights.map((text, i) => (
                  <div key={i} className="insight-row">
                    <span className="insight-icon">
                      <StrokeIcon paths={SPARKLES_PATHS} size={15} strokeWidth={1.8} />
                    </span>
                    <span className="insight-text">{text}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Actions — Echo Wrapped + CSV/JSON export */}
          <div className="act-row">
            <button className="act-btn primary" onClick={() => setShowWrapped(true)}>
              <StrokeIcon paths={STAR4_PATHS} size={14} strokeWidth={1.8} />
              {t("activity.wrappedCta")}
            </button>
            <button className="act-btn" disabled={exporting} onClick={() => onExport("csv")}>
              <StrokeIcon paths={DOWNLOAD_PATHS} size={14} strokeWidth={1.8} />
              {t("activity.exportCsv")}
            </button>
            <button className="act-btn" disabled={exporting} onClick={() => onExport("json")}>
              <StrokeIcon paths={DOWNLOAD_PATHS} size={14} strokeWidth={1.8} />
              {t("activity.exportJson")}
            </button>
          </div>
        </>
      )}

      {showWrapped && (
        <EchoWrapped overview={overview} topWords={words} onClose={() => setShowWrapped(false)} />
      )}
    </div>
  );
}
