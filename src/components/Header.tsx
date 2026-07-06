import { useEffect, useState } from "react";
import { appVersion } from "../lib/ipc";
import { BrandMark } from "./BrandMark";
import { Postfach } from "./Postfach";

export function Header() {
  const [version, setVersion] = useState("");

  useEffect(() => {
    appVersion().then((v) => setVersion(v)).catch(() => {});
  }, []);

  return (
    <header className="header">
      <div className="brand">
        <BrandMark size={22} />
        Echo
      </div>
      <span className="beta-badge">Beta</span>
      {version && <span className="version">v{version}</span>}
      <div className="spacer" />
      {/* Notifications inbox (top-right): folds in the app update + "what's new". */}
      <Postfach />
    </header>
  );
}
