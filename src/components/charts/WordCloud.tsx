import { useId, useMemo, type CSSProperties } from "react";

/** One weighted tag in the cloud: a word plus how often it occurs
 * (structurally identical to `WordFreq` in `lib/ipc.ts` — kept as its own
 * named type here so this primitive stays disjunct/self-contained). */
export interface WordCloudDatum {
  word: string;
  count: number;
}

const MIN_FONT_REM = 0.85;
const MAX_FONT_REM = 2.15;
const MIN_OPACITY = 0.5;

/**
 * Weighted tag cloud — explicitly NOT a real spatial cloud layout (no
 * spiral/packing algorithm, no collision detection). Words simply wrap like
 * normal text via CSS flex-wrap spans; size ramps with `sqrt(count)` (so the
 * single most-used word doesn't dwarf everything else) while the cyan tint
 * strength (opacity) ramps linearly with the raw `count`. Pure, self-contained,
 * no external lib — every colour resolves from the active theme's CSS custom
 * properties (`--cyan` / `--ink*`), so it stays correct across
 * dark/light/liquid/schwarz without any hard-coded black or white. Width is
 * always 100% and content wraps onto new lines (never a fixed px that would
 * force horizontal scrolling of the content pane).
 */
export function WordCloud(props: {
  words: WordCloudDatum[];
  max?: number;
  onWordClick?: (w: string) => void;
}) {
  const { words, max, onWordClick } = props;
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const scopeClass = `wc-${rawId}`;
  const interactive = typeof onWordClick === "function";

  const items = useMemo(() => {
    const clean = (words ?? []).filter(
      (w): w is WordCloudDatum =>
        !!w &&
        typeof w.word === "string" &&
        w.word.trim().length > 0 &&
        Number.isFinite(w.count) &&
        w.count > 0,
    );
    const sorted = [...clean].sort((a, b) => b.count - a.count);
    const capped = typeof max === "number" && max > 0 ? sorted.slice(0, max) : sorted;
    if (capped.length === 0) return [];

    const counts = capped.map((w) => w.count);
    const minCount = Math.min(...counts);
    const maxCount = Math.max(...counts);
    const sqrtSpan = Math.sqrt(maxCount) - Math.sqrt(minCount);
    const countSpan = maxCount - minCount;

    return capped.map((w) => {
      // sqrtSpan/countSpan collapse to 0 when every word shares one count
      // (or there is a single word) — treat that as "everyone is the max"
      // instead of dividing by zero.
      const sizeT = sqrtSpan > 0 ? (Math.sqrt(w.count) - Math.sqrt(minCount)) / sqrtSpan : 1;
      const opacityT = countSpan > 0 ? (w.count - minCount) / countSpan : 1;
      return {
        ...w,
        fontSize: MIN_FONT_REM + sizeT * (MAX_FONT_REM - MIN_FONT_REM),
        opacity: MIN_OPACITY + opacityT * (1 - MIN_OPACITY),
      };
    });
  }, [words, max]);

  if (items.length === 0) {
    // Neutral, empty-but-valid render — no crash, no visible clutter. Callers
    // decide whether to swap in a localized empty-state message instead of
    // mounting this component at all (see `activity.wordCloudEmpty`).
    return (
      <div
        className="word-cloud word-cloud--empty"
        role="status"
        aria-label="No word frequency data yet"
      />
    );
  }

  return (
    <div className={`word-cloud ${scopeClass}`}>
      <style>{`
        .${scopeClass} .word-cloud-list {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 0.3em 0.7em;
          width: 100%;
          margin: 0;
          padding: 0;
          list-style: none;
        }
        .${scopeClass} .word-cloud-word {
          display: inline-block;
          font: inherit;
          font-weight: 600;
          line-height: 1.15;
          white-space: nowrap;
          background: none;
          border: none;
          margin: 0;
          padding: 0;
          color: var(--cyan);
          transition: opacity 0.15s var(--ease-out, ease), transform 0.15s var(--ease-out, ease);
        }
        .${scopeClass} button.word-cloud-word {
          cursor: pointer;
        }
        .${scopeClass} button.word-cloud-word:hover,
        .${scopeClass} button.word-cloud-word:focus-visible {
          opacity: 1;
          transform: translateY(-1px);
        }
        .${scopeClass} button.word-cloud-word:focus-visible {
          outline: 2px solid var(--cyan);
          outline-offset: 2px;
          border-radius: var(--r-xs, 4px);
        }
      `}</style>
      <ul className="word-cloud-list" role="list" aria-label="Word frequency cloud">
        {items.map((w, i) => {
          const style: CSSProperties = {
            fontSize: `${w.fontSize.toFixed(2)}rem`,
            opacity: w.opacity,
          };
          const label = `${w.word}, ${w.count}`;
          return (
            <li key={`${w.word}-${i}`}>
              {interactive ? (
                <button
                  type="button"
                  className="word-cloud-word"
                  style={style}
                  onClick={() => onWordClick!(w.word)}
                  title={`${w.word} · ${w.count}`}
                  aria-label={label}
                >
                  {w.word}
                </button>
              ) : (
                <span
                  className="word-cloud-word"
                  style={style}
                  title={`${w.word} · ${w.count}`}
                  aria-label={label}
                >
                  {w.word}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
