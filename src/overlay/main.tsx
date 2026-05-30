import React from "react";
import ReactDOM from "react-dom/client";
import { OverlayRoot } from "./OverlayRoot";
import "../i18n"; // the overlay is a separate webview/root — needs its own i18n init
import "./overlay.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <OverlayRoot />
  </React.StrictMode>,
);
