import { useTranslation } from "react-i18next";
import { BigModeSwitch } from "../../components/BigModeSwitch";
import { Toggle } from "../../components/Toggle";
import { patchForUiMode, uiModeOf } from "../../lib/ipc";
import { LANGUAGES } from "../../lib/languages";
import { useConfig } from "../../state/ConfigContext";
import type { SceneProps } from "../Intro";

export function Mode({ next }: SceneProps) {
  const { t } = useTranslation();
  const { config, patch } = useConfig();
  if (!config) return null;

  return (
    <>
      <h1 className="intro-title">{t("intro.modeTitle")}</h1>
      <p className="intro-body">{t("intro.modeBody")}</p>
      <BigModeSwitch value={uiModeOf(config)} onChange={(m) => patch(patchForUiMode(m))} />
      <div className="intro-rows">
        <div className="intro-row">
          <span>{t("settings.transcriptionLanguage")}</span>
          <select
            value={config.language}
            onChange={(e) => patch({ language: e.target.value })}
          >
            {LANGUAGES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="intro-row">
          <span>{t("settings.autoPaste")}</span>
          <Toggle checked={config.autopaste} onChange={(v) => patch({ autopaste: v })} />
        </div>
        <div className="intro-row">
          <span>{t("settings.aiCleanup")}</span>
          <Toggle
            checked={config.cleanup_enabled}
            onChange={(v) => patch({ cleanup_enabled: v })}
          />
        </div>
      </div>
      <div className="intro-nav">
        <button type="button" className="intro-btn" autoFocus onClick={next}>
          {t("intro.continue")}
        </button>
      </div>
    </>
  );
}
