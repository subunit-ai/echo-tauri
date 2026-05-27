import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { BigModeSwitch } from "../components/BigModeSwitch";
import { RecordPanel } from "../components/RecordPanel";
import { patchForUiMode, uiModeOf } from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";

export function Home() {
  const { config, patch } = useConfig();
  const [meet, setMeet] = useState("");
  if (!config) return null;
  const recent = config.history.slice(0, 5);

  const startMeeting = async () => {
    setMeet("Erstelle Meeting…");
    try {
      const m = await invoke<{ code: string; share_url: string }>("start_meeting");
      setMeet(`Meeting ${m.code} geöffnet`);
    } catch (e) {
      setMeet(`Fehler: ${String(e)}`);
    }
  };

  return (
    <div>
      <h1 className="section-title">Drücken & sprechen</h1>
      <p className="section-sub">
        Hotkey: <b>{config.hotkey}</b> ·{" "}
        {config.recording_mode === "hold" ? "Halten zum Aufnehmen" : "Umschalten zum Aufnehmen"}
      </p>

      <RecordPanel />

      <BigModeSwitch value={uiModeOf(config)} onChange={(m) => patch(patchForUiMode(m))} />

      <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 12 }}>
        <button className="sub-tab" onClick={startMeeting}>
          🎙 Meeting starten
        </button>
        {meet && <span style={{ color: "var(--muted)", fontSize: 12 }}>{meet}</span>}
      </div>

      <div className="stat-grid" style={{ marginTop: 24 }}>
        <div className="card stat-card">
          <div className="label">Transkriptionen</div>
          <div className="value">{config.total_transcriptions}</div>
        </div>
        <div className="card stat-card">
          <div className="label">Im Verlauf</div>
          <div className="value">{config.history.length}</div>
        </div>
        <div className="card stat-card">
          <div className="label">Audio (min)</div>
          <div className="value">{Math.round(config.total_audio_seconds / 60)}</div>
        </div>
        <div className="card stat-card">
          <div className="label">Sprache</div>
          <div className="value" style={{ fontSize: 20, textTransform: "uppercase" }}>
            {config.language}
          </div>
        </div>
      </div>

      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "6px 0 12px" }}>Zuletzt</h2>
      {recent.length === 0 ? (
        <div className="empty">Noch keine Transkriptionen — drück deinen Hotkey und leg los.</div>
      ) : (
        recent.map((e, i) => (
          <div key={i} className="history-item">
            <div className="text">{String(e.text ?? "")}</div>
          </div>
        ))
      )}
    </div>
  );
}
