import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { appVersion } from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";
import { BrandMark } from "./BrandMark";
import { HeaderUpdate } from "./HeaderUpdate";

export function Header() {
  const { t } = useTranslation();
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
      <HeaderUpdate />
      <span className={`plan-badge ${planClass}`} title={t("header.planBadgeTitle")}>
        {t(`header.plan.${plan}`)}
      </span>
    </header>
  );
}
