/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from "react";
import { Chrome } from "./components/Chrome";
import { Landing } from "./screens/Landing";
import { HostLogin } from "./screens/HostLogin";
import { Host } from "./screens/Host";
import { Join } from "./screens/Join";
import { Waiting } from "./screens/Waiting";
import { Guest } from "./screens/Guest";
import { Enroll } from "./screens/Enroll";
import { Ended } from "./screens/Ended";
import { useMeeting } from "./store";
import { handleSsoCallback, identityFromToken } from "./lib/auth";
import { meetingInfo } from "./lib/api";
import type { AuthMode } from "./MeetApp";

/**
 * Screen router + boot. Mirrors the vanilla init() IIFE: handle an SSO callback, else
 * restore a live session (sessionStorage `meetS` → /info), else a /<code> deep-link → join,
 * else landing. Chrome (brand/lang/theme) + the connection-lost banner sit above all screens.
 *
 * In embed mode (Echo desktop) there's no URL round-trip: we adopt the injected subunit
 * token and land authenticated on the landing screen.
 */
export function App({ authMode = "web", getEmbedToken }: { authMode?: AuthMode; getEmbedToken?: () => Promise<string | null> } = {}) {
  const m = useMeeting();
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      // Echo embed: adopt the injected token, stay on landing (pre-authenticated).
      if (authMode === "embed") {
        const tok = getEmbedToken ? await getEmbedToken() : null;
        if (tok) m.setIdentity(identityFromToken(tok));
        return;
      }

      const path = location.pathname.match(/^\/(\d{6})$/);
      const recapT = new URLSearchParams(location.search).get("t");

      // Recap deep-link: /<code>?t=<token> → view-only results.
      if (path && recapT) {
        m.openRecapView(path[1], recapT);
        return;
      }

      const id = await handleSsoCallback();
      if (id) {
        m.setIdentity(id);
        m.go("hostlogin");
        return;
      }

      let v: any = null;
      try {
        v = JSON.parse(sessionStorage.getItem("meetS") || "null");
      } catch {
        v = null;
      }
      if (v && v.code && v.role) {
        const info = await meetingInfo(v.code);
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

      if (path) m.goJoin(path[1]); // deep-link: land on join with the code prefilled
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {m.connLost && (
        <div id="connlost" className="connlost">
          ⚠️ Verbindung unterbrochen — bleib in dieser App, ich verbinde automatisch neu …
        </div>
      )}
      <Chrome />
      {m.screen === "landing" && <Landing onHost={m.hostEntry} onJoin={() => m.goJoin()} />}
      {m.screen === "hostlogin" && <HostLogin onBack={() => m.go("landing")} />}
      {m.screen === "host" && <Host />}
      {m.screen === "join" && <Join onBack={() => m.go("landing")} />}
      {m.screen === "waiting" && <Waiting />}
      {m.screen === "guest" && <Guest />}
      {m.screen === "enroll" && <Enroll />}
      {m.screen === "ended" && <Ended />}
      <div id="print-area" aria-hidden="true"></div>
    </>
  );
}
