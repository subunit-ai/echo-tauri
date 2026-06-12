import { useMemo } from "react";
import i18n from "../i18n";

// The illuminated glass keyboard — the intro's centerpiece. Key ids use the
// hotkey token vocabulary (ctrl/shift/alt/cmd/space/a–z/0–9/…) so `highlighted`
// can be fed straight from a parsed combo and `pressed` from DOM key events.
//
// Layout is presentational, not a text-input map: QWERTZ for German UI
// language, QWERTY otherwise; modifier row per platform (⌃⌥⌘ on macOS).

interface KeyDef {
  id: string;
  label: string;
  w?: number; // width in flex units, default 1
}

const IS_MAC = navigator.userAgent.includes("Mac");

function layoutRows(qwertz: boolean): KeyDef[][] {
  const r2 = qwertz ? "qwertzuiop" : "qwertyuiop";
  const r4 = qwertz ? "yxcvbnm" : "zxcvbnm";
  const letters = (s: string): KeyDef[] =>
    Array.from(s).map((c) => ({ id: c, label: c.toUpperCase() }));
  const mods: KeyDef[] = IS_MAC
    ? [
        { id: "ctrl", label: "⌃", w: 1.2 },
        { id: "alt", label: "⌥", w: 1.2 },
        { id: "cmd", label: "⌘", w: 1.4 },
        { id: "space", label: "", w: 5 },
        { id: "cmd", label: "⌘", w: 1.4 },
        { id: "alt", label: "⌥", w: 1.2 },
      ]
    : [
        { id: "ctrl", label: "Ctrl", w: 1.4 },
        { id: "cmd", label: "Win", w: 1.2 },
        { id: "alt", label: "Alt", w: 1.2 },
        { id: "space", label: "", w: 5 },
        { id: "alt", label: "Alt", w: 1.2 },
        { id: "ctrl", label: "Ctrl", w: 1.4 },
      ];
  return [
    [
      { id: "esc", label: "esc", w: 1.3 },
      ...letters("1234567890"),
      { id: "backspace", label: "⌫", w: 1.7 },
    ],
    [{ id: "tab", label: "tab", w: 1.6 }, ...letters(r2), { id: "_pad1", label: "", w: 1.4 }],
    [
      { id: "_caps", label: "caps", w: 1.9 },
      ...letters("asdfghjkl"),
      { id: "enter", label: "⏎", w: 2.1 },
    ],
    [
      { id: "shift", label: "⇧", w: 2.5 },
      ...letters(r4),
      { id: "shift", label: "⇧", w: 3.5 },
    ],
    mods,
  ];
}

/** Human-readable keycap labels for combo chips ("ctrl" → "⌃" on macOS). */
export function keyLabel(token: string): string {
  if (IS_MAC) {
    const mac: Record<string, string> = { ctrl: "⌃", alt: "⌥", cmd: "⌘", shift: "⇧" };
    if (mac[token]) return mac[token];
  }
  const named: Record<string, string> = {
    ctrl: "Ctrl",
    alt: "Alt",
    cmd: "Cmd",
    shift: "Shift",
    space: "Space",
    enter: "⏎",
    esc: "esc",
    backspace: "⌫",
    tab: "tab",
  };
  return named[token] ?? token.toUpperCase();
}

export function VirtualKeyboard({
  pressed,
  highlighted,
  sweepTick = 0,
}: {
  /** Keys physically held right now — bright glow + depress. */
  pressed: Set<string>;
  /** Keys of the configured combo — persistent breathing glow. */
  highlighted: Set<string>;
  /** Increment to (re)trigger the light wave sweeping across the keys. */
  sweepTick?: number;
}) {
  const rows = useMemo(() => layoutRows(i18n.language.startsWith("de")), []);

  // Column position per key (sum of widths to its left) drives the wave delay.
  return (
    <div className={`vk ${sweepTick > 0 ? "is-sweeping" : ""}`} key={sweepTick} aria-hidden>
      {rows.map((row, ri) => {
        let col = 0;
        return (
          <div className="vk-row" key={ri}>
            {row.map((k, ki) => {
              const myCol = col;
              col += k.w ?? 1;
              const decorative = k.id.startsWith("_");
              const cls = [
                "vk-key",
                !decorative && pressed.has(k.id) ? "is-pressed" : "",
                !decorative && highlighted.has(k.id) ? "is-lit" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <div
                  className={cls}
                  key={`${k.id}-${ki}`}
                  style={{ "--w": k.w ?? 1, "--col": myCol } as React.CSSProperties}
                >
                  {k.label}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
