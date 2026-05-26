import { useState, type KeyboardEvent } from "react";

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

/** Click → press a combo → emits `<ctrl>+<space>`-style string. */
export function HotkeyCapture({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);

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
    <button
      type="button"
      className={`sub-tab ${capturing ? "onb-primary" : ""}`}
      style={{ minWidth: 160 }}
      onClick={() => setCapturing(true)}
      onBlur={() => setCapturing(false)}
      onKeyDown={onKeyDown}
    >
      {capturing ? "Taste drücken…" : value || "Hotkey setzen"}
    </button>
  );
}
