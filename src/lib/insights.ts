// Pure, side-effect-free helpers that turn already-fetched activity/learning
// data into short, human "insight" sentences for the `.insight-card` list in
// `sections/Activity.tsx` (see blueprint §6). Everything here is computed in
// TS from data the caller already has — NO IPC, NO network. Deliberately
// defensive: with missing/short/empty data it simply omits an insight rather
// than guessing, and never throws (any unexpected shape falls back to []).
import type { ActivityDay, ActivityHour, ActivityOverview, LearningAnalysis } from "./ipc";

/**
 * Minimal shape of i18next's `t` — deliberately loose (not the full
 * namespace-generic `TFunction`) so this pure helper doesn't have to pull in
 * i18next's resource-typing generics. Any `t` from `useTranslation()` (see
 * `sections/Home.tsx` etc.) satisfies this. Callers pass `activity.*` keys;
 * a German `defaultValue` is always supplied so the sentence renders even if
 * a given locale hasn't added that key yet.
 */
export type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

// Minimum sample sizes before an insight is considered meaningful — below
// these, the underlying stat is too noisy (or divides by ~0) to be worth a
// sentence.
const MIN_HOURLY_SAMPLE = 5; // total transcriptions across the hourly window
const MIN_WORDS_FOR_TTR = 40; // type/token ratio is noisy on tiny samples
const MIN_STREAK_DAYS = 2; // a single active day isn't a "streak" yet

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Add (possibly negative) calendar days to a "YYYY-MM-DD" string. Uses local
 *  Date components (not UTC/ms math) so it stays correct across DST jumps. */
