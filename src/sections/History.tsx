import { useConfig } from "../state/ConfigContext";

export function History() {
  const { config } = useConfig();
  if (!config) return null;

  return (
    <div>
      <h1 className="section-title">Verlauf</h1>
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
          return (
            <div key={i} className="history-item">
              <div className="text">{String(e.text ?? "")}</div>
              <div className="meta">
                <span className="tier-badge">{tier}</span>
                {e.ts != null && (
                  <span>{new Date(Number(e.ts) * 1000).toLocaleString("de-DE")}</span>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
