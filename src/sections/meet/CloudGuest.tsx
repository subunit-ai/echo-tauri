// Cloud-Meeting — Gastraum (nativer Echo-Port von meet-ui/screens/Guest.tsx).
// Präsentation neu in Echos Liquid-Glass; die Logik kommt VERBATIM aus dem
// geteilten Store (@meet/store). Zwei Zweige: Pod (zentrales Mikro nimmt auf,
// Gast tut nichts) und normal (Aufnahme läuft am Gerät des Gasts).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMeeting } from "@meet/store";
import { MIC_PATHS, RecDot } from "../../components/icons";

/** Akzent-Haken (Cyan, mit Glow) — nativer Ersatz fuer das fruehere Haken-Glyph im Pod-Titel. */
function CheckIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--cyan)"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--cyan) 50%, transparent))", verticalAlign: "-3px" }}
    >
      <path d="M4.5 12.5l5 5 10-11" />
    </svg>
  );
}

/** Vorhaengeschloss (Stroke) — nativer Ersatz fuer das fruehere Sperr-Glyph in der Sperr-Warnung. */
function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** Nativer Mute-Toggle (.mc-mute) — kein Import von meet-uis MuteButton. */
function MuteButton({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  return (
    <button className={"mc-mute" + (muted ? " on" : "")} onClick={onToggle} aria-pressed={muted}>
      {muted ? (
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M2 2l20 20" />
          <path d="M18.9 13.2A7.1 7.1 0 0 0 19 12v-2" />
          <path d="M5 10v2a7 7 0 0 0 12 5" />
          <path d="M15 9.3V5a3 3 0 0 0-5.7-1.3" />
          <path d="M9 9v3a3 3 0 0 0 5.1 2.1" />
          <path d="M12 19v3" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden>
          {MIC_PATHS.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </svg>
      )}
    </button>
  );
}

/** GUEST ROOM — 1:1 port of `#s-guest`. Auto-records once the host starts. */
export function CloudGuest() {
  const { t } = useTranslation();
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
      <div className="meetc">
        <div className="mc-wrap">
          <div className="card" style={{ maxWidth: 520, textAlign: "center" }}>
            <h1 className="section-title" style={{ textAlign: "center" }}>
              {t("meet.cloudguest.podTitle", "Eingecheckt")} <CheckIcon />
            </h1>
            <div className="mc-rec" style={{ justifyContent: "center" }}>
              <span className={"mc-recdot " + (m.podRecording ? "live" : "off")}></span>
              <span>
                {m.podRecording
                  ? t("meet.cloudguest.podRecording", "Pod nimmt auf")
                  : t("meet.cloudguest.podWaiting", "Eingecheckt — warte auf Host")}
              </span>
            </div>
            <div className="mc-hint mc-center">
              {t(
                "meet.cloudguest.podHint",
                "Das zentrale Mikrofon nimmt das Meeting auf — du musst nichts tun. Dein Handy nimmt nichts auf. Lass diese Seite offen.",
              )}
            </div>
            <button className="mc-danger" onClick={m.leave}>
              {t("meet.cloudguest.leave", "Meeting verlassen")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const recText = m.recOn
    ? t("meet.cloudguest.recOn", "Aufnahme läuft") +
      (m.muted ? t("meet.cloudguest.mutedSuffix", " · stumm") : "")
    : m.resumeRecording
      ? t("meet.cloudguest.resume", "Aufnahme war unterbrochen — hier fortsetzen")
      : m.guestRecText;
  return (
    <div className="meetc">
      <div className="mc-wrap">
        <div className="card" style={{ maxWidth: 520, textAlign: "center" }}>
          <h1 className="section-title" style={{ textAlign: "center" }}>
            {m.title || t("meet.cloudguest.title", "Du bist dabei")}
          </h1>
          <div className="mc-rec" style={{ justifyContent: "center" }}>
            <span className={"mc-recdot " + (m.recOn ? "live" : "off")}></span>
            <span>{m.recMsg || recText}</span>
          </div>
          {m.recOn && <MuteButton muted={m.muted} onToggle={m.toggleMute} />}
          {m.recOn && !m.recMsg && (
            <div className="mc-lockwarn">
              <LockIcon />
              {t(
                "meet.cloudguest.lockwarn",
                "Handy NICHT sperren & in dieser App bleiben — sonst pausiert deine Aufnahme.",
              )}
            </div>
          )}
          <div className="mc-hint mc-center">{m.guestHint}</div>
          {m.guestStartVisible && !m.recOn && (
            <button
              className="sub-tab onb-primary"
              style={{ padding: "10px 18px", fontSize: 14 }}
              disabled={starting}
              onClick={startRec}
            >
              {starting ? (
                t("meet.cloudguest.starting", "Starte…")
              ) : (
                <>
                  <RecDot />
                  {t("meet.cloudguest.startManual", "Aufnahme manuell starten")}
                </>
              )}
            </button>
          )}
          <button className="mc-danger" onClick={m.leave}>
            {t("meet.cloudguest.leave", "Meeting verlassen")}
          </button>
        </div>
      </div>
    </div>
  );
}
