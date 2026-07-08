import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  comboFromEvent,
  conflictWarning,
  holdTargetOf,
  keyName,
  modifierName,
  parseCombo,
} from "../lib/hotkeys";
import { VirtualKeyboard, keyLabel } from "../intro/VirtualKeyboard";
import "../intro/intro.css";
import "./hotkey-keyboard.css";

const MODIFIERS = new Set(["ctrl", "shift", "alt", "cmd"]);
const IS_MAC = navigator.userAgent.includes("Mac");

/**
 * The full hotkey picker: click the field and the intro's illuminated keyboard
 * drops in. Press a key combo to bind it, OR click / hold a single key or
 * modifier (Control, Option, F6, …) to make it a "hold to dictate" hotkey. When
 * the pick is a lone key/modifier, a hold-duration slider appears — how long you
 * must hold it before dictation arms — since that path only works with the OS
 * Input-Monitoring grant, a permission notice surfaces if it's missing.
 */
export function HotkeyKeyboard({
  value,
  holdMs,
  onChange,
  onHoldMsChange,
}: {
  value: string;
  holdMs: number;
  onChange: (v: string) => void;
  onHoldMsChange: (ms: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pressed, setPressed] = useState<Set<string>>(() => new Set());
  const [sweepTick, setSweepTick] = useState(0);
  // null = not yet checked / not a hold hotkey; true/false = Input-Monitoring grant.
  const [permOk, setPermOk] = useState<boolean | null>(null);

  const hold = holdTargetOf(value);
  const warning = conflictWarning(value);
  const highlighted = useMemo(() => new Set(parseCombo(value)), [value]);

  // Gesture tracking so a lone modifier press→release can be told apart from a
  // combo (a second key/modifier "taints" it into a combo).
  const gesture = useRef<{ mod: string | null; tainted: boolean }>({ mod: null, tainted: false });

  const checkPermission = useCallback(async (combo: string) => {
    if (!IS_MAC || !holdTargetOf(combo)) {
      setPermOk(null);
      return;
    }
    try {
      setPermOk(await invoke<boolean>("hotkey_hold_permission"));
    } catch {
      setPermOk(null);
    }
  }, []);

  const commit = useCallback(
    (combo: string) => {
      onChange(combo);
      void checkPermission(combo);
    },
    [onChange, checkPermission],
  );

  // Light wave when the keyboard drops in; check permission for the current pick.
  useEffect(() => {
    if (!open) return;
    setSweepTick((n) => n + 1);
    void checkPermission(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Physical key capture — mirrors the intro scene, plus lone-modifier binding.
  useEffect(() => {
    if (!open) return;
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") return; // let Esc close the modal
      e.preventDefault();
      const modName = modifierName(e.key);
      const keyTok = keyName(e);
      const token = modName ?? keyTok;
      if (token) {
        setPressed((prev) => (prev.has(token) ? prev : new Set(prev).add(token)));
      }
      if (keyTok) {
        // A real key is down → a combo (or a lone key). Bind it.
        const combo = comboFromEvent(e);
        if (combo) commit(combo);
        gesture.current.tainted = true;
      } else if (modName) {
        if (gesture.current.mod === null) gesture.current = { mod: modName, tainted: false };
        else gesture.current.tainted = true; // a second modifier → heading for a combo
      }
    };
    const up = (e: KeyboardEvent) => {
      const modName = modifierName(e.key);
      const keyTok = keyName(e);
      const token = modName ?? keyTok;
      // Cleanly released a lone modifier → bind it as a hold hotkey.
      if (modName && gesture.current.mod === modName && !gesture.current.tainted) {
        commit(`<${modName}>`);
      }
      setPressed((prev) => {
        const nextSet = new Set(prev);
        if (token) nextSet.delete(token);
        // macOS drops letter keyups while ⌘ is held — clear all when the last
        // modifier lifts so nothing stays stuck lit.
        if (token && MODIFIERS.has(token) && ![...nextSet].some((k) => MODIFIERS.has(k))) {
          nextSet.clear();
        }
        if (nextSet.size === 0) gesture.current = { mod: null, tainted: false };
        return nextSet;
      });
    };
    const blur = () => {
      setPressed(new Set());
      gesture.current = { mod: null, tainted: false };
    };
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [open, commit]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const requestPermission = async () => {
    try {
      const granted = await invoke<boolean>("hotkey_request_hold_permission");
      setPermOk(granted);
    } catch {
      /* ignore */
    }
  };

  const chips = parseCombo(value);

  return (
    <>
      <button
        type="button"
        className="hk-field"
        onClick={() => setOpen(true)}
        title={t("hotkey.setHotkey")}
      >
        {chips.length ? (
          <span className="hk-chips">
            {chips.map((k, i) => (
              <span className="hk-chip" key={`${k}-${i}`}>
                {keyLabel(k)}
              </span>
            ))}
          </span>
        ) : (
          <span className="hk-empty">{t("hotkey.setHotkey")}</span>
        )}
      </button>

      {open && (
        <div className="confirm-backdrop" onClick={() => setOpen(false)}>
          <div
            className="hk-card"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="hk-title">{t("hotkey.pickerTitle")}</h3>
            <p className="hk-sub">{t("hotkey.pickerBody")}</p>

            <VirtualKeyboard
              pressed={pressed}
              highlighted={highlighted}
              sweepTick={sweepTick}
              onKeyPick={(id) => commit(`<${id}>`)}
            />

            <div className="hk-current">
              <span className="hk-current-label">{t("hotkey.current")}</span>
              <span className="hk-chips">
                {chips.length ? (
                  chips.map((k, i) => (
                    <span className="hk-chip is-lit-chip" key={`${k}-${i}`}>
                      {keyLabel(k)}
                    </span>
                  ))
                ) : (
                  <span className="hk-empty">{t("hotkey.pressKey")}</span>
                )}
              </span>
            </div>

            {hold && (
              <div className="hk-hold">
                <div className="hk-hold-head">
                  <span>{t("hotkey.holdDuration")}</span>
                  <span className="hk-hold-val">{holdMs} ms</span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={1000}
                  step={25}
                  value={holdMs}
                  onChange={(e) => onHoldMsChange(parseInt(e.target.value, 10))}
                />
                <p className="hk-hint">{t("hotkey.holdDurationHint")}</p>
              </div>
            )}

            {hold && permOk === false && (
              <div className="hk-perm">
                <p className="hk-perm-msg">{t("hotkey.permNeeded")}</p>
                <button type="button" className="hk-perm-btn" onClick={requestPermission}>
                  {t("hotkey.permGrant")}
                </button>
              </div>
            )}

            {warning && <p className="hk-warn">{warning}</p>}

            <div className="hk-actions">
              <button type="button" className="hk-done" onClick={() => setOpen(false)}>
                {t("hotkey.done")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
