import React from "react";
import ReactDOM from "react-dom/client";
import { PromptConsole } from "./PromptConsole";
import "../i18n"; // separate webview/root — needs its own i18n init
import "../styles/tokens.css";
import "./prompt.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PromptConsole />
  </React.StrictMode>,
);
