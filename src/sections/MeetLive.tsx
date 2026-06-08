import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MeetApp } from "@meet/MeetApp";
import meetCss from "@meet/styles/meet.css?inline";

/**
 * Native Meeting view — runs the meet.subunit.ai React app (the rewrite) IN Echo, sharing
 * one source. It takes over the whole window: when this is mounted the Echo Shell is not
 * rendered, so meet owns body/#root exactly as on the web (no CSS collision). meet.css is
 * injected only while this view is open and removed on exit. Auth = Echo's subunit token
 * (meet_token command) — no SSO redirect, and the token never leaves the local webview.
 */
export function MeetLive({ onExit }: { onExit: () => void }) {
  useEffect(() => {
    const style = document.createElement("style");
    style.id = "meet-embed-css";
    style.textContent = meetCss;
    document.head.appendChild(style);
    return () => {
      style.remove();
      // Leave meet's theme class as-is is harmless, but reset so Echo's own theme resumes.
      document.documentElement.classList.remove("dark");
    };
  }, []);

  const getEmbedToken = async (): Promise<string | null> => {
    try {
      const t = await invoke<string>("meet_token");
      return t || null;
    } catch {
      return null;
    }
  };

  return (
    <>
      <MeetApp authMode="embed" getEmbedToken={getEmbedToken} />
      <button
        onClick={onExit}
        title="Zurück zu Echo"
        style={{
          position: "fixed",
          left: 16,
          bottom: 16,
          zIndex: 9999,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "9px 14px",
          borderRadius: 999,
          border: "1px solid rgba(150,180,220,.25)",
          background: "rgba(20,38,64,.72)",
          backdropFilter: "blur(20px) saturate(1.5)",
          WebkitBackdropFilter: "blur(20px) saturate(1.5)",
          color: "#e6eefb",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
          boxShadow: "0 8px 24px -10px rgba(0,0,0,.5)",
        }}
      >
        ← Echo
      </button>
    </>
  );
}
