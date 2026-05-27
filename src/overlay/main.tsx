import React from "react";
import ReactDOM from "react-dom/client";
import { OverlayRoot } from "./OverlayRoot";
import "./overlay.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <OverlayRoot />
  </React.StrictMode>,
);
