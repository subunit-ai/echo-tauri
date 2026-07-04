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

/** Auto-vocabulary: surfaces recurring mis-heard terms detected from history.
 *  High-confidence ones were already learned silently (shown under "gelernt"
 *  with undo); the rest are pending suggestions the user confirms/corrects. */
function AutoVocab() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<VocabCandidate[]>([]);
  const [learned, setLearned] = useState<VocabCandidate[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const reload = () => {
    vocabCandidates("pending").then(setPending).catch(() => {});
    vocabCandidates("added").then(setLearned).catch(() => {});
  };
  useEffect(() => {
    const un = listen("echo://vocab-candidates-changed", reload);
    reload(); // show current candidates immediately (async, non-blocking)
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

  if (pending.length === 0 && learned.length === 0) return null;

  const spelling = (c: VocabCandidate) => edits[c.key] ?? c.suggestion ?? c.key;
  const variants = (c: VocabCandidate) => c.variants.map(([v]) => v).join(", ");

  return (
    <div className="card" style={{ marginBottom: 16 }}>
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
            onClick={() => vocabConfirm(c.key, spelling(c)).then(reload)}
          >
            {t("vocab.autoAdd")}
          </button>
          <button className="sub-tab" onClick={() => vocabIgnore(c.key).then(reload)}>
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
                  onClick={() => vocabUndo(c.key).then(reload)}
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

export function Vocabulary() {
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
      <AutoVocab />
      <div className="card">
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
            {rows.map((e, i) => (
              <tr key={i}>
                <td>
                  <input
                    value={e.sounds_like}
                    onChange={(ev) => setField(i, "sounds_like", ev.target.value)}
                  />
                </td>
                <td>
                  <input
                    value={e.write_as}
                    onChange={(ev) => setField(i, "write_as", ev.target.value)}
                  />
                </td>
                <td>
                  <input
                    value={e.aliases.join(", ")}
                    onChange={(ev) => setAliases(i, ev.target.value)}
                  />
                </td>
                <td>
                  <select
                    value={e.category}
                    onChange={(ev) => setField(i, "category", ev.target.value)}
                  >
                    {CATS.map((c) => (
                      <option key={c} value={c}>
                        {t(`vocab.cat.${c}`)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button className="rowdel" onClick={() => del(i)} title={t("common.delete")}>
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
        <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center" }}>
          <button className="sub-tab" onClick={add}>
            {t("vocab.addEntry")}
          </button>
          <div style={{ flex: 1 }} />
          {dirty && (
            <button className="sub-tab" onClick={() => setDraft(null)}>
              {t("vocab.discard")}
            </button>
          )}
          <button
            className="sub-tab"
            style={{ borderColor: "var(--accent)", color: "var(--accent-bright)" }}
            onClick={save}
            disabled={!dirty}
          >
            {t("common.save")}
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}
