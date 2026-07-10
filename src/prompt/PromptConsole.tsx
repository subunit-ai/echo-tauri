import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  currentMonitor,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { getConfig, setConfig } from "../lib/ipc";
import { setLanguage } from "../i18n";

/**
 * The Prompt Terminal — a floating Liquid-Glass window for drafting and
 * engineering prompts anywhere on the desktop (own Tauri window "prompt",
 * native vibrancy behind this view). Terminal-grade tab UX: drag-reorder,
 * pin (protect from close), duplicate, ⌘1–9 / ⌘T / ⌘W / ⌃Tab, plus a
 * command palette (⌘P).
 *
 * Window chrome (2026-07 remodel): the window silhouette is ONE continuous
 * SVG shape — pane + the ACTIVE tab, drawn with Chrome-style outward
 * shoulders, so the outline literally IS the tab. macOS gets traffic lights
 * (close/minimize genie into the pill, green zooms), Windows gets its
 * controls on the right. Open/close play a genie animation out of / into the
 * orb pill (see runGenie): the OS vibrancy is switched off around the flight
 * because that native blur layer ignores CSS transforms.
 *
 * Iron rule: NOTHING is ever lost. Every edit auto-saves (debounced) to
 * prompts.json via the `prompts_save` IPC; hiding the window only hides it;
 * deleting a non-empty draft archives it into the library instead of
 * destroying it; dictated transcripts ("Terminal als Ziel") ride a Rust-side
 * pending queue that survives the webview's first boot.
 */

interface Draft {
  id: string;
  title: string;
  text: string;
  updatedAt: number;
  /** Pinned tabs sort to the front, show a pin marker, and are protected from
   *  one-click / ⌘W close (unpin first). */
  pinned?: boolean;
}

interface PromptData {
  version: 1;
  activeId: string;
  drafts: Draft[];
  library: Draft[];
}

