import { useState } from "react";
import { clearHistory, copyText, deleteHistoryEntry } from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";

export function History() {
  const { config, reload } = useConfig();
  const [copied, setCopied] = useState<number | null>(null);
  if (!config) return null;

  const onCopy = async (text: string, i: number) => {
    await copyText(text).catch(() => {});
    setCopied(i);
    window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 1200);
  };
  const onDelete = async (i: number) => {
    await deleteHistoryEntry(i).catch(() => {});
    await reload();
  };
  const onClear = async () => {
    await clearHistory().catch(() => {});
    await reload();
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 className="section-title">Verlauf</h1>
        {config.history.length > 0 && (
          <button className="sub-tab" onClick={onClear}>
            Alle löschen
          </button>
        )}
      </div>
      <p className="section-sub">
        {config.history_enabled
          ? "Deine letzten Transkriptionen."
          : "Verlauf ist deaktiviert (Einstellungen → Account)."}
      </p>

      {config.history.length === 0 ? (
        <div className="empty">Noch nichts aufgenommen.</div>
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
                <span style={{ flex: 1 }} />
                <button className="sub-tab" onClick={() => onCopy(text, i)}>
                  {copied === i ? "Kopiert ✓" : "Kopieren"}
                </button>
                <button className="sub-tab" onClick={() => onDelete(i)}>
                  Löschen
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
