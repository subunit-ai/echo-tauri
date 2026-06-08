import { useEffect, useState } from "react";
import { toggleTheme } from "../lib/theme";
import { useI18n, type Lang } from "../lib/i18n";
import { useMeeting } from "../store";

const LANGS: { l: Lang; label: string }[] = [
  { l: "de", label: "🇩🇪 Deutsch" },
  { l: "en", label: "🇬🇧 English" },
  { l: "es", label: "🇪🇸 Español" },
  { l: "fr", label: "🇫🇷 Français" },
  { l: "it", label: "🇮🇹 Italiano" },
  { l: "pt", label: "🇵🇹 Português" },
];

/**
 * Fixed page chrome: language chip (top-left), account chip + theme toggle (top-right),
 * and the centered Subunit·Meet brand with the sonar-ping Echo logo. Markup + classes
 * are a 1:1 port of the live meet.subunit.ai so the CSS renders identically.
 */
export function Chrome() {
  const { lang, setLang } = useI18n();
  const { identity } = useMeeting();
  const [langOpen, setLangOpen] = useState(false);

  // Close the language menu on any outside click (vanilla document click listener).
  useEffect(() => {
    if (!langOpen) return;
    const close = () => setLangOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [langOpen]);

  return (
    <>
      {/* Sprach-Umschalter oben links */}
      <div id="uilang-sw" className={`lang${langOpen ? " open" : ""}`}>
        <button
          type="button"
          className="lang"
          style={{ all: "unset", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          onClick={(e) => {
            e.stopPropagation();
            setLangOpen((o) => !o);
          }}
          aria-haspopup="listbox"
          aria-label="Sprache / Language / Idioma"
        >
          <svg viewBox="0 0 24 24" className="globe">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18" />
            <path d="M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
          </svg>
          <span id="uilang-cur">{lang.toUpperCase()}</span>
          <svg className="caret" viewBox="0 0 24 24">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <div id="uilang-menu" className="uilang-menu" hidden={!langOpen}>
          {LANGS.map((x) => (
            <button
              key={x.l}
              type="button"
              data-l={x.l}
              className={x.l === lang ? "on" : undefined}
              onClick={() => {
                setLang(x.l);
                setLangOpen(false);
              }}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>

      {/* Account-Chip oben rechts (hell) — shown once signed in */}
      <a
        id="acctchip"
        className="acctchip"
        href="https://auth.subunit.ai/account"
        title="Konto & Abmelden"
        style={identity?.email ? { display: "flex" } : undefined}
      >
        <span id="acctini" className="ini">
          {(identity?.email?.[0] || "").toUpperCase()}
        </span>
        <span id="acctmail" className="ml">
          {identity?.email || ""}
        </span>
      </a>

      {/* Hell/Dunkel-Umschalter oben rechts */}
      <button
        type="button"
        id="themetog"
        className="themetog"
        onClick={toggleTheme}
        aria-label="Hell/Dunkel umschalten"
        title="Hell/Dunkel"
      >
        <svg className="ic-moon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
        <svg className="ic-sun" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2v2.4M12 19.6V22M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2 12h2.4M19.6 12H22M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" />
        </svg>
      </button>

      <div className="brand">
        <b>Subunit</b>
        <span className="echo">
          <i aria-hidden="true"></i>
          <i aria-hidden="true"></i>
          <i aria-hidden="true"></i>
          <svg viewBox="0 0 96 96" aria-label="Echo">
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
        <span className="meet">Meet</span>
      </div>
    </>
  );
}
