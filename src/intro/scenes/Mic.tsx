import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listAudioDevices, onState } from "../../lib/ipc";
import { useConfig } from "../../state/ConfigContext";
import { VoiceCanvas } from "../VoiceCanvas";
import type { SceneProps } from "../Intro";

// Mic test as a stage: the voice canvas is the hero, the device picker sits
// beneath. A live recording runs while the scene is up (cancelled on leave so
// the intro never strands the recorder — same pattern as the old onboarding).
export function Mic({ next }: SceneProps) {
  const { t } = useTranslation();
  const { config, patch } = useConfig();
  const [devices, setDevices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [noSignal, setNoSignal] = useState(false);
  const heard = useRef(false);

  useEffect(() => {
    listAudioDevices().then(setDevices).catch(() => {});
  }, []);

  // Run the recorder for the level meter; restart when the device changes.
  useEffect(() => {
    setError(null);
    invoke("start_recording").catch(() => {});
    return () => {
      invoke("cancel_recording").catch(() => {});
    };
  }, [config?.mic_device_name]);

  // Mic failures (no device / busy / permission) surface as engine error states.
  useEffect(() => {
    const sub = onState((p) => {
      if (p.state === "error") setError(p.detail ?? "");
    });
    return () => {
      sub.then((un) => un());
    };
  }, []);

  // Gentle nudge when nothing has been heard for a while.
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (!heard.current) setNoSignal(true);
    }, 5000);
    return () => window.clearTimeout(id);
  }, [config?.mic_device_name]);

  const onLevel = useCallback((lvl: number) => {
    if (lvl > 0.04) {
      heard.current = true;
      setNoSignal(false);
    }
  }, []);

  if (!config) return null;

  return (
    <>
      <h1 className="intro-title">{t("intro.micTitle")}</h1>
      <p className="intro-body">{t("intro.micBody")}</p>
      <VoiceCanvas active height={150} onLevel={onLevel} />
      <div className="intro-rows">
        <div className="intro-row">
          <span>{t("settings.microphone")}</span>
          <select
            value={config.mic_device_name || ""}
            onChange={(e) => {
              heard.current = false;
              setNoSignal(false);
              patch({ mic_device_name: e.target.value });
            }}
          >
            <option value="">{t("settings.micSystemDefault")}</option>
            {devices.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error ? (
        <p className="intro-warn">{t("intro.micError", { detail: error })}</p>
      ) : noSignal ? (
        <p className="intro-warn">{t("intro.micNoSignal")}</p>
      ) : null}
      <div className="intro-nav">
        <button type="button" className="intro-btn" autoFocus onClick={next}>
          {t("intro.continue")}
        </button>
      </div>
    </>
  );
}
