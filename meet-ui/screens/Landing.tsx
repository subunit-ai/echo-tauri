import { useI18n } from "../lib/i18n";

/**
 * LANDING — hero + two action cards (start / join). 1:1 port of `#s-landing`.
 */
export function Landing({ onHost, onJoin }: { onHost: () => void; onJoin: () => void }) {
  const { t } = useI18n();
  return (
    <div className="wrap" id="s-landing">
      <div className="hero">
        <div className="eyebrow">
          <span className="dot"></span>Automatisches Protokoll
        </div>
        <h1>{t("Meeting aufnehmen")}</h1>
        <p>{t("Starte ein Meeting oder tritt einem bei — mit sauberer Sprecher-Trennung.")}</p>
      </div>
      <div className="stack">
        <button className="action" onClick={onHost}>
          <span className="ic">
            <svg viewBox="0 0 24 24">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <path d="M12 19v3" />
            </svg>
          </span>
          <span className="tx">
            <div className="tt">{t("Meeting starten")}</div>
            <div className="ds">{t("Aufnehmen & automatisch protokollieren lassen")}</div>
          </span>
          <span className="chev">
            <svg viewBox="0 0 24 24">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </span>
        </button>
        <button className="action alt" onClick={onJoin}>
          <span className="ic">
            <svg viewBox="0 0 24 24">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <path d="M10 17l5-5-5-5" />
              <path d="M15 12H3" />
            </svg>
          </span>
          <span className="tx">
            <div className="tt">{t("Meeting beitreten")}</div>
            <div className="ds">{t("Mit Code oder Link dabei sein")}</div>
          </span>
          <span className="chev">
            <svg viewBox="0 0 24 24">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </span>
        </button>
      </div>
      {/* DSGVO-Trust-Zeile (kein Kasten) — überall präsent, Startseite + Setup */}
      <div className="dsgvo-trust">
        <span className="dsgvo-trust-ic" aria-hidden="true" />
        <span className="dsgvo-trust-txt">100&nbsp;% DSGVO-konform</span>
        <span className="dsgvo-help" tabIndex={0} role="button" aria-label="Was bedeutet DSGVO-konform?">
          ?
          <span className="dsgvo-tip" role="tooltip">
            Alle Meetings werden ausschließlich auf unseren Servern in Deutschland verarbeitet — DSGVO-konform.
            Keine Weitergabe an Dritte, keine US-Cloud. Audio und Transkript werden nach der Auswertung
            automatisch gelöscht. Höchste Datensicherheit ist unser Standard.
          </span>
        </span>
      </div>
    </div>
  );
}
