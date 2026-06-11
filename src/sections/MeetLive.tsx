import { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { MeetApp } from "@meet/MeetApp";
// Imported as strings (?inline) so they are NOT injected into Echo's document — they only
// live inside the meet shadow root below.
import meetCss from "@meet/styles/meet.css?inline";
import embedCss from "./meet-embed.css?inline";

/**
 * Native Meeting view — renders the shared meet.subunit.ai React app (meet-ui) directly in
 * Echo, inside a Shadow DOM. No iframe, no second document, no reload: opening Meet is
 * instant and stays mounted.
 *
 * Why a shadow root: meet.css has page-global rules (`*`, `html`, `body`, `:root`) and a
 * full-bleed background. Inside a shadow root those `html`/`body`/`:root` selectors match
 * nothing, so meet.css can't touch Echo's shell (and Echo's CSS can't touch meet) — yet the
 * design tokens inherit across the boundary from Echo's `:root`, so meet renders in Echo's
 * Liquid-Glass theme and follows dark/light automatically. meet-embed.css re-supplies the
 * `<body>`-level pieces (centered layout + aurora mesh) scoped to the mount and confines
 * meet's `position:fixed` chrome to this pane.
 *
 * Auth = Echo's subunit token, fetched directly over IPC (`meet_token`) — same JS context,
 * so no postMessage handshake; the token never leaves the local webview.
 */
export function MeetLive() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });

    // Inject meet's stylesheet (verbatim) + Echo's embed bridge into the shadow only. A
    // <style> element works on every WebView (no constructable-stylesheet requirement);
    // CSP allows it (style-src 'unsafe-inline').
    const style = document.createElement("style");
    style.textContent = `${meetCss}\n${embedCss}`;
    shadow.appendChild(style);

    // Mount point that plays the role meet.css gives <body> (flex-centered column + mesh).
    const mount = document.createElement("div");
    mount.className = "meet-embed-root";
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
      // Defer unmount out of the effect cleanup (React forbids unmounting a root while
      // rendering); then drop the shadow's children so a re-mount starts clean.
      const node = mount;
      const r = root;
      queueMicrotask(() => {
        r.unmount();
        node.remove();
        style.remove();
      });
    };
  }, []);

  return <div ref={hostRef} style={{ flex: 1, width: "100%", display: "block" }} />;
}
