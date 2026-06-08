import { createRoot } from "react-dom/client";
import { MeetApp } from "@meet/MeetApp";
import { applyTheme } from "@meet/lib/theme";
import "@meet/styles/meet.css";

// This is the meet.subunit.ai React app, mounted inside an iframe (meet.html) that Echo
// embeds in its content pane. Running it as its own document keeps meet.css fully isolated
// from Echo's shell (the sidebar stays put) while the look stays pixel-identical.

// Apply the saved meet theme before first paint — CSP (script-src 'self') forbids an inline
// anti-FOUC bootstrap, so do it here as the module loads.
try {
  applyTheme(localStorage.getItem("meet-theme") === "dark");
} catch {
  /* private mode — ignore */
}

// The subunit access token is owned by Echo's main window (which holds the Tauri IPC). This
// sub-frame receives it via postMessage — no Tauri API needed inside the iframe.
let resolveToken: (t: string | null) => void = () => {};
const tokenPromise = new Promise<string | null>((r) => {
  resolveToken = r;
});
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "meet-token") resolveToken(e.data.token ?? null);
});
// Tell the parent we're ready to receive the token.
try {
  parent.postMessage({ type: "meet-ready" }, "*");
} catch {
  /* ignore */
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <MeetApp authMode="embed" getEmbedToken={() => tokenPromise} />,
);
