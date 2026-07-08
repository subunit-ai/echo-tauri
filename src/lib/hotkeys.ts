import i18n from "../i18n";

// Shared hotkey helpers: map JS key events to the token vocabulary the Rust
// accelerator parser understands (`<ctrl>+<space>`-style combos). Used by the
// Settings HotkeyCapture and the intro's virtual keyboard / finale.

/** Minimal structural event type — works for React and native KeyboardEvent. */
export interface KeyLike {
  key: string;
  /** Physical-key code (e.g. "KeyD"); preferred for letters/digits because on
   *  macOS `key` reports the COMPOSED character for Option-combos (⌥D → "∂"),
   *  which the global-shortcut parser could never register. */
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const MODIFIER_KEYS: Record<string, string> = {
  Control: "ctrl",
  Shift: "shift",
  Alt: "alt",
  Meta: "cmd",
};

/** Token for a pure-modifier key press ("Control" → "ctrl"), null otherwise. */
export function modifierName(key: string): string | null {
  return MODIFIER_KEYS[key] ?? null;
}

/** Map a key event to the non-modifier token; null while only modifiers are down. */
export function keyName(e: KeyLike): string | null {
  const k = e.key;
  if (MODIFIER_KEYS[k]) return null; // pure modifier — keep waiting
  // Letters/digits via the PHYSICAL code: with Option/Shift held, `key` is the
  // composed character (⌥D → "∂", ⇧2 → "\"") — useless as an accelerator token.
  const code = e.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (k === " " || k === "Spacebar" || code === "Space") return "space";
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
  return k.toLowerCase(); // F-keys (f1…) and the rest
}

/** Modifier tokens currently held, in canonical order. */
export function modsOf(e: KeyLike): string[] {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  if (e.metaKey) parts.push("cmd");
  return parts;
}

/** Full combo string from an event (`<ctrl>+<space>`); null on pure modifiers. */
export function comboFromEvent(e: KeyLike): string | null {
  const name = keyName(e);
  if (!name) return null;
  return [...modsOf(e), name].map((p) => `<${p}>`).join("+");
}

/** Canonical token spelling — the Rust parser accepts aliases ("option",
 *  "win", "meta"); UI consumers (virtual keyboard, chips) want one id each. */
export function normalizeToken(t: string): string {
  const aliases: Record<string, string> = {
    control: "ctrl",
    commandorcontrol: "ctrl",
    cmdorctrl: "ctrl",
    option: "alt",
    command: "cmd",
    meta: "cmd",
    super: "cmd",
    win: "cmd",
    windows: "cmd",
    return: "enter",
    escape: "esc",
  };
  return aliases[t] ?? t;
}

/** `<ctrl>+<space>` → ["ctrl", "space"] (normalized). Tolerates whitespace. */
export function parseCombo(combo: string): string[] {
  return combo
    .split("+")
    .map((raw) =>
      normalizeToken(raw.trim().replace(/^</, "").replace(/>$/, "").trim().toLowerCase()),
    )
    .filter((t) => t.length > 0);
}

const MODIFIER_TOKENS = new Set(["ctrl", "shift", "alt", "cmd"]);

/** Is `combo` a single token (one bare modifier or one key)? These take the
 *  "hold to dictate" path (event tap) instead of the OS combo shortcut — mirrors
 *  Rust `hold_key::parse_target`. Returns the token kind, or null for combos. */
export function holdTargetOf(combo: string): { kind: "modifier" | "key"; token: string } | null {
  const tokens = parseCombo(combo);
  if (tokens.length !== 1) return null;
  const token = tokens[0];
  return { kind: MODIFIER_TOKENS.has(token) ? "modifier" : "key", token };
}

/** A single modifier held alone → its token ("ctrl"), else null. Lets the picker
 *  capture a lone Control/Option as a hold hotkey (which `comboFromEvent` — built
 *  for combos — deliberately rejects). */
export function bareModifierFromEvent(e: KeyLike): string | null {
  if (modifierName(e.key) === null) return null; // not a modifier key at all
  // Exactly one modifier flag may be down (the one being pressed); no others.
  const mods = modsOf(e);
  if (mods.length > 1) return null;
  return modifierName(e.key);
}

/** Flag obviously-problematic hotkeys before the user commits one. */
export function conflictWarning(combo: string): string | null {
  if (!combo) return null;
  const c = combo.toLowerCase();
  // A single key/modifier is an intentional "hold to dictate" hotkey now, not a
  // mistake — no missing-modifier scolding for it.
  if (holdTargetOf(combo)) return null;
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
