import React from "react";
import ReactDOM from "react-dom/client";
import { PromptConsole } from "./PromptConsole";
import "../i18n"; // separate webview/root — needs its own i18n init
import "../styles/tokens.css";
import "./prompt.css";

// Windows has no reliable window vibrancy (Acrylic is flaky on ARM / older GPUs),
// so the very-transparent glass shell can render nearly invisible there. Tag the
// platform → CSS gives Windows a solid (still glassy) backdrop so the console is
// always clearly visible. macOS keeps the see-through vibrancy look.
if (navigator.userAgent.includes("Windows")) {
  document.documentElement.classList.add("is-windows");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PromptConsole />
  </React.StrictMode>,
);
