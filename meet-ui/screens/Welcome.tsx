import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { useMeeting } from "../store";
import { pingTap } from "../lib/api";

/**
 * WELCOME — Erststart-Screen vor der Landing (TJ-Direktive 2026-06-11).
 * Großes Echo-Logo + Anmelden (SSO) oder „Als Gast fortfahren" (nur Beitreten).
 * Logo ist antippbar → sendet manuell einen Ping aus. 🤫 Easter-Egg: Taps werden
 * account-basiert gezählt (geheimes Leaderboard, Platz 1 bekommt die Krone) —
 * gebatcht (1,2s) und nur mit Identity, Gäste zählen nicht.
 */
export function Welcome({ onLogin, onGuest }: { onLogin: () => void; onGuest: () => void }) {
  const { t } = useI18n();
  const m = useMeeting();
  // Manuelle Pings: pro Tap ein One-Shot-Ring, der sich nach der Animation selbst aufräumt.
  const [pings, setPings] = useState<number[]>([]);
  // 🤫 Tap-Batch fürs geheime Leaderboard
  const pend = useRef(0);
  const timer = useRef<number | null>(null);
  const jwtRef = useRef<string | null>(null);
  jwtRef.current = m.identity?.jwt || null;

  const flush = () => {
    const n = pend.current;
    pend.current = 0;
    timer.current = null;
    if (n > 0 && jwtRef.current) pingTap(jwtRef.current, n);
  };
  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      flush(); // Restliche Taps beim Verlassen noch wegschicken
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const firePing = () => {
    setPings((p) => [...p, Date.now()]);
    pend.current += 1;
    if (!timer.current) timer.current = window.setTimeout(flush, 1200);
  };

  return (
    <div className="wrap" id="s-welcome">
      <div className="hero welcome-hero">
        <span
          className="welcome-logo"
          role="button"
          tabIndex={0}
          aria-label="Ping senden"
          onClick={firePing}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") firePing();
          }}
        >
          <i></i>
          <i></i>
          <i></i>
          {pings.map((id) => (
            <i
              key={id}
              className="ping-once"
              onAnimationEnd={() => setPings((p) => p.filter((x) => x !== id))}
            ></i>
          ))}
          <svg viewBox="0 0 96 96" aria-hidden="true">
            <circle cx="48" cy="48" r="32" fill="none" stroke="#06b6d4" strokeWidth="2.4" opacity=".3" />
            <circle cx="48" cy="48" r="22" fill="none" stroke="#06b6d4" strokeWidth="2.8" opacity=".55" />
            <g stroke="#06b6d4" strokeWidth="5" strokeLinecap="round">
              <line x1="34" y1="44" x2="34" y2="52" />
              <line x1="40" y1="40" x2="40" y2="56" />
              <line x1="52" y1="36" x2="52" y2="60" />
              <line x1="58" y1="42" x2="58" y2="54" />
            </g>
            <line x1="46" y1="32" x2="46" y2="64" stroke="#06b6d4" strokeWidth="5" strokeLinecap="round" />
          </svg>
        </span>
        <div className="welcome-title">
          <b>Subunit</b> <span className="meet">Meet</span>
        </div>
        <p>{t("Meetings aufnehmen & automatisch protokollieren — mit sauberer Sprecher-Trennung.")}</p>
      </div>
      <div className="stack">
        <button className="btn btn-primary" onClick={onLogin}>
          {t("Anmelden")}
        </button>
        <button className="btn btn-ghost" onClick={onGuest}>
          {t("Als Gast fortfahren")}
        </button>
        <p className="welcome-hint">{t("Als Gast kannst du Meetings beitreten — eigene Meetings starten erfordert einen Account.")}</p>
      </div>
    </div>
  );
}
