/**
 * WELCOME — purer Splash (TJ 2026-06-12): NUR Logo + "Subunit Meet".
 * Ein Tap irgendwo fuehrt weiter (stiller Login steht dahinter schon bereit) —
 * Erstnutzer landen auf der Login-Subpage. Idle-Pings laufen weiter.
 */
export function Welcome({ onContinue }: { onContinue: () => void }) {
  return (
    <div
      className="wrap welcome-splash"
      id="s-welcome"
      role="button"
      tabIndex={0}
      aria-label="Weiter"
      onClick={onContinue}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onContinue();
      }}
    >
      <div className="hero welcome-hero">
        <span className="welcome-logo" aria-hidden="true">
          <i></i>
          <i></i>
          <i></i>
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
      </div>
    </div>
  );
}
