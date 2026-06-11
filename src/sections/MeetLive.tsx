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

// Auto-fit: meet-ui is designed mobile/touch-sized, which reads as "too zoomed in" inside
// Echo's desktop pane. Scale the content so it always fits the pane nicely. zoom (not
// transform) reflows, so scrolling/layout stay correct. Tunable: DESIGN_W is the pane width
// at which meet shows at ~full size; below that it scales down, never up past 1.
const DESIGN_W = 760;
const MIN_ZOOM = 0.58;
function fitZoom(paneWidth: number): number {
  return Math.max(MIN_ZOOM, Math.min(1, paneWidth / DESIGN_W));
}

/**
 * Meeting view — renders the shared meet-ui app NATIVELY inside Echo (no iframe, no network
 * load), in a Shadow DOM. Looks identical to meet.subunit.ai (meet keeps its own frosted-
 * glass theme); auto-fits to the pane and lets meet's own dark-mode toggle work.
 *
 * - Isolation: meet.css scoped to the shadow; `transform` on :host confines meet's
 *   position:fixed chrome to this pane.
 * - Auto-fit: a ResizeObserver scales `.meet-root` (zoom) to the pane width.
 * - Theme: meet's toggle flips `html.dark` on the document; a MutationObserver mirrors that
 *   onto the shadow host (`:host(.dark)`) so the toggle actually themes the embedded UI.
 * - Auth: the subunit token is read over the `meet_token` IPC → host lands logged in.
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

    // Auto-fit the mobile-sized UI to the pane (sets --meet-zoom, used by .meet-root).
    const applyZoom = () => host.style.setProperty("--meet-zoom", String(fitZoom(host.clientWidth)));
    applyZoom();
    const ro = new ResizeObserver(applyZoom);
    ro.observe(host);

    // Mirror the document's dark class onto the shadow host so meet's theme toggle (which
    // flips html.dark) actually themes the embedded UI (:host(.dark)).
    const syncDark = () => host.classList.toggle("dark", document.documentElement.classList.contains("dark"));
    syncDark();
    const mo = new MutationObserver(syncDark);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      ro.disconnect();
      mo.disconnect();
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
