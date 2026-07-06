import { useEffect, useState } from "react";
import { appVersion } from "../lib/ipc";
import { BrandMark } from "./BrandMark";
import { HeaderUpdate } from "./HeaderUpdate";

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
      {/* Plan (Free/Pro) moved to the account card (bottom-left). Top-right keeps
          the update pill; a notifications/inbox affordance can slot in here. */}
      <HeaderUpdate />
    </header>
  );
}
