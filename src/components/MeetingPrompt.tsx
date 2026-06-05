import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { onMeetingDetected, startMeeting } from "../lib/ipc";

/**
 * Auto-meeting prompt. `meeting_detect.rs` emits `echo://meeting-detected` with the
 * app name (Teams/Zoom/Meet) when it spots a call; we show a brief, dismissible
 * banner asking whether to record — never auto-start (TJ 2026-06-05). Accepting
 * starts the meeting; ignoring just dismisses it (the detector won't re-prompt for
 * the same app within its cooldown).
 *
 * NOTE: "record" currently routes through start_meeting (meet.subunit.ai room).
 * Local dual-audio capture (mic + system loopback) is the next increment.
 */
export function MeetingPrompt() {
  const { t } = useTranslation();
  const [app, setApp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const un = onMeetingDetected((a) => setApp(a));
    return () => {
      un.then((f) => f());
    };
  }, []);

  if (!app) return null;

  const accept = async () => {
    setBusy(true);
    try {
      await startMeeting();
    } finally {
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
        border: "1px solid rgba(34,211,238,0.4)",
        boxShadow: "0 14px 40px -12px rgba(0,0,0,0.6)",
        backdropFilter: "blur(8px)",
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: "#22d3ee",
          boxShadow: "0 0 10px #22d3ee",
          flex: "none",
        }}
      />
      <div style={{ flex: 1, fontSize: "0.85rem", color: "#e6eefb", lineHeight: 1.35 }}>
        <b>{t("meeting.detected", { app })}</b>
        <span style={{ color: "#93a4bd" }}> {t("meeting.hint")}</span>
      </div>
      <div style={{ display: "flex", gap: 8, flex: "none" }}>
        <button
          onClick={accept}
          disabled={busy}
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
      </div>
    </div>
  );
}
