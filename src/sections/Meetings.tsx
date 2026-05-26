import { useState } from "react";
import { useConfig } from "../state/ConfigContext";

export function Meetings() {
  const { config } = useConfig();
  const [open, setOpen] = useState<number | null>(null);
  if (!config) return null;

  const list = config.meetings;
  const thresholdMin = Math.round(config.long_form_threshold_seconds / 60);

  return (
    <div>
      <h1 className="section-title">Meetings</h1>
      <p className="section-sub">
        Lange Aufnahmen (≥ {thresholdMin} Min) — separat gespeichert. Klick öffnet das volle
        Transkript.
      </p>

      {list.length === 0 ? (
        <div className="empty">Noch keine langen Aufnahmen.</div>
      ) : (
        list.map((m, i) => {
          const text = String(m.text ?? "");
          const dur = Number(m.duration_s ?? 0);
          const isOpen = open === i;
          return (
            <div
              key={i}
              className="history-item"
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
                    : { maxHeight: 38, overflow: "hidden", maskImage: "linear-gradient(#000 60%, transparent)" }
                }
              >
                {text}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
