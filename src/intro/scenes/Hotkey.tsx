import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  comboFromEvent,
  conflictWarning,
  keyName,
  modifierName,
  parseCombo,
} from "../../lib/hotkeys";
import { useConfig } from "../../state/ConfigContext";
import { VirtualKeyboard, keyLabel } from "../VirtualKeyboard";
import type { SceneProps } from "../Intro";

const MODIFIERS = new Set(["ctrl", "shift", "alt", "cmd"]);

// The keyboard scene: every physical key press lights its virtual twin (the
// global hotkey is suspended for the whole intro, so even the combo itself
// reaches the DOM). "Set my hotkey" arms capture — the next full combo is
// stored and its keys keep glowing.
export function Hotkey({ next }: SceneProps) {
  const { t } = useTranslation();
  const { config, patch } = useConfig();
  const [pressed, setPressed] = useState<Set<string>>(() => new Set());
  const [capturing, setCapturing] = useState(false);
  const [sweepTick, setSweepTick] = useState(0);
  const capturingRef = useRef(capturing);
  capturingRef.current = capturing;

  // Light wave across the keys as the scene enters.
  useEffect(() => {
    const id = window.setTimeout(() => setSweepTick(1), 150);
    return () => window.clearTimeout(id);
  }, []);

  const combo = config?.hotkey ?? "";
  const highlighted = useMemo(() => new Set(parseCombo(combo)), [combo]);
  const warning = conflictWarning(combo);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Keep Tab/Space from moving focus or scrolling while the keyboard plays.
      e.preventDefault();
      const token = modifierName(e.key) ?? keyName(e);
      if (token) {
        setPressed((prev) => {
          if (prev.has(token)) return prev;
          const nextSet = new Set(prev);
          nextSet.add(token);
          return nextSet;
        });
      }
      if (capturingRef.current) {
        const c = comboFromEvent(e);
        if (c) {
          patch({ hotkey: c }); // safe mid-intro: re-register no-ops while suspended
          setCapturing(false);
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      const token = modifierName(e.key) ?? keyName(e);
      setPressed((prev) => {
        const nextSet = new Set(prev);
        if (token) nextSet.delete(token);
        // macOS suppresses letter keyups while ⌘ is held — when the last
        // modifier lifts, clear everything so no key sticks lit.
        if (token && MODIFIERS.has(token) && ![...nextSet].some((k) => MODIFIERS.has(k))) {
          return new Set<string>();
        }
        return nextSet;
      });
    };
    const blur = () => setPressed(new Set());
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [patch]);

  if (!config) return null;

  return (
    <>
      <h1 className="intro-title">{t("intro.hotkeyTitle")}</h1>
      <p className="intro-body">{t("intro.hotkeyBody")}</p>
      <VirtualKeyboard pressed={pressed} highlighted={highlighted} sweepTick={sweepTick} />
      <p className="intro-hint">
        {t("intro.hotkeySet")}{" "}
        <span className="intro-chips">
          {parseCombo(combo).map((k, i) => (
            <span className="intro-chip" key={`${k}-${i}`}>
              {keyLabel(k)}
            </span>
          ))}
        </span>
      </p>
      {warning && <p className="intro-warn">{warning}</p>}
      <div className="intro-nav">
        <button
          type="button"
          className="intro-ghost"
          onClick={() => setCapturing((v) => !v)}
        >
          {capturing ? t("intro.hotkeyPressNow") : t("intro.hotkeyCapture")}
        </button>
        <button type="button" className="intro-btn" onClick={next}>
          {t("intro.continue")}
        </button>
      </div>
      <p className="intro-hint">{t("intro.hotkeyChangeable")}</p>
    </>
  );
}
