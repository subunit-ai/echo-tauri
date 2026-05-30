import { useState } from "react";
import { clearHistory, copyText, deleteHistoryEntry } from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";
import { useToast } from "../state/ToastContext";

export function History() {
  const { config, reload } = useConfig();
  const toast = useToast();
  const [copied, setCopied] = useState<number | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  if (!config) return null;

  const onCopy = async (text: string, i: number) => {
    await copyText(text).catch(() => toast("Konnte nicht kopieren.", "error"));
    setCopied(i);
    window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 1200);
  };
  const onDelete = async (i: number) => {
    try {
      await deleteHistoryEntry(i);
      await reload();
    } catch {
      toast("Eintrag konnte nicht gelöscht werden.", "error");
    }
  };
  const onClear = async () => {
    setConfirmingClear(false);
    try {
      await clearHistory();
      await reload();
      toast("Verlauf gelöscht.", "success");
    } catch {
      toast("Verlauf konnte nicht gelöscht werden.", "error");
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 className="section-title">Verlauf</h1>
        {config.history.length > 0 &&
          (confirmingClear ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "0.82rem", color: "var(--muted)" }}>Wirklich alles löschen?</span>
              <button className="sub-tab" onClick={onClear}>
                Ja
              </button>
              <button className="sub-tab" onClick={() => setConfirmingClear(false)}>
                Abbrechen
              </button>
            </div>
          ) : (
            <button className="sub-tab" onClick={() => setConfirmingClear(true)}>
              Alle löschen
            </button>
          ))}
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
