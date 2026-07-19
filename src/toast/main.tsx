import React from "react";
import ReactDOM from "react-dom/client";
import { ToastRoot } from "./ToastRoot";
import "../i18n"; // separate webview/root — needs its own i18n init
import "../styles/tokens.css"; // the banner styles read the design tokens
import "../styles/xpbanner.css";
import "./toast.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ToastRoot />
  </React.StrictMode>,
);
