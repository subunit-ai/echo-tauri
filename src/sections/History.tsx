import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  clearHistory,
  copyText,
  deleteHistoryEntry,
  historyList,
  onHistoryChanged,
  type HistoryEntry,
} from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";
import { useToast } from "../state/ToastContext";

export function History() {
  const { config } = useConfig();
  const toast = useToast();
  const { t } = useTranslation();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  // History lives in the SQLite store — fetch on mount + search, refresh live
  // when a dictation lands (echo://history-changed).
  const refresh = useCallback(
    (q: string) => {
      historyList(q).then(setEntries).catch(() => setEntries([]));
    },
    [],
  );
  useEffect(() => refresh(query), [query, refresh]);
  useEffect(() => {
    const un = onHistoryChanged(() => refresh(query));
    return () => {
      un.then((f) => f());
    };
  }, [query, refresh]);

  if (!config) return null;

  const onCopy = async (text: string, id: number) => {
    try {
      await copyText(text);
    } catch {
      toast(t("history.copyFailed"), "error");
      return;
    }
    toast(t("common.copied"), "success"); // small confirmation toast
    setCopied(id);
    window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
  };
  const onDelete = async (id: number) => {
    try {
      await deleteHistoryEntry(id);
      refresh(query);
    } catch {
      toast(t("history.deleteEntryFailed"), "error");
    }
  };
  const onClear = async () => {
    setConfirmingClear(false);
    try {
      await clearHistory();
      refresh(query);
      toast(t("history.cleared"), "success");
    } catch {
      toast(t("history.clearFailed"), "error");
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 className="section-title">{t("history.title")}</h1>
        {entries.length > 0 &&
          (confirmingClear ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "0.82rem", color: "var(--muted)" }}>{t("history.confirmClear")}</span>
              <button className="sub-tab" onClick={onClear}>
                {t("common.yes")}
              </button>
              <button className="sub-tab" onClick={() => setConfirmingClear(false)}>
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            <button className="sub-tab" onClick={() => setConfirmingClear(true)}>
              {t("common.deleteAll")}
            </button>
          ))}
      </div>
      <p className="section-sub">
        {config.history_enabled
          ? t("history.subEnabled")
          : t("history.subDisabled")}
      </p>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("history.searchPlaceholder")}
        style={{ marginBottom: 14, maxWidth: 360 }}
      />

      {entries.length === 0 ? (
        <div className="empty">{query ? t("history.noResults") : t("history.empty")}</div>
      ) : (
        entries.map((e) => {
          const tier = e.quality_mode || "local";
          return (
            <div key={e.id} className="history-item">
              <div
                className={`text${copied === e.id ? " copied" : ""}`}
                onClick={() => onCopy(e.text, e.id)}
                title={t("history.clickToCopy")}
              >
                {e.text}
              </div>
              <div
                className="meta"
                style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
              >
                <span className="tier-badge">{tier}</span>
                {e.ts != null && (
                  <span>{new Date(Number(e.ts) * 1000).toLocaleString("de-DE")}</span>
                )}
                {e.latency_ms != null && (
                  <span title={t("history.latencyHint")}>
                    {(Number(e.latency_ms) / 1000).toLocaleString(undefined, {
                      maximumFractionDigits: 1,
                    })}{" "}
                    s
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <button className="sub-tab" onClick={() => onCopy(e.text, e.id)}>
                  {copied === e.id ? t("common.copied") : t("common.copy")}
                </button>
                <button className="sub-tab" onClick={() => onDelete(e.id)}>
                  {t("common.delete")}
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
