import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfig } from "../state/ConfigContext";
import { useReducedMotion } from "./useReducedMotion";
import { Opening } from "./scenes/Opening";
import { Account } from "./scenes/Account";
import { Mic } from "./scenes/Mic";
import { Hotkey } from "./scenes/Hotkey";
import { Mode } from "./scenes/Mode";
import { Finale } from "./scenes/Finale";
import "./intro.css";

// First-run intro orchestrator: full-screen scenes over a drifting aurora.
// While mounted, the GLOBAL hotkey is suspended (hotkey.rs) — the OS
// registration would swallow the combo, so neither the virtual keyboard nor
// the finale's hold-to-dictate could see it, and a press would inject text
// into the Echo window itself. Completion re-registers it FIRST, then flips
// has_seen_onboarding (which unmounts us).

export type SceneId = "opening" | "account" | "mic" | "hotkey" | "mode" | "finale";
const ORDER: SceneId[] = ["opening", "account", "mic", "hotkey", "mode", "finale"];
const LEAVE_MS = 380;

export interface SceneProps {
  next: () => void;
  finish: () => void;
}

export function Intro() {
  const { t } = useTranslation();
  const { config, patch } = useConfig();
  const reduced = useReducedMotion();
  const [scene, setScene] = useState<SceneId>("opening");
  const [leaving, setLeaving] = useState(false);
  const timer = useRef(0);

  // Own the keyboard for the whole intro; idempotent, safe under StrictMode.
  useEffect(() => {
    invoke("hotkey_set_suspended", { suspended: true }).catch(() => {});
    return () => {
      window.clearTimeout(timer.current);
      invoke("hotkey_set_suspended", { suspended: false }).catch(() => {});
    };
  }, []);

  const go = useCallback(
    (target: SceneId) => {
      if (reduced) {
        setScene(target);
        return;
      }
      setLeaving(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setScene(target);
        setLeaving(false);
      }, LEAVE_MS);
    },
    [reduced],
  );

  const next = useCallback(() => {
    const i = ORDER.indexOf(scene);
    if (i < ORDER.length - 1) go(ORDER[i + 1]);
  }, [scene, go]);

  // Re-register the hotkey BEFORE flipping the flag — flipping unmounts us.
  const finish = useCallback(async () => {
    try {
      await invoke("hotkey_set_suspended", { suspended: false });
    } catch {
      /* re-register also happens on unmount + next launch */
    }
    await patch({ has_seen_onboarding: true });
  }, [patch]);

  if (!config) return null;

  const dotScenes = ORDER.slice(1); // opening has no dot
  const sceneIdx = ORDER.indexOf(scene);

  return (
    <div className={`intro ${scene === "opening" ? "is-opening" : ""}`}>
      <div className="intro-aurora" aria-hidden>
        <div className="intro-blob b1" />
        <div className="intro-blob b2" />
        <div className="intro-blob b3" />
      </div>

      {scene !== "finale" && (
        <div className="intro-skip">
          <button type="button" className="intro-ghost" onClick={finish}>
            {t("intro.skip")}
          </button>
        </div>
      )}

      <div className={`intro-scene ${leaving ? "is-leaving" : ""}`} key={scene}>
        {scene === "opening" && <Opening next={next} finish={finish} />}
        {scene === "account" && <Account next={next} finish={finish} />}
        {scene === "mic" && <Mic next={next} finish={finish} />}
        {scene === "hotkey" && <Hotkey next={next} finish={finish} />}
        {scene === "mode" && <Mode next={next} finish={finish} />}
        {scene === "finale" && <Finale next={next} finish={finish} />}
      </div>

      {scene !== "opening" && (
        <div className="intro-dots">
          {dotScenes.map((s) => {
            const idx = ORDER.indexOf(s);
            const past = idx < sceneIdx;
            return (
              <button
                type="button"
                key={s}
                aria-label={s}
                className={`${s === scene ? "is-on" : ""} ${past ? "is-past" : ""}`}
                onClick={past ? () => go(s) : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
