import { useState } from "react";
import { useTranslation } from "react-i18next";
import { clearHistory, copyText, deleteHistoryEntry } from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";
import { useToast } from "../state/ToastContext";

export function History() {
  const { config, reload } = useConfig();
  const toast = useToast();
  const { t } = useTranslation();
  const [copied, setCopied] = useState<number | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  if (!config) return null;

  const onCopy = async (text: string, i: number) => {
    await copyText(text).catch(() => toast(t("history.copyFailed"), "error"));
    setCopied(i);
    window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 1200);
  };
  const onDelete = async (i: number) => {
    try {
      await deleteHistoryEntry(i);
      await reload();
    } catch {
      toast(t("history.deleteEntryFailed"), "error");
    }
  };
  const onClear = async () => {
    setConfirmingClear(false);
    try {
      await clearHistory();
      await reload();
      toast(t("history.cleared"), "success");
    } catch {
      toast(t("history.clearFailed"), "error");
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 className="section-title">{t("history.title")}</h1>
        {config.history.length > 0 &&
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

      {config.history.length === 0 ? (
        <div className="empty">{t("history.empty")}</div>
      ) : (
        config.history.map((e, i) => {
          const tier = String(e.quality_mode ?? "") || "local";
          const text = String(e.text ?? "");
          return (
            <div key={i} className="history-item">
              <div className="text">{text}</div>
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
                <button className="sub-tab" onClick={() => onCopy(text, i)}>
                  {copied === i ? t("common.copied") : t("common.copy")}
                </button>
                <button className="sub-tab" onClick={() => onDelete(i)}>
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
