import { useEffect, useState } from "react";
import {
  deleteLocalModel,
  downloadModel,
  hardwareInfo,
  listLocalModels,
  onModelProgress,
  type HardwareInfo,
  type ModelInfo,
} from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";

export function ModelManager() {
  const { config, patch } = useConfig();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [hw, setHw] = useState<HardwareInfo | null>(null);

  const refresh = () => listLocalModels().then(setModels).catch(() => {});

  useEffect(() => {
    refresh();
    hardwareInfo().then(setHw).catch(() => {});
    const un = onModelProgress((p) => {
      if (p.error) {
        setProgress((x) => ({ ...x, [p.model]: -1 }));
        return;
      }
      if (p.done) {
        setProgress((x) => {
          const n = { ...x };
          delete n[p.model];
          return n;
        });
        refresh();
        return;
      }
      const pct = p.total ? Math.round(((p.received ?? 0) / p.total) * 100) : 0;
      setProgress((x) => ({ ...x, [p.model]: pct }));
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  if (!config) return null;
  const active = config.local_model;

  const pick = (m: ModelInfo) => {
    patch({ local_model: m.key });
    if (!m.downloaded && progress[m.key] === undefined) {
      setProgress((x) => ({ ...x, [m.key]: 0 }));
      downloadModel(m.key).catch(() => {});
    }
  };

  const remove = (e: React.MouseEvent, key: string) => {
    e.stopPropagation();
    deleteLocalModel(key)
      .then(refresh)
      .catch(() => {});
  };

  return (
    <div className="models">
      {hw && (
        <div
          className="model-status"
          style={{ marginBottom: 8, opacity: 0.85, display: "flex", gap: 6, flexWrap: "wrap" }}
        >
          <span>{hw.summary}</span>
          <span>·</span>
          <span>
            Empfohlen: <b style={{ color: "#22d3ee" }}>{hw.recommended_model}</b>
          </span>
        </div>
      )}
      {models.map((m) => {
        const p = progress[m.key];
        const loading = p !== undefined && p >= 0;
        const isActive = m.key === active;
        const recommended = hw?.recommended_model === m.key;
        return (
          <div
            key={m.key}
            className={`model-row ${isActive ? "active" : ""}`}
            onClick={() => pick(m)}
          >
            <div className="model-meta">
              <div className="model-label">
                {m.label}
                {isActive && <span className="model-active">aktiv</span>}
                {recommended && !isActive && (
                  <span
                    className="model-active"
                    style={{ background: "rgba(34,211,238,0.15)", color: "#22d3ee" }}
                  >
                    empfohlen
                  </span>
                )}
              </div>
              <div className="model-status">
                {p === -1
                  ? "Download fehlgeschlagen — nochmal klicken"
                  : loading
                    ? `Lädt… ${p}%`
                    : m.downloaded
                      ? `✓ geladen · ${m.size_mb} MB`
                      : "nicht geladen — Klick lädt + nutzt"}
              </div>
              {loading && (
                <div className="model-bar">
                  <div style={{ width: `${p}%` }} />
                </div>
              )}
            </div>
            {m.downloaded && !loading && (
              <button className="rowdel" title="Löschen" onClick={(e) => remove(e, m.key)}>
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
