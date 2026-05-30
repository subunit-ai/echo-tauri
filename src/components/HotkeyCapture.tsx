import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";

// Map a JS key event to the token the Rust accelerator parser understands.
function keyName(e: KeyboardEvent): string | null {
  const k = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(k)) return null; // pure modifier — keep waiting
  if (k === " " || k === "Spacebar") return "space";
  const map: Record<string, string> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    Enter: "enter",
    Escape: "esc",
    Tab: "tab",
    Backspace: "backspace",
    Delete: "delete",
  };
  if (map[k]) return map[k];
  return k.toLowerCase(); // letters, digits, F-keys (f1…)
}

// Flag obviously-problematic hotkeys before the user commits one.
function conflictWarning(combo: string): string | null {
  if (!combo) return null;
  const c = combo.toLowerCase();
  const hasModifier = /<ctrl>|<shift>|<alt>|<cmd>/.test(c);
  if (!hasModifier) return i18n.t("hotkey.noModifierWarning");
  // Well-known OS/app shortcuts that would clash badly.
  const clashes: [RegExp, string][] = [
    [/<ctrl>\+<c>$|<ctrl>\+<v>$|<ctrl>\+<x>$|<ctrl>\+<z>$/, i18n.t("hotkey.clashCopyPaste")],
    [/<alt>\+<tab>$/, i18n.t("hotkey.clashWindowSwitch")],
    [/<cmd>\+<space>$/, i18n.t("hotkey.clashSpotlight")],
    [/<ctrl>\+<shift>\+<esc>$/, i18n.t("hotkey.clashTaskManager")],
  ];
  for (const [re, msg] of clashes) if (re.test(c)) return i18n.t("hotkey.clashPrefix", { msg });
  return null;
}

/** Click → press a combo → emits `<ctrl>+<space>`-style string. */
export function HotkeyCapture({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [capturing, setCapturing] = useState(false);
  const warning = conflictWarning(value);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!capturing) return;
    e.preventDefault();
    const name = keyName(e);
    if (!name) return;
    const parts: string[] = [];
    if (e.ctrlKey) parts.push("ctrl");
    if (e.shiftKey) parts.push("shift");
    if (e.altKey) parts.push("alt");
    if (e.metaKey) parts.push("cmd");
    parts.push(name);
    onChange(parts.map((p) => `<${p}>`).join("+"));
    setCapturing(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
      <button
        type="button"
        className={`sub-tab ${capturing ? "onb-primary" : ""}`}
        style={{ minWidth: 160 }}
        onClick={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        onKeyDown={onKeyDown}
      >
        {capturing ? t("hotkey.pressKey") : value || t("hotkey.setHotkey")}
      </button>
      {warning && !capturing && (
        <span style={{ fontSize: 11, color: "#ffc450", maxWidth: 220, textAlign: "right" }}>
          {warning}
        </span>
      )}
    </div>
  );
}
