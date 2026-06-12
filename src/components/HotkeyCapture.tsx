import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { comboFromEvent, conflictWarning } from "../lib/hotkeys";

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
    const combo = comboFromEvent(e);
    if (!combo) return; // pure modifier — keep waiting
    onChange(combo);
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
