import { useState } from "react";
import { copyText, processMeeting } from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";

// Re-process styles available on a stored meeting transcript (server /v1/cleanup).
const ACTIONS: { style: string; label: string }[] = [
  { style: "summary", label: "Zusammenfassung" },
  { style: "action_items", label: "Aufgaben" },
  { style: "decisions", label: "Entscheidungen" },
  { style: "minutes", label: "Protokoll" },
  { style: "recap_email", label: "Recap-E-Mail" },
];

export function Meetings() {
  const { config } = useConfig();
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // `${i}:${style}`
  const [result, setResult] = useState<Record<number, { label: string; text: string }>>({});
  const [copied, setCopied] = useState(false);
  if (!config) return null;

  const list = config.meetings;
  const thresholdMin = Math.round(config.long_form_threshold_seconds / 60);

  const run = async (i: number, style: string, label: string) => {
    setBusy(`${i}:${style}`);
    try {
      const text = await processMeeting(i, style);
      setResult((r) => ({ ...r, [i]: { label, text } }));
    } catch (e) {
      setResult((r) => ({ ...r, [i]: { label, text: `Fehler: ${String(e)}` } }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h1 className="section-title">Meetings</h1>
      <p className="section-sub">
        Lange Aufnahmen (≥ {thresholdMin} Min) — separat gespeichert. Klick öffnet das volle
        Transkript; die Buttons erzeugen Zusammenfassung / Aufgaben / Entscheidungen.
      </p>

      {list.length === 0 ? (
        <div className="empty">Noch keine langen Aufnahmen.</div>
      ) : (
        list.map((m, i) => {
          const text = String(m.text ?? "");
          const dur = Number(m.duration_s ?? 0);
          const isOpen = open === i;
          const res = result[i];
          return (
            <div key={i} className="history-item">
              <div
                style={{ cursor: "pointer" }}
                onClick={() => setOpen(isOpen ? null : i)}
              >
                <div className="meta" style={{ marginTop: 0, marginBottom: 6 }}>
                  <span className="tier-badge">{String(m.quality_mode ?? "") || "local"}</span>
                  <span>{Math.max(1, Math.round(dur / 60))} Min</span>
                  {m.ts != null && (
                    <span>{new Date(Number(m.ts) * 1000).toLocaleString("de-DE")}</span>
                  )}
                </div>
                <div
                  className="text"
                  style={
                    isOpen
                      ? {}
                      : {
                          maxHeight: 38,
                          overflow: "hidden",
                          maskImage: "linear-gradient(#000 60%, transparent)",
                        }
                  }
                >
                  {text}
                </div>
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                {ACTIONS.map((a) => (
                  <button
                    key={a.style}
                    className="sub-tab"
                    disabled={busy !== null}
                    onClick={() => run(i, a.style, a.label)}
                  >
                    {busy === `${i}:${a.style}` ? "…" : a.label}
                  </button>
                ))}
              </div>

              {res && (
                <div
                  style={{
                    marginTop: 10,
                    padding: 12,
                    borderRadius: 10,
                    background: "rgba(34,211,238,0.06)",
                    border: "1px solid rgba(34,211,238,0.25)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 6,
                    }}
                  >
                    <b style={{ color: "#22d3ee", fontSize: "0.85rem" }}>{res.label}</b>
                    <button
                      className="sub-tab"
                      onClick={async () => {
                        await copyText(res.text).catch(() => {});
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1200);
                      }}
                    >
                      {copied ? "Kopiert ✓" : "Kopieren"}
                    </button>
                  </div>
                  <div className="text" style={{ whiteSpace: "pre-wrap" }}>
                    {res.text}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
