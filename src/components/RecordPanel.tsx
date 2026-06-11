import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { onState, onTranscript, type EngineState } from "../lib/ipc";

// Push-to-talk test control. The real trigger is the global hotkey; this lets
// you drive the full record → transcribe loop from the window too.
export function RecordPanel() {
  const { t } = useTranslation();
  const [state, setState] = useState<EngineState>("idle");
  const [detail, setDetail] = useState("");
  const [last, setLast] = useState("");
  const [level, setLevel] = useState(0);

  const LABEL: Record<EngineState, string> = {
    idle: t("record.stateIdle"),
    recording: t("record.stateRecording"),
    transcribing: t("record.stateTranscribing"),
    done: t("common.done"),
    error: t("common.error"),
  };

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
  const stop = () =>
    invoke("stop_and_transcribe").catch((e: { code?: string; message?: string }) => {
      const code = e?.code;
      setDetail(
        code === "trial_expired"
          ? t("record.errorTrialExpired")
          : code === "auth"
            ? t("record.errorNotSignedIn")
            : code === "model_missing"
              ? t("record.errorModelMissing")
              : (e?.message ?? String(e)),
      );
    });

  const recording = state === "recording";

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <div className="record-panel">
        <button
          type="button"
          className={`mic-btn ${recording ? "rec" : ""}`}
          title={t("record.holdToRecord")}
          onPointerDown={start}
          onPointerUp={stop}
          onPointerLeave={() => recording && stop()}
        >
          {/* Stroke-Mic statt Emoji (Enterprise, TJ 2026-06-12) */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <path d="M12 19v3" />
          </svg>
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
