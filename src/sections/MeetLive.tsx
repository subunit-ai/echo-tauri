import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

// The LIVE meet.subunit.ai web app, loaded in embed mode. Loading the live site (not a
// vendored copy) means Echo always shows the current meet version — web changes are
// reflected immediately, no re-sync/rebuild. `?embed=1` makes the meet app accept the
// subunit token from the desktop (no SSO re-login) instead of the web SSO redirect.
const MEET_ORIGIN = "https://meet.subunit.ai";
const MEET_EMBED_URL = `${MEET_ORIGIN}/?embed=1`;

/**
 * Meeting view — embeds the live meet.subunit.ai app (embed mode) in the content pane.
 *
 * Auth: Echo holds the subunit access token and hands it to the (cross-origin) meet frame
 * via postMessage, pinned to MEET_ORIGIN, so the host lands pre-authenticated — logged in
 * with the Echo account automatically, no re-login. The token only ever goes to
 * meet.subunit.ai (never broadcast). The frame announces "meet-ready"; we reply with the
 * token, plus an onLoad fallback in case ready fired before our listener attached.
 */
export function MeetLive() {
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let alive = true;
    const sendToken = async () => {
      let tok: string | null = null;
      try {
        tok = (await invoke<string>("meet_token")) || null;
      } catch {
        tok = null;
      }
      if (alive) {
        ref.current?.contentWindow?.postMessage({ type: "meet-token", token: tok }, MEET_ORIGIN);
      }
    };
    // The meet frame announces itself once its listener is attached (its origin = MEET_ORIGIN).
    const onMsg = (e: MessageEvent) => {
      if (e.origin === MEET_ORIGIN && e.data && e.data.type === "meet-ready") sendToken();
    };
    window.addEventListener("message", onMsg);
    return () => {
      alive = false;
      window.removeEventListener("message", onMsg);
    };
  }, []);

  return (
    <iframe
      ref={ref}
      src={MEET_EMBED_URL}
      title="Meeting"
      allow="microphone; autoplay"
      // Fallback hand-off in case "meet-ready" fired before our listener attached.
      onLoad={() => {
        invoke<string>("meet_token")
          .then((t) =>
            ref.current?.contentWindow?.postMessage({ type: "meet-token", token: t || null }, MEET_ORIGIN),
          )
          .catch(() =>
            ref.current?.contentWindow?.postMessage({ type: "meet-token", token: null }, MEET_ORIGIN),
          );
      }}
      style={{ flex: 1, width: "100%", border: 0, display: "block" }}
    />
  );
}
