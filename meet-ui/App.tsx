/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { Chrome } from "./components/Chrome";
import { Landing } from "./screens/Landing";
import { HostLogin } from "./screens/HostLogin";
import { Host } from "./screens/Host";
import { Join } from "./screens/Join";
import { Waiting } from "./screens/Waiting";
import { Guest } from "./screens/Guest";
import { Enroll } from "./screens/Enroll";
import { Ended } from "./screens/Ended";
import { Welcome } from "./screens/Welcome";
import { useMeeting } from "./store";
import { handleSsoCallback, identityFromToken, decodeJwt } from "./lib/auth";
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
  // Gast-Modus (Welcome → "Als Gast fortfahren"): nur Beitreten, kein Meeting starten.
  const [guest, setGuest] = useState(() => {
    try { return localStorage.getItem("meet_guest") === "1"; } catch { return false; }
  });
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
        // 🔒 H4-Fix (2026-06-10): Token aus der Adresszeile entfernen, sobald er im Speicher ist
        // (spiegelt handleSsoCallback). Verhindert Leak via History/Bookmark/Referer/Screenshare.
        try {
          history.replaceState({}, "", "/" + path[1]);
        } catch {
          /* ignore */
        }
        return;
      }

      const id = await handleSsoCallback();
      if (id) {
        m.setIdentity(id);
        m.go("landing"); // nach SSO auf die Landing — nicht direkt in die Einrichtung (TJ 2026-06-11)
        return;
      }

      let v: any = null;
      try {
        v = JSON.parse(sessionStorage.getItem("meetS") || "null");
      } catch {
        v = null;
      }
      if (v && v.code && v.role) {
        // Abgelaufener JWT → tote Session, NICHT wiederherstellen (sonst Token-Expired-Hang
        // + Reload-Loop, Bug 2026-06-11).
        let jwtDead = false;
        try {
          const exp = v.jwt ? Number(decodeJwt(v.jwt).exp) || 0 : 0;
          jwtDead = exp > 0 && exp * 1000 < Date.now();
        } catch {
          jwtDead = false;
        }
        const info = jwtDead ? null : await meetingInfo(v.code);
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

      if (path) {
        m.goJoin(path[1]); // deep-link: land on join with the code prefilled (Welcome wird uebersprungen)
        return;
      }

      // 🔑 Persistenter Login: Identity still wiederherstellen (JWT noch >60s gueltig) —
      // "Anmelden" auf der Welcome geht damit sofort durch (kein SSO-Redirect).
      let saved: any = null;
      try { saved = JSON.parse(localStorage.getItem("meet_id") || "null"); } catch { saved = null; }
      if (saved?.jwt) {
        const exp = Number(decodeJwt(saved.jwt).exp) || 0;
        if (exp * 1000 > Date.now() + 60000) m.setIdentity(saved);
        else {
          try { localStorage.removeItem("meet_id"); } catch { /* ignore */ }
        }
      }
      // Welcome ist IMMER der Start-Screen bei frischem App-Start (TJ 2026-06-11) —
      // nur Deep-Link/Recap/Live-Session-Restore (oben) springen direkt rein.
      m.go("welcome");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 🎥 BG-Video nach App-Resume weiterlaufen lassen (iOS pausiert Videos beim Backgrounden,
  // autoplay greift beim Zurueckkommen nicht erneut) — TJ-Bug 2026-06-11
  useEffect(() => {
    // Zurueckgebaut (TJ 2026-06-12): die load()-Eskalation konnte das Video auf dem
    // Geraet dauerhaft killen (Reload-Kette — nach load() kommt nie ein Frame an).
    // Nur noch sanftes play(); Watchdog + Gesten-Kick decken die bekannten Pausen ab.
    const ensure = () => {
      const v = document.getElementById("bgvid") as HTMLVideoElement | null;
      if (!v) return;
      if (!v.paused && v.readyState >= 3) return; // laeuft — nichts anfassen
      v.play().catch(() => {});
    };
    (window as any).__bgvidKick = ensure; // native iOS-Shell ruft das bei didBecomeActive
    // Dauer-Watchdog (TJ 2026-06-12): iOS pausiert das BG-Video auch bei
    // Audio-Session-Wechseln (Mikro-Permission/getUserMedia im Setup, Anruf, Siri) —
    // dafuer gibt es KEIN visibility-Event. Alle 4s pruefen: sichtbar + pausiert → ensure().
    const watchdog = window.setInterval(() => {
      if (document.hidden) return;
      const v = document.getElementById("bgvid") as HTMLVideoElement | null;
      if (v && v.paused) ensure();
    }, 4000);
    const resume = () => {
      if (!document.hidden) ensure();
    };
    // 🔋 Stromsparmodus-Rettung (TJ 2026-06-12): im Low Power Mode verbietet iOS
    // programmatisches play() — aber innerhalb einer User-Geste ist es erlaubt.
    // Jeder Tap/Klick irgendwo kickt das Video an (no-op, wenn es schon laeuft).
    const gestureKick = () => ensure();
    window.addEventListener("touchend", gestureKick, { passive: true });
    window.addEventListener("click", gestureKick);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("focus", resume);
    return () => {
      window.removeEventListener("touchend", gestureKick);
      window.removeEventListener("click", gestureKick);
      window.clearInterval(watchdog);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("focus", resume);
    };
  }, []);

  return (
    <>
      {/* 🎥 Fester Video-Hintergrund (Adobe-Stock Partikel-Welle, TJ 2026-06-11) — nur Dark-Mode (CSS), Mesh bleibt Fallback/Poster */}
      <video id="bgvid" autoPlay muted loop playsInline preload="auto" poster="/bg-wave-poster.jpg" aria-hidden="true">
        <source src="/bg-wave5-1080.mp4" type="video/mp4" />
      </video>
      {m.connLost && (
        <div id="connlost" className="connlost">
          ⚠️ Verbindung unterbrochen — bleib in dieser App, ich verbinde automatisch neu …
        </div>
      )}
      <Chrome />
      {m.screen === "welcome" && (
        <Welcome
          onLogin={() => {
            try { localStorage.removeItem("meet_guest"); } catch { /* ignore */ }
            setGuest(false);
            // Eingeloggt (persistierte Identity) → Landing ("Meeting aufnehmen"), NICHT direkt
            // in die Einrichtung durchreichen (TJ-Bug 2026-06-11). Ohne Identity → SSO-Redirect.
            if (m.identity?.jwt) m.go("landing");
            else m.hostEntry();
          }}
          onGuest={() => {
            try { localStorage.setItem("meet_guest", "1"); } catch { /* ignore */ }
            setGuest(true);
            m.go("landing");
          }}
        />
      )}
      {m.screen === "landing" && (
        <Landing
          guest={guest}
          onHost={m.hostEntry}
          onJoin={() => m.goJoin()}
          onLogin={() => {
            try { localStorage.removeItem("meet_guest"); } catch { /* ignore */ }
            setGuest(false);
            m.hostEntry();
          }}
        />
      )}
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
