/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { toggleTheme } from "../lib/theme";
import { useI18n, type Lang } from "../lib/i18n";
import { useMeeting } from "../store";
import { pingTap, pingRank } from "../lib/api";
import { fmtDate } from "../lib/format";

const LANGS: { l: Lang; label: string }[] = [
  { l: "de", label: "🇩🇪 Deutsch" },
  { l: "en", label: "🇬🇧 English" },
  { l: "es", label: "🇪🇸 Español" },
  { l: "fr", label: "🇫🇷 Français" },
  { l: "it", label: "🇮🇹 Italiano" },
  { l: "pt", label: "🇵🇹 Português" },
];

/**
 * Fixed page chrome: language chip (top-left), account chip + history + theme toggle
 * (top-right), and the centered Subunit·Meet brand with the sonar-ping Echo logo. Markup +
 * classes are a 1:1 port of the live meet.subunit.ai so the CSS renders identically.
 */
// Geplanter Termin (scheduled_at ISO) → "12.06. 17:00" für den Verlauf.
function fmtSched(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function Chrome() {
  const { lang, setLang } = useI18n();
  const { identity, loadMyMeetings, openHistoryMeeting, screen, leave } = useMeeting();
  const [langOpen, setLangOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [histList, setHistList] = useState<any[] | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  // Easter Egg (TJ 2026-06-12): Platz 1 im geheimen Ping-Ranking traegt eine Mini-Krone
  // am Account-Chip — sonst nirgends sichtbar.
  const [crown, setCrown] = useState<number | null>(null);
  useEffect(() => {
    const jwt = identity?.jwt;
    if (!jwt) { setCrown(null); return; }
    let dead = false;
    pingRank(jwt).then((r) => {
      if (!dead) setCrown(r.leader ? r.count : null);
    }).catch(() => {});
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.jwt]);
  // 👆 Brand-Logo-Ping auf JEDER Seite (TJ 2026-06-12): Tap → One-Shot-Ring + zaehlt
  // ins geheime Leaderboard (gebatcht, nur mit Identity — Gaeste pingen nur optisch).
  const [brandPings, setBrandPings] = useState<number[]>([]);
  const pingPend = useRef(0);
  const pingTimer = useRef<number | null>(null);
  const pingJwt = useRef<string | null>(null);
  pingJwt.current = identity?.jwt || null;
  const flushBrandPings = () => {
    const n = pingPend.current;
    pingPend.current = 0;
    pingTimer.current = null;
    if (n > 0 && pingJwt.current) pingTap(pingJwt.current, n);
  };
  useEffect(() => {
    return () => {
      if (pingTimer.current) window.clearTimeout(pingTimer.current);
      flushBrandPings();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fireBrandPing = () => {
    setBrandPings((p) => [...p, Date.now()]);
    pingPend.current += 1;
    if (!pingTimer.current) pingTimer.current = window.setTimeout(flushBrandPings, 1200);
  };
  // Meeting-Verlassen-X nur in aktiven Meeting-Screens (nicht Setup/Landing/Join/Ended).
  const inMeeting = screen === "host" || screen === "waiting" || screen === "guest" || screen === "enroll";

  // Close the language menu on any outside click (vanilla document click listener).
  useEffect(() => {
    if (!langOpen) return;
    const close = () => setLangOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [langOpen]);

  const openHistory = async () => {
    setHistOpen(true);
    setHistList(null);
    setHistList(await loadMyMeetings());
  };
  const pickHistory = (mtg: any) => {
    setHistOpen(false);
    openHistoryMeeting(mtg.code, mtg.host_token || "");
  };

  return (
    <>
      {/* Meeting verlassen (X) — oben links, nur im aktiven Meeting */}
      {inMeeting && (
        <button type="button" className="cancelbtn" onClick={() => setCancelOpen(true)} aria-label="Meeting verlassen" title="Meeting verlassen">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
      {/* Sprach-Umschalter oben links (im Meeting ausgeblendet — der X nimmt den Platz) */}
      <div id="uilang-sw" className={`lang${langOpen ? " open" : ""}`} hidden={inMeeting}>
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
        href={"https://auth.subunit.ai/account?lang=" + lang + "&return=" + encodeURIComponent(window.location.origin + window.location.pathname)}
        title="Konto & Abmelden"
        style={identity?.email ? { display: "flex" } : undefined}
      >
        <span id="acctini" className="ini">
          {(identity?.email?.[0] || "").toUpperCase()}
          {crown !== null && (
            <span className="acct-crown" title={"Sonar-Champion — " + crown + " Pings"} aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M3 7.5l4.7 3.8L12 4.5l4.3 6.8L21 7.5l-1.8 10a1.5 1.5 0 0 1-1.5 1.2H6.3a1.5 1.5 0 0 1-1.5-1.2L3 7.5z" /></svg>
            </span>
          )}
        </span>
        <span id="acctmail" className="ml">
          {identity?.email || ""}
        </span>
      </a>

      {/* Verlauf-Icon oben rechts — neben dem Hell/Dunkel-Schalter, nur für eingeloggte Hosts */}
      {identity?.jwt && (
        <button
          type="button"
          id="histtog"
          className="themetog histtog"
          onClick={openHistory}
          aria-label="Verlauf"
          title="Verlauf"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </button>
      )}

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

      {screen !== "welcome" && (
      <div className={"brand" + (screen === "landing" ? " brand-lg" : "")}>
        <b>Subunit</b>
        <span
          className="echo"
          role="button"
          tabIndex={0}
          aria-label="Ping senden"
          onClick={fireBrandPing}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") fireBrandPing();
          }}
        >
          <i aria-hidden="true"></i>
          <i aria-hidden="true"></i>
          <i aria-hidden="true"></i>
          {brandPings.map((id) => (
            <i
              key={id}
              className="ping-once"
              aria-hidden="true"
              onAnimationEnd={() => setBrandPings((p) => p.filter((x) => x !== id))}
            ></i>
          ))}
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
      )}

      {cancelOpen && (
        <div className="ddm center">
          <div className="ddm-bg" onClick={() => setCancelOpen(false)}></div>
          <div className="ddm-card cancel-card" role="dialog" aria-modal="true">
            <div className="ddm-title">Meeting verlassen?</div>
            <p className="cancel-sub">Willst du das Meeting wirklich verlassen?</p>
            <div className="cancel-actions">
              <button className="btn btn-ghost" onClick={() => setCancelOpen(false)}>Zurück</button>
              <button className="btn btn-danger" onClick={() => { setCancelOpen(false); leave(); }}>Verlassen</button>
            </div>
          </div>
        </div>
      )}
      {histOpen && <HistoryModal list={histList} onClose={() => setHistOpen(false)} onPick={pickHistory} />}
    </>
  );
}

/** Verlauf — the caller's own meetings, newest first; click re-opens the protocol. */
function HistoryModal({
  list,
  onClose,
  onPick,
}: {
  list: any[] | null;
  onClose: () => void;
  onPick: (m: any) => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div className="ddm hist-modal">
      <div className="ddm-bg" onClick={onClose}></div>
      <div className="ddm-card hist-card" role="dialog" aria-modal="true">
        <button className="ddm-x" onClick={onClose} aria-label="Schließen">
          ✕
        </button>
        <div className="ddm-title">{t("Deine Meetings")}</div>
        {list === null ? (
          <div className="hist-empty">{t("Lade…")}</div>
        ) : list.length === 0 ? (
          <div className="hist-empty">{t("Noch keine Meetings.")}</div>
        ) : (
          <ul className="hist-list">
            {list.map((mtg) => (
              <li
                key={mtg.code}
                className="hist-row"
                role="button"
                tabIndex={0}
                onClick={() => onPick(mtg)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onPick(mtg);
                }}
              >
                <span className="hist-tt">{mtg.title || "Meeting #" + mtg.code}</span>
                <span className={"hist-meta" + (mtg.scheduled_at ? " sched" : "")}>
                  {mtg.scheduled_at
                    ? "📅 geplant für " + fmtSched(mtg.scheduled_at)
                    : mtg.created_at
                      ? fmtDate(mtg.created_at)
                      : ""}
                  {mtg.participants ? " · " + mtg.participants + " dabei" : ""}
                  {mtg.status && mtg.status !== "ended" && mtg.status !== "purged" ? " · läuft" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
