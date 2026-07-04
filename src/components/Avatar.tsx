import { useMemo } from "react";

/** Initials-based profile picture (Slack/Google style) — no image upload infra
 *  needed, always looks intentional. The hue is DETERMINISTIC from the name so a
 *  given person always gets the same colour, and it's exposed as a CSS custom
 *  property (`--avatar-hue`) rather than a hard-coded gradient — that lets the
 *  colourless "Schwarz" theme override `.avatar` to neutral grey (see app.css).
 *  Falls back to a neutral placeholder glyph when there's no name yet. */

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hp = (((h % 360) + 360) % 360) / 60;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hp < 1) [r, g] = [c, x];
  else if (hp < 2) [r, g] = [x, c];
  else if (hp < 3) [g, b] = [c, x];
  else if (hp < 4) [g, b] = [x, c];
  else if (hp < 5) [r, b] = [x, c];
  else [r, b] = [c, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

/** WCAG relative luminance of a 0–1 rgb triple. */
function relLum([r, g, b]: [number, number, number]): number {
  const f = (u: number) => (u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const contrast = (l1: number, l2: number) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

export function Avatar({
  name,
  size = 34,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const clean = name.trim();

  // Code-point aware so an emoji / astral-plane first letter doesn't split into a
  // lone surrogate (which renders as "�"). [...str] iterates by code point.
  const initials = useMemo(() => {
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "";
    if (parts.length === 1) return [...parts[0]].slice(0, 2).join("").toUpperCase();
    return ([...parts[0]][0] + [...parts[parts.length - 1]][0]).toUpperCase();
  }, [clean]);

  const hue = useMemo(() => {
    let h = 0;
    for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) % 360;
    return h;
  }, [clean]);

  // Pick the text colour (white vs near-black) from the ACTUAL gradient luminance
  // so initials stay legible for every hue — the yellow/green/cyan band is far too
  // bright for white text. Must mirror the gradient in app.css (same hue span 20°,
  // sat 74%, lightness 58% at both stops); those exact params were tuned so the
  // worst hue still clears 3:1 (large-bold) with either fg. Evaluate both stops and
  // choose whichever foreground keeps the higher worst-case contrast.
  const fg = useMemo(() => {
    const l1 = relLum(hslToRgb(hue, 0.74, 0.58));
    const l2 = relLum(hslToRgb(hue + 20, 0.74, 0.58));
    const whiteMin = Math.min(contrast(1, l1), contrast(1, l2));
    const darkLum = relLum([0.08, 0.09, 0.11]);
    const darkMin = Math.min(contrast(darkLum, l1), contrast(darkLum, l2));
    return whiteMin >= darkMin ? "#ffffff" : "#16181c";
  }, [hue]);

  return (
    <span
      className={`avatar ${initials ? "" : "avatar-empty"} ${className}`.trim()}
      style={
        {
          width: size,
          height: size,
          fontSize: Math.round(size * 0.4),
          "--avatar-hue": hue,
          "--avatar-fg": fg,
        } as React.CSSProperties
      }
      aria-hidden
    >
      {initials || (
        <svg width={Math.round(size * 0.52)} height={Math.round(size * 0.52)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" />
        </svg>
      )}
    </span>
  );
}
