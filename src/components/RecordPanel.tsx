import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { onState, onTranscript, type EngineState } from "../lib/ipc";

const LABEL: Record<EngineState, string> = {
  idle: "Bereit",
  recording: "Aufnahme läuft…",
  transcribing: "Transkribiere…",
  done: "Fertig",
  error: "Fehler",
};

// Push-to-talk test control. The real trigger is the global hotkey; this lets
// you drive the full record → transcribe loop from the window too.
export function RecordPanel() {
  const [state, setState] = useState<EngineState>("idle");
  const [detail, setDetail] = useState("");
  const [last, setLast] = useState("");
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const subs = [
      onState((p) => {
        setState(p.state);
        setDetail(p.detail ?? "");
      }),
      onTranscript((p) => setLast(p.text)),
    ];
    return () => {
      subs.forEach((s) => s.then((un) => un()));
    };
  }, []);

  useEffect(() => {
    if (state !== "recording") {
      setLevel(0);
      return;
    }
    const id = window.setInterval(async () => {
      try {
        setLevel(await invoke<number>("mic_level"));
      } catch {
        /* ignore */
      }
    }, 80);
    return () => window.clearInterval(id);
  }, [state]);

  const start = () => invoke("start_recording").catch((e) => setDetail(String(e)));
  const stop = () => invoke("stop_and_transcribe").catch((e) => setDetail(String(e)));

  const recording = state === "recording";

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <div className="record-panel">
        <button
          type="button"
          className={`mic-btn ${recording ? "rec" : ""}`}
          title="Gedrückt halten zum Aufnehmen"
          onPointerDown={start}
          onPointerUp={stop}
          onPointerLeave={() => recording && stop()}
        >
          🎙
        </button>
        <div style={{ flex: 1 }}>
          <div className="level-track">
            <div className="level-fill" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          <div className="engine-state">
            {LABEL[state]}
            {detail && state === "error" ? ` · ${detail}` : ""}
          </div>
        </div>
      </div>
      {last && (
        <div className="history-item" style={{ marginTop: 14, marginBottom: 0 }}>
          <div className="text">{last}</div>
        </div>
      )}
    </div>
  );
}
