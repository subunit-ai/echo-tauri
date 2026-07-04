import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { onMeetingDetected, startMeetingRecording, stopMeetingRecording } from "../lib/ipc";
import { useToast } from "../state/ToastContext";

/**
 * Auto-meeting prompt + recording control. `meeting_detect.rs` emits
 * `echo://meeting-detected` with the app name when it spots a Teams/Zoom/Meet call;
 * we show a brief, dismissible banner asking whether to record — never auto-start
 * (TJ 2026-06-05). Accepting starts a local dual-audio capture (mic + system
 * loopback); the banner then turns into "recording… [Stop]". Stop transcribes the
 * mixed track + stores it as a meeting.
 *
 * No auto-stop in v1: detection is foreground-title based, so a meeting "ending"
 * can't be told apart from the user alt-tabbing away — stopping is manual. The
 * precise mic-in-use signal (Core Audio) is the planned upgrade for reliable
 * auto-start/stop.
 */
export function MeetingPrompt() {
  const { t } = useTranslation();
  const toast = useToast();
  const [app, setApp] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const un = onMeetingDetected((a) => {
      // Ignore re-detections while already recording.
      setRecording((r) => {
        if (!r) setApp(a);
        return r;
      });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  if (!app) return null;

  const accept = async () => {
    setBusy(true);
    try {
      await startMeetingRecording();
      setRecording(true);
    } catch (e) {
      toast(String(e), "error");
      setApp(null);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await stopMeetingRecording();
      toast(t("meeting.saved"), "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setRecording(false);
      setApp(null);
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 14,
        maxWidth: 560,
        width: "calc(100% - 32px)",
        padding: "11px 14px",
        borderRadius: 12,
        background: "rgba(11,22,38,0.96)",
        border: `1px solid ${recording ? "rgba(248,113,113,0.5)" : "rgba(34,211,238,0.4)"}`,
        boxShadow: "0 14px 40px -12px rgba(0,0,0,0.6)",
        backdropFilter: "blur(8px)",
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: recording ? "#f87171" : "#22d3ee",
          boxShadow: `0 0 10px ${recording ? "#f87171" : "#22d3ee"}`,
          flex: "none",
        }}
      />
      <div style={{ flex: 1, fontSize: "0.85rem", color: "#e6eefb", lineHeight: 1.35 }}>
        {recording ? (
          <b>{t("meeting.recording", { app })}</b>
        ) : (
          <>
            <b>{t("meeting.detected", { app })}</b>
            <span style={{ color: "#93a4bd" }}> {t("meeting.hint")}</span>
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flex: "none" }}>
        {recording ? (
          <button
            onClick={stop}
            disabled={busy}
            className="meeting-cta"
            style={{
              border: "none",
              background: "#f87171",
              color: "#2a0404",
              fontWeight: 700,
              fontSize: "0.82rem",
              padding: "8px 16px",
              borderRadius: 9,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {t("meeting.stop")}
          </button>
        ) : (
          <>
            <button
              onClick={accept}
              disabled={busy}
              className="meeting-cta"
              style={{
                border: "none",
                background: "#22d3ee",
                color: "#04222a",
                fontWeight: 700,
                fontSize: "0.82rem",
                padding: "8px 16px",
                borderRadius: 9,
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {t("meeting.recordNow")}
            </button>
            <button
              onClick={() => setApp(null)}
              className="meeting-cta"
              style={{
                border: "1px solid rgba(255,255,255,0.18)",
                background: "transparent",
                color: "#93a4bd",
                fontSize: "0.82rem",
                padding: "8px 14px",
                borderRadius: 9,
                cursor: "pointer",
              }}
            >
              {t("meeting.ignore")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