/** Clean stroke icons — no emojis in the terminal chrome (design rule). */
function Ico({ paths, filled = false, size = 13 }: { paths: string[]; filled?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

const ICONS = {
  mic: ["M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z", "M19 11a7 7 0 0 1-14 0", "M12 18v4"],
  pin: ["M9 3h6l-.7 6.2 3.2 3.3H6.5l3.2-3.3L9 3z", "M12 12.5V21"],
  x: ["M6 6l12 12", "M18 6L6 18"],
  bolt: ["M13 2L4.5 13.5H10l-1 8.5L19.5 10H13l1-8z"],
  lib: ["M4 19.5A2.5 2.5 0 0 1 6.5 17H20", "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"],
  trash: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v6", "M14 11v6"],
  drop: ["M12 2.7s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11z"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M21 21l-4.8-4.8"],
  dup: ["M9 9h10v10H9z", "M5 15H4V5h10v1"],
  cmd: ["M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"],
  spark: ["M12 3l2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1L12 3z"],
  eraser: ["M8 20H21", "M5.5 17.5L3 15a2 2 0 0 1 0-2.8l8.7-8.7a2 2 0 0 1 2.8 0l4 4a2 2 0 0 1 0 2.8L11.5 17.5H7z"],
  spell: ["M3 16l3-9 3 9", "M3.9 13h4.2", "M13 15l3 3 5-6"],
  check: ["M4 12.5l5 5L20 6.5"],
  micOn: ["M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z", "M19 11a7 7 0 0 1-14 0", "M12 18v3"],
  stop: ["M7 7h10v10H7z"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
};

/** Glass intensity levels — cycled from the header droplet. The CSS multiplies
 *  every shell/chip tint alpha by --pc-glass, so "clear" is genuinely more
 *  see-through, not just dimmer. */
const GLASS_LEVELS = ["clear", "regular", "rich"] as const;
type GlassLevel = (typeof GLASS_LEVELS)[number];
const GLASS_MUL: Record<GlassLevel, number> = { clear: 0.25, regular: 0.7, rich: 1.4 };
const asGlass = (v: string): GlassLevel =>
  (GLASS_LEVELS as readonly string[]).includes(v) ? (v as GlassLevel) : "clear";

const newDraft = (text = ""): Draft => ({
  id: crypto.randomUUID(),
  title: "",
  text,
  updatedAt: Date.now(),
});

const emptyData = (): PromptData => {
  const d = newDraft();
  return { version: 1, activeId: d.id, drafts: [d], library: [] };
};

function parseData(raw: string): PromptData {
  try {
    const p = JSON.parse(raw) as PromptData;
    if (!Array.isArray(p.drafts) || p.drafts.length === 0) return emptyData();
    if (!Array.isArray(p.library)) p.library = [];
    if (!p.drafts.some((d) => d.id === p.activeId)) p.activeId = p.drafts[0].id;
    return { ...p, version: 1 };
  } catch {
    return raw.trim() ? { ...emptyData(), drafts: [newDraft(raw)] } : emptyData();
  }
}

/** Tab label: explicit title > first words of the text > untitled. */
const tabLabel = (d: Draft, untitled: string) =>
  d.title.trim() || d.text.trim().slice(0, 16).trim() || untitled;

// ---- Prompt-Coach: autonomous context elicitation. ----
// Heuristic checks for the building blocks of a strong prompt (goal, role,
// context, format, audience, examples, constraints). Every unmet block turns
// into a QUESTION the terminal asks the user, plus a one-click template that
// scaffolds the missing piece — actively coaxing good context out of the user
// so the downstream AI can deliver. Local + instant (no network); an
// AI-powered refine on top is the planned next stage.
const COACH_KEYS = ["goal", "role", "context", "format", "audience", "examples", "constraints"] as const;
type CoachKey = (typeof COACH_KEYS)[number];

function analyzePrompt(text: string): Record<CoachKey, boolean> {
  const t = text.toLowerCase();
  const has = (re: RegExp) => re.test(t);
  return {
    goal: text.trim().length >= 25,
    role: has(/\b(du bist|you are|act as|agiere als|verhalte dich wie|als (erfahrene?r? )?(experte|expertin|profi)|rolle\s*:|role\s*:)/),
    context: has(/(kontext|hintergrund|context|background|situation|ausgangslage|gegeben)/) || text.trim().length >= 400,
    format:
      has(/(format|liste|tabelle|json|markdown|stichpunkt|bullet|gliederung|absatz|abschnitt|paragraph|table|list|outline)/) ||
      has(/(wörter|words|zeichen|characters|sätze|sentences|länge|length|seiten|pages)/),
    audience: has(/(zielgruppe|audience|leser|reader|für (anfänger|einsteiger|experten|kunden|kinder|laien|entwickler|beginners|experts|customers|developers))/),
    examples: has(/(z\.\s?b\.|beispiel|example|e\.\s?g\.|wie folgt|etwa so|zum beispiel|for instance)/),
    constraints: has(/(vermeide|avoid|verzichte|keinesfalls|auf keinen fall|don'?t|max\.|maximal|höchstens|mindestens|at (most|least)|\bstil\b|\bton\b|tonalität|\btone\b|grenzen|einschränkung)/),
  };
}

interface PalCmd {
  id: string;
  label: string;
  run: () => void;
}

// ---- Word-level diff for the AI-Coach "Refine" before/after view. ----
// Tokenize keeping whitespace so reconstruction is lossless, then LCS-diff the
// token streams. A heavy rewrite stays readable: kept words render plain,
// removed words struck through, added words highlighted.
type DiffSeg = { type: "same" | "add" | "del"; text: string };
const DIFF_TOKEN_CAP = 1200; // beyond this, skip the O(n·m) DP (see refine view)

const tokenizeDiff = (s: string) => s.split(/(\s+)/).filter((x) => x.length > 0);

function wordDiff(a: string, b: string): DiffSeg[] {
  const A = tokenizeDiff(a);
  const B = tokenizeDiff(b);
  // dp[i][j] = LCS length of A[i:] and B[j:].
  const dp: number[][] = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffSeg[] = [];
  const push = (type: DiffSeg["type"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) push("same", A[i++]), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) push("del", A[i++]);
    else push("add", B[j++]);
  }
  while (i < A.length) push("del", A[i++]);
  while (j < B.length) push("add", B[j++]);
  return out;
}

// ---- Window chrome geometry (logical px) -----------------------------------
// The silhouette below draws pane + active tab as ONE path, so keep these in
// sync with the .pc-strip / .pc-tab CSS.
const STRIP_H = 40; // chrome strip height — the pane's top edge sits here
const TAB_TOP = 6; // how far below the window top the active tab peaks
const TAB_R = 11; // tab top corner radius
const SHOULDER = 9; // outward flare radius where the tab meets the pane
const PANE_R = 22; // pane corner radius — matches the native vibrancy radius

const IS_WINDOWS = navigator.userAgent.includes("Windows");

/** One continuous window silhouette: the pane below the strip, with the ACTIVE
 *  tab rising through the strip as part of the same outline (Chrome-style
 *  outward shoulders). This is what makes the tab read as "the window". */
function silhouettePath(w: number, h: number, bump: { x: number; w: number } | null): string {
  const S = STRIP_H;
  let d = `M 0 ${h - PANE_R} L 0 ${S + PANE_R} A ${PANE_R} ${PANE_R} 0 0 1 ${PANE_R} ${S}`;
  if (bump) {
    // Clamp the bump inside the pane's top edge (a tab scrolled half out of
    // view must not push the outline past the corner arcs).
    const min = PANE_R + SHOULDER + 2;
    const max = w - PANE_R - SHOULDER - 2;
    const bx = Math.min(Math.max(bump.x, min), Math.max(min, max - 40));
    const bxe = Math.min(Math.max(bx + bump.w, bx + 40), max);
    d +=
      ` L ${bx - SHOULDER} ${S}` +
      ` A ${SHOULDER} ${SHOULDER} 0 0 0 ${bx} ${S - SHOULDER}` +
      ` L ${bx} ${TAB_TOP + TAB_R}` +
      ` A ${TAB_R} ${TAB_R} 0 0 1 ${bx + TAB_R} ${TAB_TOP}` +
      ` L ${bxe - TAB_R} ${TAB_TOP}` +
      ` A ${TAB_R} ${TAB_R} 0 0 1 ${bxe} ${TAB_TOP + TAB_R}` +
      ` L ${bxe} ${S - SHOULDER}` +
      ` A ${SHOULDER} ${SHOULDER} 0 0 0 ${bxe + SHOULDER} ${S}`;
  }
  d +=
    ` L ${w - PANE_R} ${S} A ${PANE_R} ${PANE_R} 0 0 1 ${w} ${S + PANE_R}` +
    ` L ${w} ${h - PANE_R} A ${PANE_R} ${PANE_R} 0 0 1 ${w - PANE_R} ${h}` +
    ` L ${PANE_R} ${h} A ${PANE_R} ${PANE_R} 0 0 1 0 ${h - PANE_R} Z`;
  return d;
}

/** The recessed chrome strip behind the tabs (full width, rounded top). Drawn
 *  masked so it never doubles up under the silhouette. */
function stripPath(w: number): string {
  const r = 16;
  return `M 0 ${STRIP_H} L 0 ${r} A ${r} ${r} 0 0 1 ${r} 0 L ${w - r} 0 A ${r} ${r} 0 0 1 ${w} ${r} L ${w} ${STRIP_H} Z`;
}

/** The window body as SVG: recessed strip + (pane ⋃ active tab) silhouette with
 *  a gradient rim. Fills scale with the glass level; Windows gets solid fills
 *  (no OS vibrancy to shine through). */
function Silhouette({ w, h, bump, glass, theme, flat }: { w: number; h: number; bump: { x: number; w: number } | null; glass: number; theme: string; flat: boolean }) {
  if (w <= 0 || h <= 0) return null;
  const sil = silhouettePath(w, h, bump);
  // CSS can't reach SVG gradient stops, so the window BODY (pcTint/strip/rim)
  // is flipped here for the light theme. Light stops carry a LIGHT FLOOR
  // (0.34+0.40·glass) — unlike the dark stops (pure α·glass) — because on light
  // we can't assume a dark desktop behind the native vibrancy, so the surface
  // must stay light-and-legible even at "clear" glass.
  const light = theme === "light";
  // `flat` = iOS frost OFF: there is NO native vibrancy behind the window, so
  // the semi-transparent fills would show the desktop straight through (TJ:
  // transparent inactive tabs, dark and light). Rather than making each SVG
  // path opaque — which exposes every internal seam / corner gap the vibrancy
  // used to hide (TJ round 2: "cutouts links+rechts, schmiegt sich nicht an") —
  // we lay ONE continuous opaque rounded-rect BACKING (radius PANE_R = exactly
  // what the native vibrancy fills) behind everything. The strip + silhouette
  // then sit on it seamlessly, just like they sit on the vibrancy when blur is
  // on. See the <path d={roundedWindow…}> below.
  // Matches the neutral frost that covers the pane (terminalGlassBg) so the
  // corner areas the backing fills blend seamlessly with the pane.
  const backing = light ? "#f0f6fa" : "#1e2531";
  return (
    <svg className="pc-sil" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <defs>
        <linearGradient id="pcTint" x1="0" y1="0" x2="0.4" y2="1">
          {IS_WINDOWS ? (
            light ? (
              <>
                <stop offset="0" stopColor="#f2f6fb" />
                <stop offset="0.5" stopColor="#eaf1f8" />
                <stop offset="1" stopColor="#e4ecf5" />
              </>
            ) : (
              <>
                <stop offset="0" stopColor="#18293f" />
                <stop offset="0.5" stopColor="#0e1c30" />
                <stop offset="1" stopColor="#0b1626" />
              </>
            )
          ) : light ? (
            <>
              <stop offset="0" stopColor={`rgba(247,250,253,${Math.min(1, 0.36 + 0.4 * glass)})`} />
              <stop offset="0.46" stopColor={`rgba(238,243,249,${Math.min(1, 0.32 + 0.36 * glass)})`} />
              <stop offset="1" stopColor={`rgba(232,238,246,${Math.min(1, 0.34 + 0.4 * glass)})`} />
            </>
          ) : (
            <>
              <stop offset="0" stopColor={`rgba(36,58,92,${Math.min(1, 0.3 * glass)})`} />
              <stop offset="0.46" stopColor={`rgba(10,22,42,${Math.min(1, 0.2 * glass)})`} />
              <stop offset="1" stopColor={`rgba(8,18,36,${Math.min(1, 0.26 * glass)})`} />
            </>
          )}
        </linearGradient>
        <linearGradient id="pcRim" x1="0" y1="0" x2="0" y2="1">
          {light ? (
            <>
              <stop offset="0" stopColor="rgba(255,255,255,0.9)" />
              <stop offset="0.16" stopColor="rgba(120,150,190,0.22)" />
              <stop offset="1" stopColor="rgba(60,95,135,0.18)" />
            </>
          ) : (
            <>
              <stop offset="0" stopColor="rgba(200,225,250,0.42)" />
              <stop offset="0.16" stopColor="rgba(170,205,240,0.2)" />
              <stop offset="1" stopColor="rgba(160,195,235,0.13)" />
            </>
          )}
        </linearGradient>
        <mask id="pcNotch">
          <rect x="0" y="0" width={w} height={h} fill="white" />
          <path d={sil} fill="black" />
        </mask>
      </defs>
      {/* Flat-mode opaque BACKING: one clean rounded rect (radius PANE_R = the
          native vibrancy radius) behind everything, standing in for the
          vibrancy the window no longer has. No internal seams, no corner gaps —
          the strip + silhouette sit on it exactly as they sit on the vibrancy
          when blur is on. */}
      {flat && !IS_WINDOWS && (
        <rect x="0" y="0" width={w} height={h} rx={PANE_R} ry={PANE_R} fill={backing} />
      )}
      {/* Recessed titlebar strip — a shade darker than the body, tucked BEHIND
          the pane+tab shape. In flat mode it sits opaque on the backing; with
          blur on it stays glass-scaled (the vibrancy shows through). */}
      <path
        d={stripPath(w)}
        fill={
          IS_WINDOWS
            ? light
              ? "rgba(224,231,240,0.98)"
              : "rgba(7,15,27,0.96)"
            : flat
              ? light
                ? "#e4ebf3"
                : "#161c27"
              : light
                ? `rgba(214,223,234,${Math.min(1, 0.5 + 0.35 * glass)})`
                : `rgba(5,12,25,${Math.min(1, 0.12 + 0.3 * glass)})`
        }
        mask="url(#pcNotch)"
      />
      {/* Genie flight stand-in glass now lives in a GPU-composited .pc-frost
          DIV (sibling of this SVG), not an opacity-animated SVG path — see
          runGenie/settleGenie + .pc-frost. */}
      {/* Pane + active tab: ONE shape. The outline IS the tab. */}
      <path className="pc-sil-body" d={sil} fill="url(#pcTint)" />
      <path d={sil} fill="none" stroke="url(#pcRim)" strokeWidth="1" />
    </svg>
  );
}

// ---- Terminal flight / flat glass ------------------------------------------
// NEUTRAL graphite (dark) or cool-white (light) — see terminalGlassBg. An
// earlier build tinted this from the pill accent so the terminal "emerged in
// the pill's tone", but a cyan pill read as a strong green and TJ wanted the
// plain neutral look back.
type RGB = { r: number; g: number; b: number };
// Kept to validate orb_color_idle before it is stored (the terminal glass is
// neutral now, so the parsed color is no longer folded into the gradient).
function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** The genie flight / flat-terminal glass background. NEUTRAL by design: a
 *  plain graphite (dark) or cool-white (light) frost — NO pill hue. An earlier
 *  version tinted it from the pill color, but a cyan pill turned the emerging
 *  terminal a strong green (TJ: "warum ist das jetzt grün? Das sollte genauso
 *  sein wie vorher"). The pill accent is not carried into the terminal glass.
 *  `pillHex` is kept in the signature for call-site stability but unused. */
function terminalGlassBg(_pillHex: string, theme: string): string {
  if (theme === "light") {
    return (
      "linear-gradient(160deg, rgba(240, 246, 250, 0.94) 0%, " +
      "rgba(232, 239, 246, 0.93) 46%, rgba(228, 235, 243, 0.94) 100%)"
    );
  }
  return (
    "linear-gradient(160deg, rgba(30, 37, 49, 0.93) 0%, " +
    "rgba(22, 29, 41, 0.92) 46%, rgba(17, 24, 36, 0.93) 100%)"
  );
}

// ---- Genie / magic-lamp animation ------------------------------------------
// Real suction, not a plain shrink (KDE "Magic Lamp" style): a clip-path
// polygon morphs the window into a FUNNEL whose mouth sits over the pill
// (lower points pinch first), then the mass slides down the funnel into it.
// clip-path applies pre-transform, so the same element carries the funnel
// morph AND the scale-toward-the-pill — combined they read as the warp.
//
// Iron rule learned in v0.5.95 (TJ: "verschwindet im Nichts über der Pille"):
// opacity stays at 1 essentially ALL the way — an early fade dissolves the
// window mid-air ~100px short of the pill, because the visible mass only
// reaches the transform-origin as scale→0. The pill's absorb pulse covers the
// final snap.

type GeniePoint = { x: number; y: number; w: number };

/** One clip polygon (14 pts, same count at every k) for the funnel morph:
 *  k = 0 → full rect, k = 1 → funneled onto a `mouth`-halfwidth opening
 *  centred over the pill; lower points pinch first (h^1.6) — the lamp look.
 *  `py < H/2` flips the funnel upward for a pill above the window. */
function genieClip(W: number, H: number, px: number, py: number, k: number, mouth: number): string {
  const down = py >= H / 2;
  const cx = Math.min(Math.max(px, 36), W - 36);
  const Y = (y: number) => (down ? y : H - y);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const pts: string[] = [];
  const push = (x: number, y: number) => pts.push(`${x.toFixed(1)}px ${Y(y).toFixed(1)}px`);
  // far edge (away from the pill) — narrows mildly, the mass exits mouth-first
  for (const tx of [0, 0.33, 0.66, 1]) {
    push(lerp(tx * W, cx + (tx - 0.5) * 2 * (mouth + (W / 2 - mouth) * 0.6), k * 0.5), 0);
  }
  const SIDE_H = [0.3, 0.6, 0.85]; // side sample depths (0 = far edge, 1 = mouth)
  const pinch = (h: number) => Math.pow(h, 1.6) * k;
  for (const h of SIDE_H) push(lerp(W, cx + mouth, pinch(h)), h * H); // right side ↓
  for (const bx of [1, 0.66, 0.33, 0]) push(lerp(bx * W, cx + (bx - 0.5) * 2 * mouth, k), H); // mouth
  for (const h of [...SIDE_H].reverse()) push(lerp(0, cx - mouth, pinch(h)), h * H); // left side ↑
  return `polygon(${pts.join(", ")})`;
}

/** Dense keyframes sampled from ONE continuous parametric motion — no easing
 *  seams between hand-set segments (they read as tiny jolts, TJ: "blätscht").
 *  18 samples, linear between them: funnel formation, travel, squash and clip
 *  all stay phase-locked. */
function genieFrames(dir: "in" | "out", W: number, H: number, p: GeniePoint): Keyframe[] {
  const mouth1 = Math.max(26, Math.min(p.w * 0.5, 80));
  const mouth2 = Math.max(10, mouth1 * 0.32);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const N = 18;
  const frames: Keyframe[] = [];
  for (let i = 0; i <= N; i++) {
    const T = i / N;
    let k: number, u: number, sx: number, sy: number, opacity: number;
    if (dir === "out") {
      // funnel fully formed by 42%; travel starts gently at 16% and accelerates
      k = smooth(clamp01(T / 0.42));
      u = T < 0.16 ? 0 : Math.pow((T - 0.16) / 0.84, 1.9);
      sx = lerp(1, 0.02, clamp01(u * 1.06));
      // taffy: a soft stretch toward the pill while the funnel forms, then the
      // height collapses a touch slower than the width
      sy = lerp(1, 0.045, Math.pow(u, 1.3)) * (1 + 0.05 * Math.sin(Math.PI * clamp01(T / 0.45)));
      opacity = T > 0.965 ? (1 - T) / 0.035 : 1; // visible ALL the way in
    } else {
      // Smoothstep time-warp: the raw ease-out (1-(1-T)^2.6) hits MAX velocity
      // at T=0 — the fastest stretch of the flight landed exactly in the
      // compositor's warmup frames and read as a jolt (TJ: entrance rougher
      // than the suction). Warped, the mass ignites softly out of the pill,
      // whooshes through the middle and settles with a double-flat tail.
      const Tw = T * T * (3 - 2 * T);
      const v = 1 - Math.pow(1 - Tw, 2.6);
      // funnel dissolves with TRAVEL (not raw time) — stays phase-locked to
      // the mass: holds while emerging, melts as the window unfolds past 45%.
      k = 1 - smooth(clamp01((v - 0.45) / 0.5));
      u = 1 - v;
      sx = lerp(0.02, 1, v) * (1 + 0.014 * Math.sin(Math.PI * clamp01((T - 0.55) / 0.45)));
      sy = lerp(0.045, 1, v) * (1 - 0.012 * Math.sin(Math.PI * clamp01((T - 0.55) / 0.45)));
      opacity = 1; // visible from the very first frame — it grows OUT of the pill
    }
    frames.push({
      clipPath: genieClip(W, H, p.x, p.y, k, lerp(mouth1, mouth2, clamp01(u))),
      transform: `scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`,
      opacity,
    });
  }
  return frames;
}

/** The flight canvas: the animation renders inside the WINDOW, so it is
 *  clipped to it — and the pill usually sits BELOW the window (that is why
 *  v0.5.99 visually stopped at the window edge, TJ). Union of the current
 *  rect and a pad around the pill, as offsets for `prompt_genie_frame`. */
function flightFrame(W: number, H: number, p: GeniePoint) {
  const pad = Math.max(120, p.w);
  const left = Math.min(0, p.x - pad);
  const top = Math.min(0, p.y - pad);
  const right = Math.max(W, p.x + pad);
  const bottom = Math.max(H, p.y + pad);
  return { dx: left, dy: top, w: right - left, h: bottom - top };
}

export function PromptConsole() {
  const { t } = useTranslation();
  const [data, setData] = useState<PromptData | null>(null);
  const [libOpen, setLibOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [onTop, setOnTop] = useState(true);
  const [asTarget, setAsTarget] = useState(false);
  const [glass, setGlass] = useState<GlassLevel>("clear");
  // Pill-toned frost background + terminal theme, React-managed so re-renders
  // never clobber them (applyTerminalGlass also sets them imperatively for a
  // synchronous flight seal — both write the same value).
  const [frostBg, setFrostBg] = useState(() => terminalGlassBg("#00fdff", "dark"));
  const [pcTheme, setPcTheme] = useState("dark");
  // Blur-off ("flat") state drives the SVG body to opaque so the strip/tabs
  // aren't see-through — a STATE (not just blurOnRef) so the Silhouette re-renders.
  const [blurOn, setBlurOn] = useState(true);
  const [copied, setCopied] = useState(false);
  const [libQuery, setLibQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  // AI-Coach "Refine": rewrite the draft into a structured prompt, show a
  // before/after diff, accept or discard. `refineReq` guards against a stale
  // in-flight result landing after the user cancelled / started a new one.
  const [refining, setRefining] = useState(false);
  const [refineBase, setRefineBase] = useState("");
  const [refineResult, setRefineResult] = useState<string | null>(null);
  const [refineErr, setRefineErr] = useState<string | null>(null);
  const [refineView, setRefineView] = useState<"diff" | "result">("diff");
  const refineReq = useRef(0);
  // "Korrigieren": one-click tidy pass over the whole text (typos/punctuation),
  // applied directly with an undo (see `toast`). Loading flag drives the button.
  const [correcting, setCorrecting] = useState(false);
  // Bottom toast: undo for clear/correct (and brief status messages). Honors
  // the iron "nothing is lost" rule — destructive-ish actions snapshot the old
  // text into `toast.undo` so one click restores it.
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const undoTimer = useRef<number | undefined>(undefined);
  // Autocorrect: native OS spellcheck + autocorrection on the editor. Off by
  // default (prompts often hold code/paths the OS would mangle); persisted in
  // localStorage so it's a self-contained per-device editor preference.
  const [autocorrect, setAutocorrect] = useState(() => {
    try {
      return localStorage.getItem("pc-autocorrect") === "1";
    } catch {
      return false;
    }
  });
  // Click-to-dictate: a mic button records (toggle, no held hotkey) and streams
  // the transcript into the editor. Runs the existing streaming path in FINAL
  // mode (partials shown as a live preview, but NOT injected into any focused
  // app — see startMic) and lands the finished text via the "Terminal als Ziel"
  // queue. `micActive` ref gates the global stream-partial listener; `micPrev`
  // remembers the config to restore after the session.
  const [micRecording, setMicRecording] = useState(false);
  const [livePartial, setLivePartial] = useState("");
  const micActive = useRef(false);
  const micPrev = useRef<{ asTarget: boolean; streaming: string } | null>(null);
  // Terminal-grade tab chrome: right-click context menu + command palette.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const dragId = useRef<string | null>(null);

  // ---- Window chrome state ----
  const [winSize, setWinSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  // The active tab's bump in the silhouette — measured from the DOM, then
  // spring-animated so switching tabs GLIDES the outline over (rAF, no lib).
  const [bumpDraw, setBumpDraw] = useState<{ x: number; w: number } | null>(null);
  const bumpCur = useRef<{ x: number; w: number } | null>(null);
  const bumpRaf = useRef(0);
  const tabEls = useRef(new Map<string, HTMLDivElement>());
  const tabRowRef = useRef<HTMLDivElement>(null);
  // Genie animation plumbing.
  const stageRef = useRef<HTMLDivElement>(null);
  const genieAnim = useRef<Animation | null>(null);
  const genieDir = useRef<"in" | "out" | null>(null);
  const genieRan = useRef(false);
  // The genie stand-in frost (GPU layer). Its opacity is WAAPI-driven so the
  // reveal runs on the compositor thread, off the main thread's repaint/attach.
  const frostRef = useRef<HTMLDivElement>(null);
  const frostAnim = useRef<Animation | null>(null);
  // Terminal appearance (refs so the once-mounted genie/settle closures always
  // read fresh values): iOS frost on/off, dark/light, and the pill accent hue
  // the glass is tinted from. Kept in sync by the config read + live listener.
  const blurOnRef = useRef(true);
  const termThemeRef = useRef("dark");
  const pillColorRef = useRef("#00fdff");
  // Active flight canvas: the pre-flight stage box (its offset inside the
  // ENLARGED window) + the pill point in flight coordinates. While set, the
  // resize listener must not touch winSize — the grow/restore resizes would
  // re-layout the silhouette mid-flight.
  const flight = useRef<{ box: { dx: number; dy: number; w: number; h: number }; p: GeniePoint } | null>(null);
  const booted = useRef(false);
  // Green light / zoom: remember the pre-zoom frame to restore on toggle.
  const zoomPrev = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  /** Latest action set for the global shortcut handler (the keydown listener is
   *  mounted once, so it can't close over fresh state — we reassign this every
   *  render). */
  const actions = useRef<{
    paletteOpen: boolean;
    insert: () => void;
    copy: () => void;
    newTab: () => void;
    closeActive: () => void;
    duplicate: () => void;
    clear: () => void;
    jumpTo: (i: number) => void;
    cycle: (dir: number) => void;
    togglePalette: () => void;
    escape: () => void;
  } | null>(null);

  // ---- Persistence: debounce every change; flush on blur/hide. ----
  const latest = useRef<PromptData | null>(null);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  latest.current = data;

  const flushNow = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
    if (dirty.current && latest.current) {
      dirty.current = false;
      invoke("prompts_save", { data: JSON.stringify(latest.current) }).catch(() => {
        dirty.current = true; // retry on the next change/flush
      });
    }
  };

  const update = (fn: (d: PromptData) => PromptData) => {
    setData((d) => {
      if (!d) return d;
      const next = fn(d);
      dirty.current = true;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flushNow, 400);
      return next;
    });
  };

  // ---- "Terminal als Ziel": drain the Rust-side transcript queue. ----
  const drainPending = () =>
    invoke<string[]>("prompt_take_pending")
      .then((pending) => {
        if (!pending.length) return;
        update((d) => ({
          ...d,
          drafts: d.drafts.map((dr) =>
            dr.id === d.activeId
              ? {
                  ...dr,
                  text: (dr.text.trim() ? dr.text.replace(/\s+$/, "") + "\n\n" : "") + pending.join("\n\n"),
                  updatedAt: Date.now(),
                }
              : dr,
          ),
        }));
        setFlash(true);
        window.setTimeout(() => setFlash(false), 900);
      })
      .catch(() => {});

  // ---- Genie: materialize out of / vanish into the orb pill. ----
  // transform-origin = the pill centre in THIS window's coordinates, so the
  // whole shell funnels toward the pill. The native vibrancy layer can't follow
  // CSS transforms, so it's switched off for the flight (prompt_set_effects)
  // and back on once the window is at rest.
  const genieAnchor = async (): Promise<GeniePoint> => {
    // No visible orb / lookup failed → funnel to just below the window.
    const fallback = { x: window.innerWidth / 2, y: window.innerHeight + 150, w: 90 };
    try {
      const a = await invoke<[number, number, number] | null>("prompt_genie_anchor");
      if (!a) return fallback;
      const win = getCurrentWindow();
      const [pos, sf] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
      // Guard every field: ONE NaN would silently kill the whole clip-path
      // (the browser drops invalid keyframe values → no funnel, just a shrink).
      const x = a[0] - pos.x / sf;
      const y = a[1] - pos.y / sf;
      const w = a[2];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return fallback;
      return { x, y, w: Number.isFinite(w) && w > 10 ? w : 90 };
    } catch {
      return fallback;
    }
  };

  /** Pin the stage to the pre-flight rect (so growing the window moves NOTHING
   *  visually) or release it back to filling the window. */
  const pinStage = (stage: HTMLDivElement, box: { dx: number; dy: number; w: number; h: number } | null) => {
    if (box) {
      stage.style.position = "absolute";
      stage.style.left = `${-box.dx}px`;
      stage.style.top = `${-box.dy}px`;
      stage.style.width = `${box.w}px`;
      stage.style.height = `${box.h}px`;
    } else {
      stage.style.position = "";
      stage.style.left = "";
      stage.style.top = "";
      stage.style.width = "";
      stage.style.height = "";
    }
  };

  /** Paint the frost with the current pill-toned glass + reflect the theme on
   *  the stage (for the light-theme CSS). Called on config read + live change. */
  const applyTerminalGlass = () => {
    const bg = terminalGlassBg(pillColorRef.current, termThemeRef.current);
    setFrostBg(bg); // React owns it across re-renders
    setPcTheme(termThemeRef.current);
    // Also set synchronously so an immediately-following flight seal uses it
    // this frame (setState is async).
    if (frostRef.current) frostRef.current.style.background = bg;
    stageRef.current?.setAttribute("data-pc-theme", termThemeRef.current);
  };

  /** Drive the stand-in frost on the compositor thread. ms = 0 snaps. */
  const setFrost = (to: number, ms: number, easing = "linear") => {
    const el = frostRef.current;
    if (!el) return;
    // Read the LIVE opacity FIRST: cancel() reverts the element to its CSS base
    // (opacity:0) synchronously, so sampling after cancel would read 0 and make
    // the melt animate 0→0 (a hard pop instead of the 380ms fade).
    const from = Number(getComputedStyle(el).opacity) || 0;
    frostAnim.current?.cancel();
    if (to > 0) el.style.willChange = "opacity";
    const a = el.animate([{ opacity: from }, { opacity: to }], {
      duration: ms,
      easing,
      fill: "both",
    });
    a.onfinish = () => {
      if (to === 0) el.style.willChange = "auto";
    };
    frostAnim.current = a;
  };

  /** Register the glass-ready listener, THEN run `attach` (which triggers the
   *  vibrancy), then resolve when Rust emits echo://prompt-glass-ready (fired
   *  right after apply_vibrancy returns) or after a fallback timeout. Ordering
   *  matters: the listener is awaited-registered BEFORE `attach` runs, so the
   *  emit can never race ahead of it and be dropped. */
  const attachThenWaitGlass = async (
    attach: () => void,
    timeout: number,
  ): Promise<void> => {
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const un = await listen("echo://prompt-glass-ready", () => resolve());
    attach();
    const timer = window.setTimeout(resolve, timeout);
    await done;
    window.clearTimeout(timer);
    un();
  };

  /** Post-flight cleanup for either direction (also reached when a reversed
   *  animation lands): release the flight canvas, restore frame/vibrancy. */
  const settleGenie = async (dir: "in" | "out") => {
    const stage = stageRef.current;
    if (!stage) return;
    if (dir === "out") {
      // Stay collapsed (fill: both) while hidden — no flash on the next show.
      // hide_now also restores the window frame; release the pin while hidden.
      flight.current = null;
      await invoke("prompt_console_hide_now").catch(() => {});
      pinStage(stage, null);
      setFrost(0, 0); // reset the cover while hidden (also the reverse path)
    } else {
      genieAnim.current?.cancel();
      flight.current = null;
      // The frost is still fully opaque (sealed at flight start). Restore the
      // window frame under the seal (its resize repaint stays invisible); give
      // it its own frame so it can't compound with a later attach hitch.
      await invoke("prompt_genie_frame", { expand: false }).catch(() => {});
      pinStage(stage, null);
      if (!blurOnRef.current) {
        // Blur OFF (TJ's switch): NO handover — the pill-toned frost stays as
        // the terminal's permanent flat glass. Zero material switch.
        setFrost(1, 0);
        return;
      }
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      // Register the ready-listener, THEN attach the vibrancy behind the opaque
      // frost, then wait for the real signal (+ fallback) so the blur is
      // provably present and painted before we reveal it.
      await attachThenWaitGlass(
        () => invoke("prompt_set_effects", { on: true }).catch(() => {}),
        150,
      );
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );
      if (genieDir.current !== "in") return; // superseded while waiting
      // Re-check the blur switch: it may have been toggled OFF during the async
      // wait above (the live listener already stripped the vibrancy + raised
      // the frost). Melting now would strand a blank, vibrancy-less window
      // (review finding). Honour the fresh value instead.
      if (!blurOnRef.current) {
        setFrost(1, 0);
        invoke("prompt_set_effects", { on: false }).catch(() => {});
        return;
      }
      // Melt a frost that is ALREADY present and tone-matched → one continuous
      // frosted material clearing, no flat→blur step.
      setFrost(0, 380, "cubic-bezier(0.22, 0.61, 0.36, 1)");
    }
  };

  const runGenie = async (dir: "in" | "out") => {
    const stage = stageRef.current;
    if (!stage) {
      if (dir === "out") invoke("prompt_console_hide_now").catch(() => {});
      return;
    }
    genieRan.current = true;

    // Direction change MID-FLIGHT: reverse the running animation instead of
    // cancelling + restarting. Cancel drops the WAAPI fill for a beat (full-
    // size flash) and keyframe 0 would teleport the half-grown window back
    // into the pill — reverse retreats exactly along the path it came.
    const running = genieAnim.current;
    if (
      running &&
      genieDir.current &&
      genieDir.current !== dir &&
      running.playState === "running"
    ) {
      genieDir.current = dir;
      running.reverse();
      try {
        await running.finished;
      } catch {
        return; // superseded by a newer genie
      }
      if (genieDir.current !== dir) return;
      await settleGenie(dir);
      return;
    }
    genieDir.current = dir;
    // Seal the window with the opaque stand-in frost BEFORE the vibrancy is
    // cut, so the material never drops out. The stage stays hidden (.pc-boot on
    // first boot, the previous animation's fill afterwards) through ALL the
    // async prep below — nothing may flash at full size before the first
    // keyframe owns the stage (the old order dropped the cover first and let
    // the un-clipped window peek through for a frame: TJ's rough entrance).
    applyTerminalGlass(); // pill-toned even on the very first flight
    setFrost(1, 0);
    if (dir === "out") {
      // Let the stand-in glass GRIP (two painted frames of its fast fade)
      // before the native blur is cut — cutting first left the window raw
      // and see-through for a beat at suction start.
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );
    }
    invoke("prompt_set_effects", { on: false }).catch(() => {});

    // Flight canvas: the animation is clipped to the WINDOW, and the pill sits
    // outside it — grow the transparent window over the pill for the flight
    // (restored on settle/hide). Re-entry mid-flight reuses the existing
    // canvas: window and stage are already in flight coordinates.
    let W: number, H: number, p: GeniePoint;
    if (flight.current) {
      ({ w: W, h: H } = flight.current.box);
      p = flight.current.p;
    } else {
      W = window.innerWidth;
      H = window.innerHeight;
      p = await genieAnchor();
      const ff = flightFrame(W, H, p);
      flight.current = { box: { dx: ff.dx, dy: ff.dy, w: W, h: H }, p };
      pinStage(stage, flight.current.box);
      await invoke("prompt_genie_frame", { expand: true, ...ff }).catch(() => {});
    }
    stage.style.transformOrigin = `${p.x}px ${p.y}px`;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frames = reduce
      ? dir === "in"
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 1 }, { opacity: 0 }]
      : genieFrames(dir, W, H, p);
    if (dir === "in" && !reduce) {
      // The window was shown moments ago and WKWebView's first frames after
      // show() are the ones the compositor drops. Hold the (still invisible)
      // stage for two PAINTED frames so the entrance starts on a live
      // pipeline instead of losing its opening stretch to warmup.
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );
      if (genieDir.current !== dir) return; // superseded while waiting
    }
    const prev = genieAnim.current;
    const anim = stage.animate(frames, {
      duration: reduce ? 140 : dir === "in" ? 520 : 440,
      fill: "both",
    });
    genieAnim.current = anim;
    // Zero-gap handover: the new animation already holds the stage (first
    // keyframe = collapsed at the pill), so dropping the old fill and the
    // boot cover now cannot expose an unstyled frame.
    prev?.cancel();
    stage.classList.remove("pc-boot");
    try {
      await anim.finished;
    } catch {
      return; // cancelled — a newer genie superseded this one
    }
    if (genieDir.current !== dir) return;
    await settleGenie(dir);
  };

  useEffect(() => {
    invoke<string>("prompts_load")
      .then((raw) => setData(parseData(raw)))
      .catch(() => setData(emptyData()));
    getConfig()
      .then((c) => {
        setLanguage(c.ui_language || "de");
        setAsTarget(!!c.prompt_console_as_target);
        setGlass(asGlass(c.prompt_console_glass));
        blurOnRef.current = c.prompt_terminal_blur !== false;
        setBlurOn(blurOnRef.current);
        termThemeRef.current = c.prompt_terminal_theme === "light" ? "light" : "dark";
        if (typeof c.orb_color_idle === "string" && hexToRgb(c.orb_color_idle))
          pillColorRef.current = c.orb_color_idle;
        applyTerminalGlass();
      })
      .catch(() => {});

    // Live terminal-appearance updates from Settings (blur on/off, dark/light,
    // pill color) — restyle without reopening; apply the material change now if
    // the terminal is settled (not mid-flight).
    const unPromptCfg = listen<{ blur?: boolean; theme?: string; pillColor?: string }>(
      "echo://prompt-config",
      async (e) => {
        const p = e.payload;
        const wasBlur = blurOnRef.current;
        if (typeof p.blur === "boolean") {
          blurOnRef.current = p.blur;
          setBlurOn(p.blur);
        }
        if (p.theme === "light" || p.theme === "dark") termThemeRef.current = p.theme;
        if (typeof p.pillColor === "string" && hexToRgb(p.pillColor)) pillColorRef.current = p.pillColor;
        applyTerminalGlass();
        // Only re-drive the material live when settled (mid-flight, settleGenie
        // reads the fresh ref at landing). A blur flip needs attach/strip.
        if (!flight.current && blurOnRef.current !== wasBlur) {
          if (blurOnRef.current) {
            // Attach the vibrancy behind the still-opaque frost, wait for it to
            // be present (glass-ready + fallback), THEN melt — same no-flash
            // handover as the genie settle.
            setFrost(1, 0);
            await attachThenWaitGlass(
              () => invoke("prompt_set_effects", { on: true }).catch(() => {}),
              150,
            );
            if (blurOnRef.current && !flight.current)
              setFrost(0, 380, "cubic-bezier(0.22, 0.61, 0.36, 1)");
          } else {
            setFrost(1, 0);
            invoke("prompt_set_effects", { on: false }).catch(() => {});
          }
        }
      },
    );

    const unTranscript = listen("echo://prompt-transcript", drainPending);
    drainPending(); // anything queued while this webview was booting

    // Live dictation preview: show streaming partials while the mic button is
    // active (the finished text lands via the prompt-transcript queue above).
    const unPartial = listen<string>("echo://stream-partial", (e) => {
      if (micActive.current) setLivePartial(e.payload);
    });

    // Genie choreography from Rust (toggle/show paths emit this).
    const unGenie = listen<string>("echo://prompt-genie", (e) => {
      void runGenie(e.payload === "out" ? "out" : "in");
    });

    // Failsafe: the stage starts collapsed/invisible; if no entrance ever runs
    // (event lost, anchor call wedged), snap visible rather than stay blank.
    const failsafe = window.setTimeout(() => {
      if (!genieRan.current && stageRef.current) {
        stageRef.current.classList.remove("pc-boot");
        if (blurOnRef.current) {
          invoke("prompt_set_effects", { on: true }).catch(() => {});
          setFrost(0, 0); // never leave the cover stuck opaque
        } else {
          setFrost(1, 0); // blur off → the frost IS the glass
        }
      }
    }, 1200);

    const onResize = () => {
      if (flight.current) return; // flight-canvas grow/restore, not a real resize
      setWinSize({ w: window.innerWidth, h: window.innerHeight });
    };
    window.addEventListener("resize", onResize);

    // Global keyboard map (terminal muscle memory). The palette owns its own
    // keys while open; everything routes through the `actions` ref so it sees
    // fresh state.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        actions.current?.escape();
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === "p") {
        e.preventDefault();
        actions.current?.togglePalette();
        return;
      }
      if (actions.current?.paletteOpen) return; // palette drives the rest
      if (e.key === "Enter") {
        e.preventDefault();
        actions.current?.insert();
      } else if (k === "k") {
        e.preventDefault();
        actions.current?.copy();
      } else if (k === "t") {
        e.preventDefault();
        actions.current?.newTab();
      } else if (k === "w") {
        e.preventDefault();
        actions.current?.closeActive();
      } else if (k === "d") {
        e.preventDefault();
        actions.current?.duplicate();
      } else if (k === "l") {
        e.preventDefault();
        actions.current?.clear();
      } else if (e.key === "Tab") {
        e.preventDefault();
        actions.current?.cycle(e.shiftKey ? -1 : 1);
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        actions.current?.jumpTo(parseInt(e.key, 10) - 1);
      }
    };
    const onBlurOrHide = () => flushNow();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlurOrHide);
    document.addEventListener("visibilitychange", onBlurOrHide);
    return () => {
      unTranscript.then((f) => f());
      unPartial.then((f) => f());
      unGenie.then((f) => f());
      unPromptCfg.then((f) => f());
      window.clearTimeout(failsafe);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlurOrHide);
      document.removeEventListener("visibilitychange", onBlurOrHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First boot: the stage exists only once the data loaded — play the entrance
  // then (the Rust create-path can't reach a webview that isn't listening yet).
  useEffect(() => {
    if (data && !booted.current) {
      booted.current = true;
      void runGenie("in");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ---- Silhouette bump: measure the active tab, spring the outline to it. ----
  const springBumpTo = (target: { x: number; w: number } | null) => {
    cancelAnimationFrame(bumpRaf.current);
    if (!target) {
      bumpCur.current = null;
      setBumpDraw(null);
      return;
    }
    if (!bumpCur.current) {
      bumpCur.current = { ...target };
      setBumpDraw({ ...target });
      return;
    }
    const step = () => {
      const c = bumpCur.current!;
      c.x += (target.x - c.x) * 0.34;
      c.w += (target.w - c.w) * 0.34;
      if (Math.abs(target.x - c.x) < 0.5 && Math.abs(target.w - c.w) < 0.5) {
        c.x = target.x;
        c.w = target.w;
        setBumpDraw({ ...c });
        return;
      }
      setBumpDraw({ ...c });
      bumpRaf.current = requestAnimationFrame(step);
    };
    step();
  };

  useLayoutEffect(() => {
    if (!data) return;
    const el = tabEls.current.get(data.activeId);
    if (!el) {
      springBumpTo(null);
      return;
    }
    // offsetLeft/offsetWidth, NOT getBoundingClientRect: client rects are
    // TRANSFORMED. While the console sits hidden after a genie-out, the WAAPI
    // fill holds the stage at scale 0.02 — dictations routed in meanwhile
    // ("Konsole als Ziel") re-render the tabs and a rect-based measurement
    // captured garbage, leaving the silhouette bump beside the actual tab on
    // the next open (Erik's "tabs sitzen falsch"). Offsets are layout-space
    // and immune to the stage transform; subtract the row scroll ourselves.
    const row = tabRowRef.current;
    springBumpTo({ x: el.offsetLeft - (row ? row.scrollLeft : 0), w: el.offsetWidth });
    // Label width follows the text, so drafts is a real dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.activeId, data?.drafts, renaming, winSize]);

  if (!data) return null;
  const active = data.drafts.find((d) => d.id === data.activeId) ?? data.drafts[0];
  const chars = active.text.length;
  const words = active.text.trim() ? active.text.trim().split(/\s+/).length : 0;
  const tokens = Math.ceil(chars / 4);
  const checks = analyzePrompt(active.text);
  const metCount = COACH_KEYS.filter((k) => checks[k]).length;
  const score = Math.round((metCount / COACH_KEYS.length) * 100);
  const q = libQuery.trim().toLowerCase();
  const libFiltered = q
    ? data.library.filter((e) => (e.title + " " + e.text).toLowerCase().includes(q))
    : data.library;

  // ---- Draft / tab actions ----
  const setText = (text: string) =>
    update((d) => ({
      ...d,
      drafts: d.drafts.map((dr) => (dr.id === d.activeId ? { ...dr, text, updatedAt: Date.now() } : dr)),
    }));

  const addTab = () =>
    update((d) => {
      const dr = newDraft();
      return { ...d, activeId: dr.id, drafts: [...d.drafts, dr] };
    });

  /** Close a tab. A non-empty draft is ARCHIVED into the library (never lost). */
  const closeTab = (id: string) =>
    update((d) => {
      const dr = d.drafts.find((x) => x.id === id);
      const drafts = d.drafts.filter((x) => x.id !== id);
      const library =
        dr && dr.text.trim()
          ? [{ ...dr, pinned: false, title: tabLabel(dr, t("prompt.tabUntitled")), updatedAt: Date.now() }, ...d.library]
          : d.library;
      if (drafts.length === 0) drafts.push(newDraft());
      const activeId = d.activeId === id ? drafts[drafts.length - 1].id : d.activeId;
      return { ...d, activeId, drafts, library };
    });

  /** ⌘W / footer close — protects pinned tabs (unpin first). */
  const closeActive = () => {
    const cur = data.drafts.find((x) => x.id === data.activeId);
    if (cur?.pinned) return;
    closeTab(data.activeId);
  };

  const rename = (id: string, title: string) =>
    update((d) => ({
      ...d,
      drafts: d.drafts.map((dr) => (dr.id === id ? { ...dr, title } : dr)),
    }));

  /** Duplicate a tab right after the source, and focus the copy. */
  const duplicateTab = (id: string) =>
    update((d) => {
      const src = d.drafts.find((x) => x.id === id);
      if (!src) return d;
      const dr: Draft = { ...src, id: crypto.randomUUID(), pinned: false, updatedAt: Date.now() };
      const idx = d.drafts.findIndex((x) => x.id === id);
      const drafts = [...d.drafts];
      drafts.splice(idx + 1, 0, dr);
      return { ...d, activeId: dr.id, drafts };
    });

  /** Toggle pin. Pinning moves the tab to the front (browser-style). */
  const togglePinTab = (id: string) =>
    update((d) => {
      const drafts = d.drafts.map((x) => (x.id === id ? { ...x, pinned: !x.pinned } : x));
      const target = drafts.find((x) => x.id === id);
      if (target?.pinned) {
        return { ...d, drafts: [target, ...drafts.filter((x) => x.id !== id)] };
      }
      return { ...d, drafts };
    });

  /** Drag-reorder: drop `fromId` at the position of `toId`. */
  const reorderTab = (fromId: string, toId: string) =>
    update((d) => {
      if (fromId === toId) return d;
      const drafts = [...d.drafts];
      const from = drafts.findIndex((x) => x.id === fromId);
      const to = drafts.findIndex((x) => x.id === toId);
      if (from < 0 || to < 0) return d;
      const [moved] = drafts.splice(from, 1);
      drafts.splice(to, 0, moved);
      return { ...d, drafts };
    });

  const jumpTo = (i: number) => {
    const dr = data.drafts[i];
    if (dr) update((d) => ({ ...d, activeId: dr.id }));
  };

  const cycle = (dir: number) => {
    const i = data.drafts.findIndex((x) => x.id === data.activeId);
    if (i < 0) return;
    const n = (i + dir + data.drafts.length) % data.drafts.length;
    update((d) => ({ ...d, activeId: data.drafts[n].id }));
  };

  // ---- Clipboard / insert / library ----
  const copy = () => {
    if (!active.text) return;
    invoke("copy_text", { text: active.text })
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };

  const insert = () => {
    if (!active.text.trim()) return;
    flushNow();
    invoke("prompt_insert", { text: active.text }).catch(() => {});
  };

  const copyEntry = (text: string) => invoke("copy_text", { text }).catch(() => {});

  const saveToLibrary = () => {
    if (!active.text.trim()) return;
    update((d) => ({
      ...d,
      library: [
        { ...active, id: crypto.randomUUID(), pinned: false, title: tabLabel(active, t("prompt.tabUntitled")), updatedAt: Date.now() },
        ...d.library,
      ],
    }));
  };

  const loadFromLibrary = (entry: Draft) =>
    update((d) => {
      const dr = { ...entry, id: crypto.randomUUID(), pinned: false, updatedAt: Date.now() };
      return { ...d, activeId: dr.id, drafts: [...d.drafts, dr] };
    });

  const deleteFromLibrary = (id: string) =>
    update((d) => ({ ...d, library: d.library.filter((e) => e.id !== id) }));

  /** Coach "+": scaffold the missing building block at the end of the draft. */
  const addCoachTemplate = (key: CoachKey) => {
    const base = active.text.replace(/\s+$/, "");
    setText((base ? base + "\n\n" : "") + t(`prompt.coach.tpl.${key}`));
    editorRef.current?.focus();
  };

  // ---- Window / view toggles ----
  const togglePin = () => {
    const next = !onTop;
    setOnTop(next);
    getCurrentWindow().setAlwaysOnTop(next).catch(() => {});
  };

  /** Cycle the glass intensity: clear → regular → rich. Persisted in config. */
  const cycleGlass = () => {
    const next = GLASS_LEVELS[(GLASS_LEVELS.indexOf(glass) + 1) % GLASS_LEVELS.length];
    setGlass(next);
    getConfig()
      .then((c) => setConfig({ ...c, prompt_console_glass: next }))
      .catch(() => {});
  };

  const toggleTarget = () => {
    const next = !asTarget;
    setAsTarget(next);
    getConfig()
      .then((c) => setConfig({ ...c, prompt_console_as_target: next }))
      .catch(() => setAsTarget(!next));
  };

  const toggleAutocorrect = () => {
    setAutocorrect((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("pc-autocorrect", next ? "1" : "0");
      } catch {
        /* private mode / blocked storage — pref just won't persist */
      }
      return next;
    });
  };

  /** Green traffic light: zoom to a comfortable large frame / restore. */
  const toggleZoom = async () => {
    try {
      const win = getCurrentWindow();
      const sf = await win.scaleFactor();
      if (zoomPrev.current) {
        const p = zoomPrev.current;
        zoomPrev.current = null;
        await win.setSize(new LogicalSize(p.w, p.h));
        await win.setPosition(new LogicalPosition(p.x, p.y));
      } else {
        const [pos, size, mon] = await Promise.all([win.outerPosition(), win.outerSize(), currentMonitor()]);
        if (!mon) return;
        zoomPrev.current = { x: pos.x / sf, y: pos.y / sf, w: size.width / sf, h: size.height / sf };
        const msf = mon.scaleFactor || 1;
        const mw = mon.size.width / msf;
        const mh = mon.size.height / msf;
        const mx = mon.position.x / msf;
        const my = mon.position.y / msf;
        const zw = Math.min(mw * 0.62, 1020);
        const zh = Math.min(mh * 0.74, 860);
        await win.setSize(new LogicalSize(zw, zh));
        await win.setPosition(new LogicalPosition(mx + (mw - zw) / 2, my + (mh - zh) / 2));
      }
    } catch {
      /* zoom is best-effort */
    }
  };

  const openCoach = () => {
    setCoachOpen(true);
    setLibOpen(false);
  };
  const openLibrary = () => {
    setLibOpen(true);
    setCoachOpen(false);
  };

  // ---- Bottom toast (undo for clear/correct + brief status) ----
  const showToast = (text: string, undo?: () => void) => {
    setToast({ text, undo });
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setToast(null), 8000);
  };

  // ---- AI-Coach: Refine via /v1/cleanup style "prompt" ----
  const runRefine = () => {
    const base = active.text;
    if (!base.trim() || refining) return;
    const id = ++refineReq.current;
    flushNow();
    setRefineErr(null);
    setRefineResult(null);
    setRefineView("diff");
    setRefining(true);
    invoke<string>("prompt_cleanup", { text: base, style: "prompt" })
      .then((res) => {
        if (id !== refineReq.current) return; // cancelled / superseded
        setRefining(false);
        if (!res || !res.trim() || res.trim() === base.trim()) {
          setRefineErr(t("prompt.refine.noChange"));
          return;
        }
        setRefineBase(base);
        setRefineResult(res);
      })
      .catch(() => {
        if (id !== refineReq.current) return;
        setRefining(false);
        setRefineErr(t("prompt.refine.failed"));
      });
  };

  const cancelRefine = () => {
    refineReq.current++; // ignore any in-flight result
    setRefining(false);
    setRefineResult(null);
  };

  const acceptRefine = () => {
    if (refineResult) setText(refineResult);
    refineReq.current++;
    setRefineResult(null);
    setRefining(false);
    editorRef.current?.focus();
  };

  // ---- "Leeren": wipe the active tab, with an undo snapshot (never lost). ----
  const clearActive = () => {
    const base = active.text;
    if (!base) return; // already empty
    setText("");
    editorRef.current?.focus();
    showToast(t("prompt.clear.undo"), () => {
      setText(base);
      setToast(null);
      editorRef.current?.focus();
    });
  };

  // ---- "Korrigieren": one-click tidy pass over the whole text, with undo. ----
  const runCorrect = () => {
    const base = active.text;
    if (!base.trim() || correcting) return;
    flushNow();
    setCorrecting(true);
    invoke<string>("prompt_cleanup", { text: base, style: "tidy" })
      .then((res) => {
        setCorrecting(false);
        if (!res || !res.trim() || res.trim() === base.trim()) {
          showToast(t("prompt.correct.noChange"));
          return;
        }
        setText(res);
        showToast(t("prompt.correct.done"), () => {
          setText(base);
          setToast(null);
          editorRef.current?.focus();
        });
      })
      .catch(() => {
        setCorrecting(false);
        showToast(t("prompt.correct.failed"));
      });
  };

  /** Close/minimize: flush, then hand over to Rust — it emits the genie-out
   *  event back to us, we animate into the pill and call hide_now. */
  const hide = () => {
    flushNow();
    invoke("prompt_console_toggle").catch(() => {});
  };

  // ---- Click-to-dictate (mic button) ----
  // Restore the hotkey + the config we temporarily changed, and reset UI.
  const endMicSession = async () => {
    micActive.current = false;
    setMicRecording(false);
    setLivePartial("");
    await invoke("hotkey_set_suspended", { suspended: false }).catch(() => {});
    const prev = micPrev.current;
    micPrev.current = null;
    if (prev) {
      try {
        const cfg = await getConfig();
        await setConfig({ ...cfg, prompt_console_as_target: prev.asTarget, streaming_mode: prev.streaming });
      } catch {
        /* best-effort restore */
      }
    }
  };

  const startMic = async () => {
    if (micRecording) return;
    let cfg;
    try {
      cfg = await getConfig();
    } catch {
      showToast(t("prompt.mic.failed"));
      return;
    }
    // Remember + override: route the result into THIS window, and run streaming
    // in FINAL mode so partials stream as a preview but are never typed into the
    // app behind (only "live" mode injects). Restored in endMicSession.
    micPrev.current = { asTarget: cfg.prompt_console_as_target, streaming: cfg.streaming_mode };
    setMicRecording(true);
    micActive.current = true;
    setLivePartial("");
    try {
      await setConfig({ ...cfg, prompt_console_as_target: true, streaming_mode: "final" });
      await invoke("hotkey_set_suspended", { suspended: true });
      await invoke("start_recording");
    } catch {
      showToast(t("prompt.mic.failed"));
      await endMicSession();
    }
  };

  /** Stop + transcribe: the finished text routes via the queue → drainPending. */
  const stopMic = async () => {
    if (!micRecording) return;
    micActive.current = false; // stop showing partials immediately
    setLivePartial("");
    try {
      await invoke("stop_and_transcribe");
    } catch {
      showToast(t("prompt.mic.failed"));
    }
    await endMicSession();
  };

  /** Abort without transcribing (Esc). */
  const cancelMic = async () => {
    if (!micRecording) return;
    micActive.current = false;
    await invoke("cancel_recording").catch(() => {});
    await endMicSession();
  };

  const toggleMic = () => {
    if (micRecording) void stopMic();
    else void startMic();
  };

  // ---- Command palette (⌘P) ----
  const palItems: PalCmd[] = [
    { id: "new", label: t("prompt.cmd.newTab"), run: addTab },
    { id: "close", label: t("prompt.cmd.closeTab"), run: closeActive },
    { id: "dup", label: t("prompt.cmd.duplicate"), run: () => duplicateTab(data.activeId) },
    { id: "pin", label: t(active.pinned ? "prompt.cmd.unpin" : "prompt.cmd.pin"), run: () => togglePinTab(data.activeId) },
    { id: "copy", label: t("prompt.cmd.copy"), run: copy },
    { id: "insert", label: t("prompt.cmd.insert"), run: insert },
    { id: "mic", label: t(micRecording ? "prompt.cmd.micStop" : "prompt.cmd.mic"), run: toggleMic },
    { id: "save", label: t("prompt.cmd.saveToLibrary"), run: saveToLibrary },
    { id: "refine", label: t("prompt.cmd.refine"), run: runRefine },
    { id: "correct", label: t("prompt.cmd.correct"), run: runCorrect },
    { id: "clear", label: t("prompt.cmd.clear"), run: clearActive },
    { id: "autocorrect", label: t("prompt.cmd.autocorrect"), run: toggleAutocorrect },
    { id: "coach", label: t("prompt.cmd.coach"), run: openCoach },
    { id: "lib", label: t("prompt.cmd.library"), run: openLibrary },
    { id: "glass", label: t("prompt.cmd.glass"), run: cycleGlass },
    { id: "target", label: t("prompt.cmd.target"), run: toggleTarget },
    ...data.drafts.map((dr) => ({
      id: "tab:" + dr.id,
      label: `${t("prompt.cmd.tabPrefix")} ${tabLabel(dr, t("prompt.tabUntitled"))}`,
      run: () => update((d) => ({ ...d, activeId: dr.id })),
    })),
    ...data.library.map((e) => ({
      id: "lib:" + e.id,
      label: `${t("prompt.cmd.libPrefix")} ${e.title || tabLabel(e, t("prompt.tabUntitled"))}`,
      run: () => loadFromLibrary(e),
    })),
  ];
  const pq = paletteQuery.trim().toLowerCase();
  const palFiltered = pq ? palItems.filter((c) => c.label.toLowerCase().includes(pq)) : palItems;
  const palIdx = Math.min(paletteIdx, Math.max(0, palFiltered.length - 1));

  const openPalette = () => {
    setPaletteQuery("");
    setPaletteIdx(0);
    setPaletteOpen(true);
  };
  const runPal = (c: PalCmd) => {
    setPaletteOpen(false);
    c.run();
  };

  actions.current = {
    paletteOpen,
    insert,
    copy,
    newTab: addTab,
    closeActive,
    duplicate: () => duplicateTab(data.activeId),
    clear: clearActive,
    jumpTo,
    cycle,
    togglePalette: () => (paletteOpen ? setPaletteOpen(false) : openPalette()),
    escape: () => {
      if (paletteOpen) return setPaletteOpen(false);
      if (micRecording) return void cancelMic();
      if (refining || refineResult) return cancelRefine();
      if (menu) return setMenu(null);
      if (renaming) return setRenaming(null);
      hide();
    },
  };

  const menuDraft = menu ? data.drafts.find((x) => x.id === menu.id) : null;
  const diffSegs =
    refineResult && refineBase.length + refineResult.length < DIFF_TOKEN_CAP * 12
      ? wordDiff(refineBase, refineResult)
      : null;

  return (
    <div
      ref={stageRef}
      className="pc-stage pc-boot"
      data-glass={glass}
      data-pc-theme={pcTheme}
      style={{ "--pc-glass": GLASS_MUL[glass] } as CSSProperties}
    >
      <Silhouette w={winSize.w} h={winSize.h} bump={bumpDraw} glass={GLASS_MUL[glass]} theme={pcTheme} flat={!blurOn} />
      {/* Genie flight frost — clipped to the SAME silhouette string the SVG
          renders NaN-free (never synthesize a new polygon: one NaN silently
          drops the whole clip-path — v0.5.99 lesson). Falls back to the DIV's
          border box if the path is degenerate. */}
      {(() => {
        const fp =
          winSize.w > 0 && winSize.h > 0
            ? silhouettePath(winSize.w, winSize.h, bumpDraw)
            : "";
        const clip = fp && !fp.includes("NaN") ? `path("${fp}")` : undefined;
        return (
          <div
            ref={frostRef}
            className="pc-frost"
            style={{ clipPath: clip, background: frostBg } as CSSProperties}
            aria-hidden="true"
          />
        );
      })()}

      <div className="pc-shell">
        {/* ---- Chrome strip: traffic lights (macOS) / window controls (Windows),
             and the tabs. The ACTIVE tab is drawn by the silhouette — the
             outline of the window rises around it. ---- */}
        <div className="pc-strip" data-tauri-drag-region>
          {!IS_WINDOWS && (
            <div className="pc-lights">
              <button className="pc-light close" title={t("prompt.win.close")} onClick={hide}>
                <svg viewBox="0 0 12 12">
                  <path d="M3.2 3.2l5.6 5.6M8.8 3.2L3.2 8.8" />
                </svg>
              </button>
              <button className="pc-light min" title={t("prompt.win.min")} onClick={hide}>
                <svg viewBox="0 0 12 12">
                  <path d="M2.6 6h6.8" />
                </svg>
              </button>
              <button className="pc-light zoom" title={t("prompt.win.zoom")} onClick={() => void toggleZoom()}>
                <svg viewBox="0 0 12 12">
                  <path d="M6 2.6v6.8M2.6 6h6.8" />
                </svg>
              </button>
            </div>
          )}

          <div className="pc-tabrow" ref={tabRowRef} data-tauri-drag-region>
            {data.drafts.map((dr) => (
              <div
                key={dr.id}
                ref={(el) => {
                  if (el) tabEls.current.set(dr.id, el);
                  else tabEls.current.delete(dr.id);
                }}
                className={`pc-tab ${dr.id === data.activeId ? "active" : ""} ${dr.pinned ? "pinned" : ""} ${
                  dragOverId === dr.id ? "drop-target" : ""
                }`}
                draggable={renaming !== dr.id}
                onClick={() => update((d) => ({ ...d, activeId: dr.id }))}
                onDoubleClick={() => setRenaming(dr.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ id: dr.id, x: e.clientX, y: e.clientY });
                }}
                onDragStart={() => (dragId.current = dr.id)}
                onDragOver={(e) => {
                  if (dragId.current && dragId.current !== dr.id) {
                    e.preventDefault();
                    if (dragOverId !== dr.id) setDragOverId(dr.id);
                  }
                }}
                onDragLeave={() => setDragOverId((id) => (id === dr.id ? null : id))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId.current) reorderTab(dragId.current, dr.id);
                  dragId.current = null;
                  setDragOverId(null);
                }}
                onDragEnd={() => {
                  dragId.current = null;
                  setDragOverId(null);
                }}
                title={t("prompt.tabHint")}
              >
                {dr.pinned && (
                  <span className="pc-tab-pin" title={t("prompt.menu.unpin")}>
                    <Ico paths={ICONS.pin} filled size={10} />
                  </span>
                )}
                {renaming === dr.id ? (
                  <input
                    className="pc-rename"
                    autoFocus
                    defaultValue={dr.title}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      rename(dr.id, e.target.value);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setRenaming(null);
                      e.stopPropagation();
                    }}
                  />
                ) : (
                  <>
                    <span className="pc-tab-label">{tabLabel(dr, t("prompt.tabUntitled"))}</span>
                    {!dr.pinned && (
                      <span
                        className="pc-tab-x"
                        title={dr.text.trim() ? t("prompt.tabArchive") : t("prompt.tabClose")}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(dr.id);
                        }}
                      >
                        <Ico paths={ICONS.x} size={9} />
                      </span>
                    )}
                  </>
                )}
              </div>
            ))}
            <button className="pc-tab-add" title={t("prompt.newTab")} onClick={addTab}>
              <Ico paths={ICONS.plus} size={13} />
            </button>
          </div>

          {IS_WINDOWS && (
            <div className="pc-winctl">
              <button title={t("prompt.win.min")} onClick={hide}>
                <Ico paths={ICONS.minus} size={13} />
              </button>
              <button className="close" title={t("prompt.win.close")} onClick={hide}>
                <Ico paths={ICONS.x} size={12} />
              </button>
            </div>
          )}
        </div>

        {/* ---- Pane: toolbar + editor + footer, clipped to the silhouette. ---- */}
        <div className="pc-main">
          <header className="pc-head" data-tauri-drag-region>
            <span className="pc-glyph" data-tauri-drag-region>✦</span>
            <span className="pc-title" data-tauri-drag-region>{t("prompt.title")}</span>
            <div className="pc-head-actions">
              <button className="pc-icon" title={t("prompt.paletteHint")} onClick={openPalette}>
                <Ico paths={ICONS.search} size={15} />
              </button>
              <button
                className={`pc-icon ${autocorrect ? "on" : ""}`}
                title={t("prompt.autocorrect", { state: t(autocorrect ? "common.on" : "common.off") })}
                onClick={toggleAutocorrect}
              >
                <Ico paths={ICONS.spell} size={15} />
              </button>
              <button className="pc-icon" title={t("prompt.glass", { level: t(`prompt.glassLevel.${glass}`) })} onClick={cycleGlass}>
                <Ico paths={ICONS.drop} size={15} />
              </button>
              <button
                className={`pc-icon ${asTarget ? "on" : ""}`}
                title={t("prompt.targetHint")}
                onClick={toggleTarget}
              >
                <Ico paths={ICONS.mic} size={15} />
              </button>
              <button className={`pc-icon ${onTop ? "on" : ""}`} title={t("prompt.pin")} onClick={togglePin}>
                <Ico paths={ICONS.pin} size={15} />
              </button>
            </div>
          </header>

          <div className="pc-body">
            <textarea
              ref={editorRef}
              className={`pc-editor ${flash ? "pc-flash" : ""}`}
              value={active.text}
              placeholder={t("prompt.placeholder")}
              spellCheck={autocorrect}
              autoCorrect={autocorrect ? "on" : "off"}
              autoCapitalize="off"
              onChange={(e) => setText(e.target.value)}
            />
            {coachOpen && (
              <div className="pc-coach">
                <div className="pc-coach-head">
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Ico paths={ICONS.bolt} filled size={12} /> {t("prompt.coach.title")}
                  </span>
                  <div className="pc-score">
                    <div className="pc-score-fill" style={{ width: `${score}%` }} />
                  </div>
                  <span className="pc-score-num">{score}%</span>
                </div>
                <div className="pc-refine-bar">
                  <div className="pc-refine-row">
                    <button
                      className="pc-btn refine"
                      onClick={runCorrect}
                      disabled={correcting || refining || !active.text.trim()}
                      title={t("prompt.correct.hint")}
                    >
                      <Ico paths={ICONS.check} size={13} />
                      {correcting ? t("prompt.correct.loading") : t("prompt.correct.button")}
                    </button>
                    <button
                      className="pc-btn primary refine"
                      onClick={runRefine}
                      disabled={refining || correcting || !active.text.trim()}
                      title={t("prompt.refine.hint")}
                    >
                      <Ico paths={ICONS.spark} filled size={12} />
                      {refining ? t("prompt.refine.loading") : t("prompt.refine.button")}
                    </button>
                  </div>
                  {refineErr && <span className="pc-refine-err">{refineErr}</span>}
                </div>
                <div className="pc-coach-list">
                  {score === 100 && <div className="pc-coach-all">✓ {t("prompt.coach.allGood")}</div>}
                  {/* All 7 building blocks, ALWAYS in the same order — rows change
                      state in place instead of jumping between sections while the
                      user types. */}
                  {COACH_KEYS.map((k) => (
                    <div key={k} className={`pc-coach-row ${checks[k] ? "met" : ""}`}>
                      <div className="pc-coach-top">
                        <span className="pc-coach-name">{t(`prompt.coach.name.${k}`)}</span>
                        {checks[k] ? (
                          <span className="pc-coach-ok">
                            <span className="pc-check">✓</span> {t(`prompt.coach.ok.${k}`)}
                          </span>
                        ) : (
                          <button className="pc-btn" onClick={() => addCoachTemplate(k)}>
                            {t("prompt.coach.add")}
                          </button>
                        )}
                      </div>
                      {!checks[k] && <div className="pc-coach-q">{t(`prompt.coach.q.${k}`)}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {libOpen && (
              <div className="pc-lib">
                <div className="pc-lib-head">
                  <span>{t("prompt.library")}</span>
                  <div className="pc-lib-search">
                    <Ico paths={ICONS.search} size={11} />
                    <input
                      value={libQuery}
                      placeholder={t("prompt.librarySearch")}
                      spellCheck={false}
                      onChange={(e) => setLibQuery(e.target.value)}
                    />
                  </div>
                  <button className="pc-btn" onClick={saveToLibrary} disabled={!active.text.trim()}>
                    {t("prompt.saveToLibrary")}
                  </button>
                </div>
                <div className="pc-lib-list">
                  {data.library.length === 0 && <div className="pc-lib-empty">{t("prompt.libraryEmpty")}</div>}
                  {data.library.length > 0 && libFiltered.length === 0 && (
                    <div className="pc-lib-empty">{t("prompt.libraryNoMatch")}</div>
                  )}
                  {libFiltered.map((e) => (
                    <div key={e.id} className="pc-lib-row" onClick={() => loadFromLibrary(e)} title={e.text.slice(0, 400)}>
                      <div className="pc-lib-meta">
                        <span className="pc-lib-title">{e.title || t("prompt.tabUntitled")}</span>
                        <span className="pc-lib-sub">
                          {e.text.length} · {new Date(e.updatedAt).toLocaleDateString()}
                        </span>
                      </div>
                      <button
                        className="pc-icon"
                        title={t("prompt.libraryCopy")}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          copyEntry(e.text);
                        }}
                      >
                        <Ico paths={ICONS.copy} size={12} />
                      </button>
                      <button
                        className="pc-icon"
                        title={t("prompt.libraryDelete")}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          deleteFromLibrary(e.id);
                        }}
                      >
                        <Ico paths={ICONS.trash} size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(refining || refineResult) && (
              <div className="pc-refine">
                <div className="pc-refine-head">
                  <span className="pc-refine-title">
                    <Ico paths={ICONS.spark} filled size={12} /> {t("prompt.refine.title")}
                  </span>
                  {refineResult && diffSegs && (
                    <div className="pc-seg">
                      <button
                        className={refineView === "diff" ? "on" : ""}
                        onClick={() => setRefineView("diff")}
                      >
                        {t("prompt.refine.viewDiff")}
                      </button>
                      <button
                        className={refineView === "result" ? "on" : ""}
                        onClick={() => setRefineView("result")}
                      >
                        {t("prompt.refine.viewResult")}
                      </button>
                    </div>
                  )}
                </div>
                <div className="pc-refine-body">
                  {refining ? (
                    <div className="pc-refine-loading">
                      <span className="pc-spinner" />
                      {t("prompt.refine.loading")}
                    </div>
                  ) : refineView === "diff" && diffSegs ? (
                    <div className="pc-diff">
                      {diffSegs.map((s, i) => (
                        <span key={i} className={`pc-d-${s.type}`}>
                          {s.text}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="pc-diff">{refineResult}</div>
                  )}
                </div>
                {refineResult && (
                  <div className="pc-refine-foot">
                    <button className="pc-btn" onClick={cancelRefine}>
                      {t("prompt.refine.reject")}
                    </button>
                    <button className="pc-btn primary" onClick={acceptRefine}>
                      {t("prompt.refine.accept")}
                    </button>
                  </div>
                )}
              </div>
            )}
            {toast && (
              <div className="pc-undo">
                <span className="pc-undo-text">{toast.text}</span>
                {toast.undo && (
                  <button className="pc-undo-btn" onClick={toast.undo}>
                    {t("prompt.clear.undoAction")}
                  </button>
                )}
              </div>
            )}
            {micRecording && (
              <div className="pc-dictate">
                <span className="pc-dictate-dot" />
                <span className="pc-dictate-text">{livePartial || t("prompt.mic.listening")}</span>
                <button className="pc-dictate-stop" onClick={() => void stopMic()}>
                  <Ico paths={ICONS.stop} size={11} /> {t("prompt.mic.stopShort")}
                </button>
              </div>
            )}
          </div>

          <footer className="pc-foot">
            <span className="pc-count">
              {chars} · {words} {t("prompt.words")} · ~{tokens} {t("prompt.tokens")}
            </span>
            <div className="pc-foot-actions">
              <button
                className={`pc-btn ghost mic ${micRecording ? "rec" : ""}`}
                title={t(micRecording ? "prompt.mic.stop" : "prompt.mic.start")}
                onClick={toggleMic}
              >
                <Ico paths={micRecording ? ICONS.stop : ICONS.micOn} filled={micRecording} size={14} />
              </button>
              <button
                className={`pc-btn ghost ${coachOpen ? "on" : ""}`}
                title={t("prompt.coach.title")}
                onClick={() => (coachOpen ? setCoachOpen(false) : openCoach())}
              >
                <span className="pc-dots">
                  {COACH_KEYS.map((k) => (
                    <i key={k} className={checks[k] ? "on" : ""} />
                  ))}
                </span>
                {score}%
              </button>
              <button
                className={`pc-btn ghost ${libOpen ? "on" : ""}`}
                title={t("prompt.library")}
                onClick={() => (libOpen ? setLibOpen(false) : openLibrary())}
              >
                <Ico paths={ICONS.lib} size={13} />
              </button>
              <button className="pc-btn ghost" onClick={clearActive} disabled={!active.text} title={t("prompt.clear.hint")}>
                <Ico paths={ICONS.eraser} size={14} />
              </button>
              <button className="pc-btn" onClick={copy} disabled={!active.text} title={t("prompt.copyHint")}>
                {copied ? t("prompt.copied") : t("prompt.copy")}
              </button>
              <button className="pc-btn primary" onClick={insert} disabled={!active.text.trim()} title={t("prompt.insertHint")}>
                {t("prompt.insert")}
              </button>
            </div>
          </footer>
        </div>
      </div>

      {/* Tab context menu (right-click) */}
      {menu && menuDraft && (
        <>
          <div
            className="pc-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="pc-menu" style={{ top: menu.y, left: Math.min(menu.x, window.innerWidth - 168) }}>
            <button onClick={() => { setRenaming(menu.id); setMenu(null); }}>{t("prompt.menu.rename")}</button>
            <button onClick={() => { duplicateTab(menu.id); setMenu(null); }}>{t("prompt.menu.duplicate")}</button>
            <button onClick={() => { togglePinTab(menu.id); setMenu(null); }}>
              {t(menuDraft.pinned ? "prompt.menu.unpin" : "prompt.menu.pin")}
            </button>
            <button
              className="danger"
              onClick={() => { closeTab(menu.id); setMenu(null); }}
            >
              {menuDraft.text.trim() ? t("prompt.menu.archive") : t("prompt.menu.close")}
            </button>
          </div>
        </>
      )}

      {/* Command palette (⌘P) */}
      {paletteOpen && (
        <>
          <div className="pc-backdrop" onClick={() => setPaletteOpen(false)} />
          <div className="pc-palette">
            <div className="pc-palette-input">
              <Ico paths={ICONS.cmd} size={13} />
              <input
                autoFocus
                value={paletteQuery}
                placeholder={t("prompt.palette.placeholder")}
                spellCheck={false}
                onChange={(e) => {
                  setPaletteQuery(e.target.value);
                  setPaletteIdx(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setPaletteIdx((i) => Math.min(i + 1, palFiltered.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setPaletteIdx((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    const c = palFiltered[palIdx];
                    if (c) runPal(c);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setPaletteOpen(false);
                  }
                  e.stopPropagation();
                }}
              />
            </div>
            <div className="pc-palette-list">
              {palFiltered.length === 0 && <div className="pc-palette-empty">{t("prompt.palette.empty")}</div>}
              {palFiltered.map((c, i) => (
                <div
                  key={c.id}
                  className={`pc-palette-row ${i === palIdx ? "active" : ""}`}
                  onMouseEnter={() => setPaletteIdx(i)}
                  onClick={() => runPal(c)}
                >
                  {c.label}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
