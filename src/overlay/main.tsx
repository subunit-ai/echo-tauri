import React from "react";
import ReactDOM from "react-dom/client";
import { Orb } from "./Orb";
import "./overlay.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Orb />
  </React.StrictMode>,
);
