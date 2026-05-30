import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { VocabEntry } from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";

const CATS = ["Person", "Company", "Tech", "Place", "Other"];

export function Vocabulary() {
  const { config, patch } = useConfig();
  const { t } = useTranslation();
  const [draft, setDraft] = useState<VocabEntry[] | null>(null);
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

  return (
    <div>
      <h1 className="section-title">{t("vocab.title")}</h1>
      <p className="section-sub">{t("vocab.subtitle")}</p>
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
  );
}
