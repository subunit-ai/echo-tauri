import { useState } from "react";
import { useI18n } from "../lib/i18n";
import { useMeeting } from "../store";
import { MuteButton } from "../components/MuteButton";

/** GUEST ROOM — 1:1 port of `#s-guest`. Auto-records once the host starts. */
export function Guest() {
  const { t } = useI18n();
  const m = useMeeting();
  const [starting, setStarting] = useState(false);
  const startRec = async () => {
    setStarting(true);
    const r = await m.guestStartRec();
    if (!r.ok) setStarting(false);
  };

  // Pod mode: central mic records, guest does nothing (renderPodGuest).
  if (m.podGuest) {
    return (
      <div className="wrap card center" id="s-guest">
        <h1 className="ptitle" style={{ textAlign: "center" }} id="guest-title">
          {t("Eingecheckt ✓")}
        </h1>
        <div className="rec">
          <span className={"recdot " + (m.podRecording ? "live" : "off")} id="guest-recdot"></span>
          <span id="guest-rectxt">{m.podRecording ? t("Pod nimmt auf") : t("Eingecheckt — warte auf Host")}</span>
        </div>
        <div className="hint center" id="guest-hint">
          {t("Das zentrale Mikrofon nimmt das Meeting auf — du musst nichts tun. Dein Handy nimmt nichts auf. Lass diese Seite offen.")}
        </div>
        <button className="btn btn-danger" onClick={m.leave}>
          {t("Meeting verlassen")}
        </button>
      </div>
    );
  }

  const recText = m.recOn
    ? "Aufnahme läuft" + (m.muted ? " · stumm" : "")
    : m.resumeRecording
      ? "Aufnahme war unterbrochen — hier fortsetzen"
      : m.guestRecText;
  return (
    <div className="wrap card center" id="s-guest">
      <h1 className="ptitle" style={{ textAlign: "center" }} id="guest-title">
        {m.title || t("Du bist dabei")}
      </h1>
      <div className="rec">
        <span className={"recdot " + (m.recOn ? "live" : "off")} id="guest-recdot"></span>
        <span id="guest-rectxt">{m.recMsg || recText}</span>
      </div>
      {m.recOn && <MuteButton muted={m.muted} onToggle={m.toggleMute} />}
      {m.recOn && !m.recMsg && (
        <div className="lockwarn" id="guest-lockwarn">
          📵 Handy NICHT sperren &amp; in dieser App bleiben — sonst pausiert deine Aufnahme.
        </div>
      )}
      <div className="hint center" id="guest-hint">
        {m.guestHint}
      </div>
      {m.guestStartVisible && !m.recOn && (
        <button className="btn btn-primary" id="guest-startbtn" disabled={starting} onClick={startRec}>
          {starting ? "Starte…" : "🔴 " + t("Aufnahme manuell starten")}
        </button>
      )}
      <button className="btn btn-danger" onClick={m.leave}>
        {t("Meeting verlassen")}
      </button>
      <div className="err" id="guest-err"></div>
    </div>
  );
}
