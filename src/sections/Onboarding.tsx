import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BigModeSwitch } from "../components/BigModeSwitch";
import { BrandMark } from "../components/BrandMark";
import { HotkeyCapture } from "../components/HotkeyCapture";
import { Toggle } from "../components/Toggle";
import { listAudioDevices, patchForUiMode, uiModeOf } from "../lib/ipc";
import { LANGUAGES } from "../lib/languages";
import { useConfig } from "../state/ConfigContext";

// Step indices.
const WELCOME = 0;
const ACCOUNT = 1;
const MIC = 2;
const HOTKEY = 3;
const MODE = 4;
const LAST = MODE;

export function Onboarding() {
  const { t } = useTranslation();
  const { config, patch, reload } = useConfig();
  const [step, setStep] = useState(WELCOME);
  const [devices, setDevices] = useState<string[]>([]);
  const [level, setLevel] = useState(0);
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    listAudioDevices().then(setDevices).catch(() => {});
  }, []);

  // Live mic test: while on the MIC step, run the recorder and poll the level so
  // the user can confirm their mic actually picks up sound. Always cancelled on
  // leave/unmount so onboarding never leaves a recording running.
  useEffect(() => {
    if (step !== MIC || !config) {
      setLevel(0);
      return;
    }
    let active = true;
    invoke("start_recording").catch(() => {});
    const id = window.setInterval(async () => {
      try {
        const l = await invoke<number>("mic_level");
        if (active) setLevel(l);
      } catch {
        /* ignore */
      }
    }, 80);
    return () => {
      active = false;
      window.clearInterval(id);
      invoke("cancel_recording").catch(() => {});
    };
    // Restart the test when the chosen device changes.
  }, [step, config?.mic_device_name]);

  if (!config) return null;
  const c = config;

  const doLogin = async () => {
    setLoggingIn(true);
    try {
      await invoke("login");
      await reload();
    } catch (e) {
      console.error("onboarding login failed", e);
    } finally {
      setLoggingIn(false);
    }
  };

  return (
    <div className="onb">
      <div className="onb-card">
        {step === WELCOME && (
          <>
            <BrandMark size={56} />
            <h1>{t("onb.welcomeTitle")}</h1>
            <p>{t("onb.welcomeBody")}</p>
          </>
        )}

        {step === ACCOUNT && (
          <>
            <h1>{t("onb.accountTitle")}</h1>
            <p>{t("onb.accountBody")}</p>
            {c.account_email ? (
              <p className="hint">{t("onb.accountSignedIn", { email: c.account_email })}</p>
            ) : (
              <>
                <button className="sub-tab onb-primary" onClick={doLogin} disabled={loggingIn}>
                  {loggingIn ? t("settings.browserOpened") : t("settings.signIn")}
                </button>
                <p className="hint">{t("onb.accountSkipHint")}</p>
              </>
            )}
          </>
        )}

        {step === MIC && (
          <>
            <h1>{t("onb.micTitle")}</h1>
            <p>{t("onb.micBody")}</p>
            <div className="onb-row">
              <span>{t("settings.microphone")}</span>
              <select
                value={c.mic_device_name || ""}
                onChange={(e) => patch({ mic_device_name: e.target.value })}
              >
                <option value="">{t("settings.micSystemDefault")}</option>
                {devices.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div className="level-track" style={{ marginTop: 16 }}>
              <div className="level-fill" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
          </>
        )}

        {step === HOTKEY && (
          <>
            <h1>{t("onb.hotkeyTitle")}</h1>
            <p>{t("onb.hotkeyBody")}</p>
            <div className="onb-row">
              <span>{t("settings.hotkey")}</span>
              <HotkeyCapture value={c.hotkey} onChange={(v) => patch({ hotkey: v })} />
            </div>
            <p className="hint">{t("onb.hotkeyChangeable")}</p>
          </>
        )}

        {step === MODE && (
          <>
            <h1>{t("onb.modeTitle")}</h1>
            <p className="hint">{t("onb.modeBody")}</p>
            <BigModeSwitch value={uiModeOf(c)} onChange={(m) => patch(patchForUiMode(m))} />
            <div className="onb-row" style={{ marginTop: 18 }}>
              <span>{t("settings.transcriptionLanguage")}</span>
              <select value={c.language} onChange={(e) => patch({ language: e.target.value })}>
                {LANGUAGES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="onb-row">
              <span>{t("settings.autoPaste")}</span>
              <Toggle checked={c.autopaste} onChange={(v) => patch({ autopaste: v })} />
            </div>
            <div className="onb-row">
              <span>{t("settings.aiCleanup")}</span>
              <Toggle checked={c.cleanup_enabled} onChange={(v) => patch({ cleanup_enabled: v })} />
            </div>
          </>
        )}

        <div className="onb-dots">
          {[WELCOME, ACCOUNT, MIC, HOTKEY, MODE].map((i) => (
            <span key={i} className={i === step ? "on" : ""} />
          ))}
        </div>
        <div className="onb-nav">
          {step > WELCOME ? (
            <button className="sub-tab" onClick={() => setStep(step - 1)}>
              {t("common.back")}
            </button>
          ) : (
            <span />
          )}
          {step < LAST ? (
            <button className="sub-tab onb-primary" onClick={() => setStep(step + 1)}>
              {step === WELCOME ? t("onb.getStarted") : t("common.next")}
            </button>
          ) : (
            <button
              className="sub-tab onb-primary"
              onClick={() => patch({ has_seen_onboarding: true })}
            >
              {t("common.done")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
