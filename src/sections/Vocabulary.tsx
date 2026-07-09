import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  vocabCandidates,
  vocabConfirm,
  vocabIgnore,
  vocabScan,
  vocabUndo,
  type VocabCandidate,
  type VocabEntry,
} from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";
import { Toggle } from "../components/Toggle";

const CATS = ["Person", "Company", "Tech", "Place", "Other"];

// Throttle the background rescan across section re-opens. The scan itself is
// cheap (spawned off-thread in Rust), but each one emits vocab-candidates-changed
// → reload → re-render, so we don't want to re-run that cascade on every open.
let lastVocabScanAt = 0;

/** The "Vorschläge" tab: recurring mis-heard terms Echo detected from history.
 *  High-confidence ones were already learned silently (shown under "gelernt"
 *  with undo); the rest are pending suggestions the user confirms/corrects.
 *  Presentational — candidate state is lifted to `Vocabulary` so the tab badge
 *  can show the pending count. */
function AutoVocab({
  pending,
  learned,
  onReload,
}: {
  pending: VocabCandidate[];
  learned: VocabCandidate[];
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const [edits, setEdits] = useState<Record<string, string>>({});

  const spelling = (c: VocabCandidate) => edits[c.key] ?? c.suggestion ?? c.key;
  const variants = (c: VocabCandidate) => c.variants.map(([v]) => v).join(", ");

  if (pending.length === 0 && learned.length === 0) {
    return (
      <div className="card">
        <p className="section-sub" style={{ margin: 0 }}>{t("vocab.suggestEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="name" style={{ opacity: 0.7, marginBottom: 4 }}>{t("vocab.autoTitle")}</div>
      <p className="section-sub" style={{ marginTop: 0 }}>{t("vocab.autoSub")}</p>

      {pending.map((c) => (
        <div
          key={c.key}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "9px 0",
            borderTop: "1px solid var(--glass-edge)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 180, fontSize: 13 }}>
            {t("vocab.autoHeard", { variants: variants(c), count: c.total })}
          </div>
          <input
            style={{ width: 170 }}
            value={spelling(c)}
            placeholder={t("vocab.autoSpellingPlaceholder")}
            onChange={(e) => setEdits({ ...edits, [c.key]: e.target.value })}
          />
          <button
            className="sub-tab"
            style={{ borderColor: "var(--accent)", color: "var(--accent-bright)" }}
            onClick={() => vocabConfirm(c.key, spelling(c)).then(onReload)}
          >
            {t("vocab.autoAdd")}
          </button>
          <button className="sub-tab" onClick={() => vocabIgnore(c.key).then(onReload)}>
            {t("vocab.autoIgnore")}
          </button>
        </div>
      ))}

      {learned.length > 0 && (
        <div style={{ marginTop: pending.length ? 14 : 4 }}>
          <div className="name" style={{ opacity: 0.6, fontSize: 12 }}>{t("vocab.autoLearned")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {learned.map((c) => (
              <span
                key={c.key}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "3px 6px 3px 11px",
                  borderRadius: 999,
                  border: "1px solid var(--border-strong)",
                  fontSize: 12,
                }}
              >
                {c.added_term}
                <button
                  onClick={() => vocabUndo(c.key).then(onReload)}
                  title={t("vocab.autoUndo")}
                  style={{
                    background: "none",
                    border: "none",
                    color: "inherit",
                    cursor: "pointer",
                    padding: "0 2px",
                    opacity: 0.7,
                  }}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The "Wörterbuch" tab: the editable list of custom terms. Add is surfaced at
 *  the top so it's the first thing in reach. */
function Dictionary() {
  const { config, patch } = useConfig();
  const { t } = useTranslation();
  const [draft, setDraft] = useState<VocabEntry[] | null>(null);

  // Dirty-guard: persist an unsaved draft when leaving the section (unmount) so
  // edits aren't silently lost on a sidebar switch. Same filtering as save().
  const draftRef = useRef<VocabEntry[] | null>(null);
  draftRef.current = draft;
  useEffect(
    () => () => {
      const d = draftRef.current;
      if (d !== null) patch({ vocabulary: d.filter((e) => e.write_as.trim()) });
    },
    [patch],
  );

  if (!config) return null;

  const rows = draft ?? config.vocabulary;
  const dirty = draft !== null;

  // Newest first: the store keeps plain insertion order (every add path appends
  // — `add()` here, Learning's "add to vocabulary", Rust's `vocabulary.push`),
  // so the freshest term is LAST. We reverse only the VIEW and carry each row's
  // real storage index along, so edit/delete still address the right entry.
  //
  // The stored array is deliberately NOT reversed: `apply_vocab_replace` sorts
  // patterns by length with a STABLE sort, so insertion order breaks ties
  // between equal-length patterns — flipping it could change transcripts.
  const view = rows.map((entry, idx) => ({ entry, idx })).reverse();

  const setField = (i: number, f: "sounds_like" | "write_as" | "category", v: string) =>
    setDraft(rows.map((e, idx) => (idx === i ? { ...e, [f]: v } : e)));
  const setAliases = (i: number, v: string) =>
    setDraft(
      rows.map((e, idx) =>
        idx === i
          ? { ...e, aliases: v.split(",").map((s) => s.trim()).filter(Boolean) }
          : e,
      ),
    );
  const add = () =>
    setDraft([...rows, { sounds_like: "", write_as: "", aliases: [], category: "Other" }]);
  const del = (i: number) => setDraft(rows.filter((_, idx) => idx !== i));
  const save = () => {
    patch({ vocabulary: rows.filter((e) => e.write_as.trim()) });
    setDraft(null);
  };
  // One-click purge of every auto-learned word (category "auto"). The old silent
  // auto-add corrupted clean transcripts, so this lets the user clear them anytime
  // — a config migration already strips them once on upgrade. Only shown when
  // there actually are auto entries left, and it discards any unsaved draft.
  const hasAuto = config.vocabulary.some((e) => e.category === "auto");
  const clearAuto = () => {
    patch({ vocabulary: config.vocabulary.filter((e) => e.category !== "auto") });
    setDraft(null);
  };

  return (
    <div className="card">
      {/* Actions on top — quickest reach to add a term. */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14, alignItems: "center" }}>
        <button
          className="sub-tab"
          style={{ borderColor: "var(--accent)", color: "var(--accent-bright)" }}
          onClick={add}
        >
          {t("vocab.addEntry")}
        </button>
        {hasAuto && (
          <button className="sub-tab" onClick={clearAuto} title={t("vocab.clearAutoHint")}>
            {t("vocab.clearAuto")}
          </button>
        )}
        <div style={{ flex: 1 }} />
        {dirty && (
          <button className="sub-tab" onClick={() => setDraft(null)}>
            {t("vocab.discard")}
          </button>
        )}
        <button className="sub-tab" onClick={save} disabled={!dirty}>
          {t("common.save")}
        </button>
      </div>

      <table className="vocab">
        <thead>
          <tr>
            <th>{t("vocab.colSoundsLike")}</th>
            <th>{t("vocab.colWriteAs")}</th>
            <th>{t("vocab.colAliases")}</th>
            <th>{t("vocab.colCategory")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {view.map(({ entry: e, idx }) => (
            <tr key={idx}>
              <td>
                <input
                  value={e.sounds_like}
                  onChange={(ev) => setField(idx, "sounds_like", ev.target.value)}
                />
              </td>
              <td>
                <input
                  value={e.write_as}
                  onChange={(ev) => setField(idx, "write_as", ev.target.value)}
                />
              </td>
              <td>
                <input
                  value={e.aliases.join(", ")}
                  onChange={(ev) => setAliases(idx, ev.target.value)}
                />
              </td>
              <td>
                <select
                  value={e.category}
                  onChange={(ev) => setField(idx, "category", ev.target.value)}
                >
                  {CATS.map((c) => (
                    <option key={c} value={c}>
                      {t(`vocab.cat.${c}`)}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <button className="rowdel" onClick={() => del(idx)} title={t("common.delete")}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                {t("vocab.empty")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Vocabulary() {
  const { config, patch } = useConfig();
  const { t } = useTranslation();
  const [tab, setTab] = useState<"dict" | "suggest">("dict");

  // Candidate state is lifted here (not inside AutoVocab) so the "Vorschläge"
  // tab can carry a live pending-count badge without a second fetch.
  const [pending, setPending] = useState<VocabCandidate[]>([]);
  const [learned, setLearned] = useState<VocabCandidate[]>([]);
  const reloadCandidates = () => {
    vocabCandidates("pending").then(setPending).catch(() => {});
    vocabCandidates("added").then(setLearned).catch(() => {});
  };
  useEffect(() => {
    const un = listen("echo://vocab-candidates-changed", reloadCandidates);
    reloadCandidates(); // show current candidates immediately (async, non-blocking)
    // Defer the rescan a frame so it never competes with the section's first
    // paint — opening Vocabulary stays instant — and throttle re-opens.
    const now = Date.now();
    if (now - lastVocabScanAt > 30_000) {
      lastVocabScanAt = now;
      requestAnimationFrame(() => vocabScan().catch(() => {}));
    }
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  if (!config) return null;

  const enabled = config.vocab_enabled;

  return (
    <div>
      <h1 className="section-title">{t("vocab.title")}</h1>
      <p className="section-sub">{t("vocab.subtitle")}</p>

      {/* Master switch — decoupled from cleanup. On = replacements apply on every
          path (streaming + batch, cleanup on or off); off = Whisper gets no bias
          and no post-replace runs at all. */}
      <div
        className="card"
        style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}
      >
        <div style={{ flex: 1 }}>
          <div className="name">{t("vocab.enabledTitle")}</div>
          <p className="section-sub" style={{ margin: "2px 0 0" }}>
            {t("vocab.enabledSub")}
          </p>
        </div>
        <Toggle checked={enabled} onChange={(v) => patch({ vocab_enabled: v })} />
      </div>

      <div style={{ opacity: enabled ? 1 : 0.45, pointerEvents: enabled ? "auto" : "none" }}>
        <div className="sub-tabs" style={{ marginBottom: 16 }}>
          <button
            className={`sub-tab ${tab === "dict" ? "active" : ""}`}
            onClick={() => setTab("dict")}
          >
            {t("vocab.tabDict")}
          </button>
          <button
            className={`sub-tab ${tab === "suggest" ? "active" : ""}`}
            onClick={() => setTab("suggest")}
          >
            {t("vocab.tabSuggestions")}
            {pending.length > 0 && (
              <span className="tier-badge" style={{ marginLeft: 8 }}>{pending.length}</span>
            )}
          </button>
        </div>

        {tab === "dict" ? (
          <Dictionary />
        ) : (
          <AutoVocab pending={pending} learned={learned} onReload={reloadCandidates} />
        )}
      </div>
    </div>
  );
}
