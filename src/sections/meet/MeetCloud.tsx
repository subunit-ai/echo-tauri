/* eslint-disable @typescript-eslint/no-explicit-any */
// Cloud-Meeting CONTAINER — native Echo-Ersatz für MeetLive (kein Shadow-DOM-Embed,
// kein Adobe-Video, keine Emojis). Wir konsumieren die geteilte, bewährte Logik
// (LangProvider + MeetingProvider + Store) VERBATIM und rendern ausschließlich Echos
// eigene Liquid-Glass-Screens (Cloud*). Boot portiert den Embed-Auth- + Session-
// Restore-Zweig aus meet-ui/App.tsx (ohne Web-/Mobile-Spezifika: SSO-Callback,
// /code-Deeplink, Recap-Deeplink, BG-Video, Welcome).
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { LangProvider } from "@meet/lib/i18n";
import { MeetingProvider, useMeeting } from "@meet/store";
import { identityFromToken, decodeJwt } from "@meet/lib/auth";
import { meetingInfo } from "@meet/lib/api";
import { CloudLanding } from "./CloudLanding";
import { CloudSetup } from "./CloudSetup";
import { CloudRoom } from "./CloudRoom";
import { CloudJoin } from "./CloudJoin";
import { CloudWaiting } from "./CloudWaiting";
import { CloudGuest } from "./CloudGuest";
import { CloudEnroll } from "./CloudEnroll";
import { CloudEnded } from "./CloudEnded";

export interface MeetCloudProps {
  /** Home „Meeting starten" → direkt in die Einrichtung (Setup) statt Landing. */
  autostart?: "host";
}

/**
 * Provider-Hülle: erst Sprache, dann Meeting-Store (embed-Auth → kein SSO-Redirect),
 * um den inneren Boot-Router. Root trägt `meetc`, damit alle .meetc-*-Styles greifen.
 */
export function MeetCloud({ autostart }: MeetCloudProps) {
  return (
    <div className="meetc">
      <LangProvider>
        <MeetingProvider onSsoLogin={() => {}}>
          <Boot autostart={autostart} />
        </MeetingProvider>
      </LangProvider>
    </div>
  );
}

/**
 * Boot: einmalig beim Mount den Embed-Token adoptieren, dann den Live-Session-Restore
 * aus App.tsx faithful nachbilden (sessionStorage `meetS` → JWT-Frische → /info-Status).
 * Läuft nichts wieder an, entscheidet `autostart` zwischen Setup (hostEntry) und Landing.
 * Rendert die connLost-Warnung + den Screen-Router (m.screen → nativer Cloud-Screen).
 */
function Boot({ autostart }: { autostart?: "host" }) {
  const { t } = useTranslation();
  const m = useMeeting();
  const booted = useRef(false);
  // Gast-Modus (nur beitreten, kein eigenes Meeting) — spiegelt App.tsx' localStorage-Flag.
  const [guest, setGuest] = useState(() => {
    try {
      return localStorage.getItem("meet_guest") === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      // 1) Embed-Auth: Echo hält den subunit-Token, kein OAuth-Redirect (vgl. App.tsx embed).
      const tok = await invoke<string>("meet_token")
        .then((v) => v || null)
        .catch(() => null);
      const hasIdentity = !!tok;
      if (tok) m.setIdentity(identityFromToken(tok));

      // 2) Live-Session-Restore (faithful Port des Web-Zweigs aus App.tsx, embed-tauglich):
      //    tote/abgelaufene Session NICHT wiederherstellen (Token-Expired-Hang, Bug 2026-06-11).
      let v: any = null;
      try {
        v = JSON.parse(sessionStorage.getItem("meetS") || "null");
      } catch {
        v = null;
      }
      if (v && v.code && v.role) {
        let jwtDead = false;
        try {
          const exp = v.jwt ? Number(decodeJwt(v.jwt).exp) || 0 : 0;
          jwtDead = exp > 0 && exp * 1000 < Date.now();
        } catch {
          jwtDead = false;
        }
        const info: any = jwtDead ? null : await meetingInfo(v.code);
        if (info && info.status !== "ended" && info.status !== "purged") {
          if (v.jwt) m.setIdentity({ jwt: v.jwt, email: v.email || "", name: v.name || "" });
          if (v.role === "host") m.resumeHost(info, v);
          else m.resumeGuest(info, v);
          return;
        }
        try {
          sessionStorage.removeItem("meetS");
        } catch {
          /* ignore */
        }
      }

      // 3) Keine lebende Session: autostart landet direkt in der Einrichtung, sonst Landing.
      if (autostart === "host" && hasIdentity) {
        m.hostEntry();
        return;
      }
      m.go("landing");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {m.connLost && (
        <div className="mc-connlost" role="alert">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3.5 2.5 20h19L12 3.5Z" />
            <path d="M12 10v4.5" />
            <path d="M12 17.5h.01" />
          </svg>
          <span>
            {t(
              "meet.cloud.connLost",
              "Verbindung unterbrochen — bleib in dieser App, ich verbinde automatisch neu …",
            )}
          </span>
        </div>
      )}
      <Screen />
    </>
  );

  /** Router: m.screen → nativer Cloud-Screen. default → Landing (noFallthroughCases-safe). */
  function Screen() {
    switch (m.screen) {
      case "hostlogin":
        return <CloudSetup onBack={() => m.go("landing")} />;
      case "host":
        return <CloudRoom />;
      case "join":
        return <CloudJoin onBack={() => m.go("landing")} />;
      case "waiting":
        return <CloudWaiting />;
      case "guest":
        return <CloudGuest />;
      case "enroll":
        return <CloudEnroll />;
      case "ended":
        return <CloudEnded />;
      case "welcome":
      case "landing":
      default:
        return (
          <CloudLanding
            guest={guest}
            onLogin={() => {
              try {
                localStorage.removeItem("meet_guest");
              } catch {
                /* ignore */
              }
              setGuest(false);
              m.hostEntry();
            }}
          />
        );
    }
  }
}
