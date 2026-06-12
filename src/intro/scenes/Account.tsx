import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfig } from "../../state/ConfigContext";
import type { SceneProps } from "../Intro";

export function Account({ next }: SceneProps) {
  const { t } = useTranslation();
  const { config, reload } = useConfig();
  const [loggingIn, setLoggingIn] = useState(false);

  if (!config) return null;

  const doLogin = async () => {
    setLoggingIn(true);
    try {
      await invoke("login");
      await reload();
    } catch (e) {
      console.error("intro login failed", e);
    } finally {
      setLoggingIn(false);
    }
  };

  return (
    <>
      <h1 className="intro-title">{t("intro.accountTitle")}</h1>
      <p className="intro-body">{t("intro.accountBody")}</p>
      {config.account_email ? (
        <>
          <p className="intro-hint">
            {t("intro.accountSignedIn", { email: config.account_email })}
          </p>
          <div className="intro-nav">
            <button type="button" className="intro-btn" autoFocus onClick={next}>
              {t("intro.continue")}
            </button>
          </div>
        </>
      ) : (
        <div className="intro-nav">
          <button type="button" className="intro-ghost" onClick={next}>
            {t("intro.accountSkip")}
          </button>
          <button
            type="button"
            className="intro-btn"
            autoFocus
            onClick={doLogin}
            disabled={loggingIn}
          >
            {loggingIn ? t("settings.browserOpened") : t("settings.signIn")}
          </button>
        </div>
      )}
    </>
  );
}
