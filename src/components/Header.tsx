import { useEffect, useState } from "react";
import { appVersion } from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";
import { BrandMark } from "./BrandMark";

export function Header() {
  const { config } = useConfig();
  const [version, setVersion] = useState("");

  useEffect(() => {
    appVersion().then((v) => setVersion(v)).catch(() => {});
  }, []);

  const plan = config?.plan ?? "free";
  const planClass = plan === "pro" ? "pro" : plan === "trial" ? "trial" : "";

  return (
    <header className="header">
      <div className="brand">
        <BrandMark size={22} />
        Echo
      </div>
      {version && <span className="version">v{version}</span>}
      <div className="spacer" />
      <span className={`plan-badge ${planClass}`}>{plan}</span>
    </header>
  );
}
