/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import { useMeeting } from "../store";

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

/** POD VOICE ENROLLMENT (guest) — 1:1 port of `#s-enroll` + renderEnroll. */
export function Enroll() {
  const { t } = useI18n();
  const { enroll } = useMeeting();
  const est: any = enroll || {};
  const you = est.you || {};
  const st = you.status || "waiting";
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
  let bodyClass = "";

  if (st === "done") {
    title = t("Geschafft");
    body = (
      <div className="enr-done">
        <div className="enr-ring">
          <svg viewBox="0 0 24 24">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <div className="enr-doneh">{t("Eingecheckt!")}</div>
        <div className="enr-dones">{est.finished ? t("Alle dabei — es kann losgehen.") : t("Stimme erkannt. Du kannst das Handy weglegen.")}</div>
      </div>
    );
  } else if (st === "active") {
    title = t("Du bist dran");
    bodyClass = "enr-active";
    const digits = String(you.code || "").split("");
    body = (
      <>
        <div className="enr-prompt">{t("Lies deine Zahl laut vor:")}</div>
        <div className="enr-code">
          {digits.map((d, i) => (
            <span className="enr-digit" key={i}>
              {d}
            </span>
          ))}
        </div>
        <div className="enr-mic">{t("Sprich deutlich Richtung Pod-Mikro.")}</div>
        <div className="enr-listen">
          <span className="dot"></span>
          {t("Der Pod hört zu…")}
        </div>
      </>
    );
  } else {
    title = t("Stimm-Check-In");
    body = (
      <div className="enr-wait">
        {est.current_name ? (
          <>
            <span className="enr-spk">{est.current_name}</span> {t("liest gerade vor…")}
          </>
        ) : (
          t("Gleich geht's los…")
        )}
        <br />
        {t("Gleich bist du dran — halt dich bereit.")}
        <br />
        <br />
        <b>
          {(est.done || 0) + " / " + (est.total || 0)}
        </b>{" "}
        {t("eingecheckt")}
      </div>
    );
  }

  return (
    <div className="wrap card" id="s-enroll">
      <h1 className="ptitle" style={{ textAlign: "center" }} id="enr-title">
        {title}
      </h1>
      <div id="enr-body" className={bodyClass}>
        {body}
      </div>
    </div>
  );
}
