/* eslint-disable @typescript-eslint/no-explicit-any */
// Cloud-Meeting: Pod-Stimm-Check-In (Gast). Native Echo-Port von
// meet-ui/screens/Enroll.tsx — nur die Präsentation ist neu; jede Store-Bindung,
// der lokale State und der playBing-Effekt sind verbatim übernommen. Zeigt die
// zugewiesene Zahl groß, den Fortschritt (done/total) und den aktuellen Sprecher.
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMeeting } from "@meet/store";

function playBing() {
  try {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return;
    const ac = new Ctor();
    ([[880, 0], [1318.5, 0.12]] as [number, number][]).forEach((p) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "sine";
      o.frequency.value = p[0];
      o.connect(g);
      g.connect(ac.destination);
      const t0 = ac.currentTime + p[1];
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
      o.start(t0);
      o.stop(t0 + 0.34);
    });
    if (navigator.vibrate) navigator.vibrate(45);
  } catch {
    /* ignore */
  }
}

export function CloudEnroll() {
  const { t } = useTranslation();
  const m: any = useMeeting();
  const est: any = m.enroll || {};
  const you: any = est.you || {};
  const st: string = you.status || "waiting";
  const doneRef = useRef(false);

  useEffect(() => {
    if (st === "done" && !doneRef.current) {
      doneRef.current = true;
      playBing();
    }
    if (st !== "done") doneRef.current = false;
  }, [st]);

  let title: string;
  let body: ReactNode;
  let bodyClass = "mc-enr mc-center";

  if (st === "done") {
    title = t("meet.cloudenroll.doneTitle", "Geschafft");
    body = (
      <div className="mc-enr-donebox">
        <div className="mc-enr-ring">
          <svg viewBox="0 0 24 24">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <div className="mc-enr-doneh">{t("meet.cloudenroll.checkedIn", "Eingecheckt!")}</div>
        <div className="mc-enr-dones">
          {est.finished
            ? t("meet.cloudenroll.doneAll", "Alle dabei — es kann losgehen.")
            : t("meet.cloudenroll.doneSelf", "Stimme erkannt. Du kannst das Handy weglegen.")}
        </div>
      </div>
    );
  } else if (st === "active") {
    title = t("meet.cloudenroll.activeTitle", "Du bist dran");
    bodyClass = "mc-enr mc-center mc-active";
    const digits = String(you.code || "").split("");
    body = (
      <>
        <div className="mc-enr-prompt">{t("meet.cloudenroll.readAloud", "Lies deine Zahl laut vor:")}</div>
        <div className="mc-enr-code">
          {digits.map((d, i) => (
            <span className="mc-enr-digit" key={i}>
              {d}
            </span>
          ))}
        </div>
        <div className="mc-enr-mic">{t("meet.cloudenroll.speakToPod", "Sprich deutlich Richtung Pod-Mikro.")}</div>
        <div className="mc-enr-listen">
          <span className="mc-dot" />
          {t("meet.cloudenroll.podListening", "Der Pod hört zu…")}
        </div>
      </>
    );
  } else {
    title = t("meet.cloudenroll.waitTitle", "Stimm-Check-In");
    body = (
      <div className="mc-hint mc-center">
        {est.current_name ? (
          <>
            <span className="mc-enr-spk">{est.current_name}</span>{" "}
            {t("meet.cloudenroll.readingNow", "liest gerade vor…")}
          </>
        ) : (
          t("meet.cloudenroll.startingSoon", "Gleich geht's los…")
        )}
        <br />
        {t("meet.cloudenroll.getReady", "Gleich bist du dran — halt dich bereit.")}
        <br />
        <br />
        <b>{(est.done || 0) + " / " + (est.total || 0)}</b>{" "}
        {t("meet.cloudenroll.checkedInCount", "eingecheckt")}
      </div>
    );
  }

  return (
    <div className="meetc">
      <div className="mc-wrap">
        <div className="card" style={{ maxWidth: 520, textAlign: "center", margin: "0 auto" }}>
          <h1 className="section-title" style={{ textAlign: "center" }}>
            {title}
          </h1>
          <div className={bodyClass}>{body}</div>
        </div>
      </div>
    </div>
  );
}
