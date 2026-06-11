import { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { MeetApp } from "@meet/MeetApp";
// ?inline → CSS as a string (not injected into Echo's document); we inject it into the
// meet shadow root below so meet.css can't touch Echo's shell and vice-versa.
import meetCssRaw from "@meet/styles/meet.css?inline";
import bridgeCss from "./meet-embed.css?inline";

/**
 * Rewrite meet.css's document-level selectors so they take effect INSIDE a shadow root,
 * keeping meet's OWN theme (light default; its dark via `:host(.dark)`):
 *   :root      → :host            (design tokens live on the shadow host)
 *   html.dark  → :host(.dark)
 *   html,body  → :host,.meet-root
 *   html       → :host            (page gradient)
 *   body       → .meet-root       (flex column + padding; mesh on ::before/::after)
 * Order matters (html.dark before html; the body::/body> variants before body{).
 */
function scopeMeetCss(css: string): string {
  return css
    .replaceAll("html.dark", ":host(.dark)")
    .replaceAll(":root{", ":host{")
    .replaceAll("html,body{", ":host,.meet-root{")
    .replaceAll("html{", ":host{")
    .replaceAll("body::before", ".meet-root::before")
    .replaceAll("body::after", ".meet-root::after")
    .replaceAll("body>*", ".meet-root>*")
    .replaceAll("body{", ".meet-root{");
}

/**
 * Meeting view — renders the shared meet-ui app NATIVELY inside Echo (no iframe, no network
 * load), in a Shadow DOM. Opening Meet is instant and looks identical to the standalone
 * meet.subunit.ai (meet keeps its own frosted-glass theme — the scoped meet.css carries its
 * tokens on `:host`). meet.css is vendored from the canonical meet-react and kept current via
 * scripts-sync-meet-ui.sh, so each Echo release ships the up-to-date meet UI.
 *
 * Isolation: inside the shadow root, neither meet.css nor Echo's CSS can leak across. The
 * `transform` on `:host` (meet-embed.css) confines meet's position:fixed chrome to this pane.
 * Auth: Echo's subunit token is read directly over the `meet_token` IPC (same JS context, no
 * postMessage) so the host lands logged in automatically.
 */
export function MeetLive() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.replaceChildren(); // clean slate (guards against a StrictMode re-run)

    const style = document.createElement("style");
    style.textContent = `${scopeMeetCss(meetCssRaw)}\n${bridgeCss}`;
    shadow.appendChild(style);

    const mount = document.createElement("div");
    mount.className = "meet-root";
    shadow.appendChild(mount);

    const root: Root = createRoot(mount);
    root.render(
      <MeetApp
        authMode="embed"
        getEmbedToken={() =>
          invoke<string>("meet_token")
            .then((t) => t || null)
            .catch(() => null)
        }
      />,
    );

    return () => {
      // React forbids unmounting a root while rendering; defer past the current commit.
      queueMicrotask(() => {
        root.unmount();
        style.remove();
        mount.remove();
      });
    };
  }, []);

  return <div ref={hostRef} style={{ flex: 1, width: "100%", display: "block" }} />;
}