function addDays(day: string, delta: number): string {
  const parts = day.split("-").map(Number);
  const [y, m, d] = parts;
  if (!y || !m || !d || parts.length !== 3) return day;
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function sumWordsInRange(daily: ActivityDay[], startDay: string, endDay: string): number {
  let total = 0;
  for (const row of daily) {
    if (row && typeof row.day === "string" && row.day >= startDay && row.day <= endDay) {
      total += row.words ?? 0;
    }
  }
  return total;
}

function interpolate(text: string, vars?: Record<string, unknown>): string {
  if (!vars) return text;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

/** Translate with a safety net: always returns a real sentence, even if `t`
 *  is missing/throws/returns empty — never the raw i18n key. */
function safeT(t: TranslateFn, key: string, fallback: string, vars?: Record<string, unknown>): string {
  if (typeof t !== "function") return interpolate(fallback, vars);
  try {
    const out = t(key, { ...vars, defaultValue: fallback });
    return typeof out === "string" && out.length > 0 ? out : interpolate(fallback, vars);
  } catch {
    return interpolate(fallback, vars);
  }
}

/**
 * Data-driven, one-sentence insight cards for the Activity dashboard.
 * Order: produktivste Stunde → Wochendelta Wörter → heutige Zielerreichung →
 * Streak-Lob → Wortschatz-Vielfalt. Any block whose data is missing, empty,
 * or too small to be meaningful is silently skipped — the result can be a
 * short list, or even empty, but is never wrong and never throws.
 */
export function computeInsights(
  t: TranslateFn,
  overview: ActivityOverview | null | undefined,
  daily: ActivityDay[] | null | undefined,
  hourly: ActivityHour[] | null | undefined,
  analysis: LearningAnalysis | null | undefined,
): string[] {
  const insights: string[] = [];

  try {
    const dailyRows = Array.isArray(daily) ? daily : [];
    const hourlyRows = Array.isArray(hourly) ? hourly : [];

    // 1) Produktivste Stunde (aus hourly)
    try {
      const totalHourly = hourlyRows.reduce((sum, h) => sum + (h?.transcriptions ?? 0), 0);
      if (totalHourly >= MIN_HOURLY_SAMPLE) {
        let best: ActivityHour | null = null;
        for (const h of hourlyRows) {
          if (h && (!best || h.transcriptions > best.transcriptions)) best = h;
        }
        if (best && best.transcriptions > 0) {
          insights.push(
            safeT(
              t,
              "activity.insightProductiveHour",
              "Deine produktivste Stunde ist {{hour}} Uhr.",
              { hour: best.hour },
            ),
          );
        }
      }
    } catch {
      // skip this insight, never crash the whole list
    }

    // 2) Wochendelta Wörter (aus daily: diese vs. letzte Kalenderwoche)
    try {
      if (dailyRows.length > 0) {
        const today = todayStr();
        const thisWeekStart = addDays(today, -6);
        const lastWeekEnd = addDays(today, -7);
        const lastWeekStart = addDays(today, -13);
        const thisWeekWords = sumWordsInRange(dailyRows, thisWeekStart, today);
        const lastWeekWords = sumWordsInRange(dailyRows, lastWeekStart, lastWeekEnd);
        if (lastWeekWords > 0) {
          const pct = Math.round(((thisWeekWords - lastWeekWords) / lastWeekWords) * 100);
          if (Number.isFinite(pct) && pct !== 0) {
            const delta = `${pct > 0 ? "+" : ""}${pct}%`;
            insights.push(
              safeT(
                t,
                "activity.insightWeekDelta",
                "{{delta}} Wörter im Vergleich zur letzten Woche.",
                { delta },
              ),
            );
          }
        }
      }
    } catch {
      // skip
    }

    // 3) Heutige Zielerreichung
    try {
      const goal = overview?.goals?.daily_word_goal ?? 0;
      const todayWords = overview?.today?.words ?? 0;
      if (goal > 0 && todayWords > 0) {
        const pct = Math.round((todayWords / goal) * 100);
        if (pct >= 100) {
          insights.push(
            safeT(t, "activity.insightGoalReached", "Tagesziel bereits erreicht ({{pct}}%).", { pct }),
          );
        } else {
          insights.push(
            safeT(t, "activity.insightGoalProgress", "Ziel heute zu {{pct}}% erreicht.", { pct }),
          );
        }
      }
    } catch {
      // skip
    }

    // 4) Streak-Lob
    try {
      const current = overview?.streak?.current ?? 0;
      const longest = overview?.streak?.longest ?? 0;
      if (current >= MIN_STREAK_DAYS && current === longest) {
        insights.push(
          safeT(
            t,
            "activity.insightStreakRecord",
            "Neuer persönlicher Bestwert: {{days}} Tage in Folge diktiert!",
            { days: current },
          ),
        );
      } else if (current >= MIN_STREAK_DAYS) {
        insights.push(
          safeT(t, "activity.insightStreak", "{{days}} Tage in Folge diktiert – weiter so!", {
            days: current,
          }),
        );
      }
    } catch {
      // skip
    }

    // 5) Wortschatz-Vielfalt (type_token_ratio aus analysis)
    try {
      if (analysis && analysis.total_words >= MIN_WORDS_FOR_TTR) {
        const pct = Math.round((analysis.type_token_ratio ?? 0) * 100);
        if (pct >= 45) {
          insights.push(
            safeT(
              t,
              "activity.insightVocabHigh",
              "Deine Wortschatz-Vielfalt liegt bei {{pct}}% – überdurchschnittlich abwechslungsreich.",
              { pct },
            ),
          );
        } else if (pct <= 28) {
          insights.push(
            safeT(
              t,
              "activity.insightVocabLow",
              "Deine Wortschatz-Vielfalt liegt bei {{pct}}% – du wiederholst dich häufig.",
              { pct },
            ),
          );
        } else {
          insights.push(
            safeT(t, "activity.insightVocabMid", "Deine Wortschatz-Vielfalt liegt bei {{pct}}%.", {
              pct,
            }),
          );
        }
      }
    } catch {
      // skip
    }

    return insights;
  } catch {
    return [];
  }
}
