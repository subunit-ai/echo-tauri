import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Native Meeting view — runs the meet.subunit.ai React app (the rewrite) IN Echo via an
 * iframe (meet.html) inside the content pane, so Echo's sidebar stays put on the left. The
 * iframe is its own document → meet.css is fully isolated and can't touch Echo's shell, while
 * the look stays pixel-identical to the standalone site.
 *
 * Auth = Echo's subunit token. The sub-frame has no Tauri IPC, so the main window fetches the
 * token (meet_token) and hands it over via postMessage; it never leaves the local webview.
 */
export function MeetLive() {
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let alive = true;
    // Pin the token hand-off to our own origin (parent + iframe share tauri://localhost):
    // never broadcast the subunit access token with a "*" targetOrigin.
    const origin = window.location.origin;
    const sendToken = async () => {
      let tok: string | null = null;
      try {
        tok = (await invoke<string>("meet_token")) || null;
      } catch {
        tok = null;
      }
      if (alive) ref.current?.contentWindow?.postMessage({ type: "meet-token", token: tok }, origin);
    };
    // The iframe announces itself once its message listener is attached.
    const onMsg = (e: MessageEvent) => {
      if (e.origin === origin && e.data && e.data.type === "meet-ready") sendToken();
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
      src="meet.html"
      title="Meeting"
      allow="microphone; autoplay"
      // Fallback hand-off in case "meet-ready" fired before our listener attached.
      onLoad={() => {
        const origin = window.location.origin;
        invoke<string>("meet_token")
          .then((t) =>
            ref.current?.contentWindow?.postMessage({ type: "meet-token", token: t || null }, origin),
          )
          .catch(() =>
            ref.current?.contentWindow?.postMessage({ type: "meet-token", token: null }, origin),
          );
      }}
      style={{ flex: 1, width: "100%", border: 0, display: "block" }}
    />
  );
}
