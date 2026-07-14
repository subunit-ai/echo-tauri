// Shared orb renderer — the single source of truth for how every orb style is
// drawn. Both the floating overlay (src/overlay/Orb.tsx) and the in-app live
// configurator preview (src/overlay/OrbCanvas.tsx) call `drawOrb` each frame so
// what you tweak in Settings looks EXACTLY like the real overlay.
//
// The function is pure w.r.t. its inputs except for the per-frame animation
// scratch it advances (`OrbAnim`: time, frame counter, in-flight rings/blips,
// peak-hold caps, slow level average) — keep one OrbAnim per canvas.
import type { EngineState } from "../lib/ipc";

export interface OrbColors {
  idle: string;
  working: string;
  done: string;
  error: string;
}

export interface OrbVisual {
  style: string;
  colors: OrbColors;
  idlePulse: boolean;
  idleMode: "normal" | "dim" | "hide";
  speed: number;
  /** Materialize animation when the orb (re)appears after being hidden:
   *  "bloom" (light condenses into the orb — the standard) | "pop" (spring
   *  scale) | "fade" (plain fade-in) | "none". Undefined = "bloom". */
  appear?: string;
  /** Pill color mode: "color" (state colors, default) | "idle_glass" (frost
   *  at rest, colors while working) | "glass" (always colorless liquid
   *  glass — only the motion tells the state). */
  pillColorMode?: string;
  /** Pill reaction type (governs the V2 dome pill's bars): "dynamik" (default —
   *  per-bar character: own frequency colouring + own attack/release) |
   *  "klassisch" (the v0.5.109 centre-out response). Orthogonal to the pill
   *  SHAPE (pill = V2 dome, pillv1 = original 5-bar). */
  pillReaction?: string;
  /** Pill VISUALIZER — what plays inside the V2 dome pill while speaking:
   *  "standard" (default — the nine spectrum bars, exactly as before) |
   *  "laufband" (loudness history flows right → left through the bars) |
   *  "zentrum" (history enters at the centre and drifts out to both rims) |
   *  "welle" (one continuous glowing waveform ribbon) | "matrix" (discrete
   *  LED dots, retro VU). Resting look (dots) is shared by all of them. */
  pillVisual?: string;
  /** Pill ILLUMINATION — an opt-in light inside the glass: "aus" (default —
   *  the neutral capsule, color only in the bars) | "status" (the glass glows
   *  in the state color and follows the voice) | "siri" (a multicolor aurora
   *  whose hues ride the voice's timbre — bass blue … treble pink). */
  pillGlow?: string;
}

/** Neutral frost tone for the colorless pill modes. */
const FROST = "#e2eefb";

/** Mutable per-canvas animation scratch — advanced in place by `drawOrb`. */
export interface OrbAnim {
  t: number;
  frame: number;
  rings: { r: number; a0: number }[];
  blips: { ang: number; dist: number; a: number }[];
  peaks: number[];
  lvlAvg: number;
  /** Onset-driven envelope (0..1, decays) — styles that "flare" on syllables
   *  (nova/droplet) bump this on a voice spike and let it fall. */
  pulse: number;
  /** Smoothed per-band spectrum envelope (16 entries, 0..1): fast attack,
   *  gentle release — fed from the REAL mic spectrum when the caller provides
   *  one, otherwise from a voice-plausible synthetic fallback (previews). */
  bandEnv: number[];
  /** Rolling level history for the ★ Oscilloscope style (newest last). */
  hist: number[];
  /** Particle field for the ★ Nebula style (lazily seeded, deterministic). */
  parts: { d: number; a0: number; sz: number; v: number }[];
  /** Per-spoke peak-hold caps for the ★ Spectra style. */
  caps: number[];
  /** Materialize envelope (0..1): 0 right after mount or after the orb was
   *  hidden (idle mode "hide"), ramping to 1 over ~0.65 s. drawOrb resets it
   *  to 0 on every hidden frame — so the orb re-materializes each time it
   *  comes back, in the overlay AND the configurator preview alike. */
  appear: number;
  /** Smoothed state color (RGB) — lerped toward the target each frame so
   *  state changes ease instead of hard-cutting (TJ). Null until first frame. */
  col: number[] | null;
  /** Smoothed per-bar heights for the ★ pill — every state edge (release →
   *  transcribing → idle) morphs instead of jumping, so the bars never flash
   *  up collectively when a session ends (TJ). Null until first pill frame. */
  barH: number[] | null;
  /** Per-band auto-gain peaks (slow decay): each band normalises against its
   *  own recent maximum, so the treble bands — tiny in absolute dB even with
   *  the recorder's tilt — get a full visual range and quiet voices still
   *  drive the pill (TJ: only the left bars ever moved). Null until used. */
  bandAgc: number[] | null;
  /** Rolling loudness history for the pill's flow visuals (laufband/zentrum/
   *  welle): one sample per frame, newest first. Always advanced inside the
   *  pill case (cheap) so switching variants mid-session starts seamless. */
  pillHist: number[];
  /** Smoothed spectral centroid (0 bass … 1 sibilance) for the pill glow —
   *  the light's position/hue rides the voice's timbre. */
  pillCent: number;
  /** Word train for the ★ "Worte" pill visual — recognised words flowing
   *  right → left through the glass (fed by echo://stream-partial). `wpx` is
   *  the cached measured width, `x` the animated left edge. */
  words: { w: string; x: number; wpx: number }[];
  /** How many words of the current live partial have been consumed. */
  wordCount: number;
  /** Particle pool for the ★ "Funken" pill visual (deterministic spawn —
   *  no Math.random, previews and overlay stay reproducible). */
  sparks: { x: number; y: number; vx: number; vy: number; life: number; sz: number }[];
}

export function newOrbAnim(): OrbAnim {
  return {
    t: 0,
    frame: 0,
    rings: [],
    blips: [],
    peaks: new Array(16).fill(0),
    lvlAvg: 0,
    pulse: 0,
    bandEnv: new Array(16).fill(0),
    hist: [],
    parts: [],
    caps: [],
    appear: 0,
    col: null,
    barH: null,
    bandAgc: null,
    pillHist: [],
    pillCent: 0.5,
    words: [],
    wordCount: 0,
    sparks: [],
  };
}

function hexRgb(hex: string): number[] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

function rgbHex(c: number[]): string {
  const p = (n: number) =>
    Math.round(Math.max(0, Math.min(255, n)))
      .toString(16)
      .padStart(2, "0");
  return `#${p(c[0])}${p(c[1])}${p(c[2])}`;
}

/** easeOutBack: starts at 0, overshoots past 1 (~1.1), settles at 1 — the
 *  spring feel for materialize scaling. */
function backOut(p: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}

function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Draw ONE frame of the orb into `ctx` (a 2D context sized w×h in device pixels).
 * `st` is the visual engine state, `level` the 0..1 mic energy. `an` carries the
 * animation forward between calls. `bands` is the optional REAL 16-band voice
 * spectrum (0..1 each, bass→sibilance) from `mic_features`; when omitted (e.g.
 * the configurator preview without a mic) a synthetic voice-shaped spectrum is
 * derived from `level` so every style still comes alive. `text` is the live
 * stable partial transcript (echo://stream-partial) — only the ★ "Worte" pill
 * visual consumes it; everything else ignores it. Returns nothing; mutates
 * `ctx` and `an`.
 */
export function drawOrb(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  v: OrbVisual,
  st: EngineState,
  level: number,
  an: OrbAnim,
  bands?: number[],
  text?: string,
): void {
  // Animation speed (TJ: the default cadence felt too fast — now adjustable).
  // `t` (scaled) drives every continuous frequency below; `frame` (real frames)
  // drives the discrete ping-ring spawn cadence so its modulo stays integer.
  const sp = Math.max(0.2, Math.min(2, v.speed));
  an.frame += 1;
  an.t += sp;
  const t = an.t;
  const frame = an.frame;
  const rings = an.rings;
  const blips = an.blips;
  const peaks = an.peaks;
  const cx = w / 2;
  const cy = h / 2;
  const size = Math.min(w, h);
  // NaN-Härtung: ein einziger non-finiter Level-/Band-Frame (CoreAudio-Glitch,
  // Geräte-Wechsel mitten im Diktat) würde sonst durch JEDE Glättung
  // (bandEnv/agc/barH/lvlAvg) für immer weitergereicht — der Orb wäre bis zum
  // App-Neustart tot. Non-finit wird hier und an den Envelope-Sites auf einen
  // sicheren Wert gesetzt → selbstheilend statt sticky.
  const lvl = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  // The pill treats "done" as plain idle: its confirmation is the pasted text
  // itself — the 700 ms all-bars flash in the done color on release read as a
  // glitch (TJ; state colors stay reserved for real working feedback).
  const isPillStyle =
    v.style === "pill" || v.style === "pill2" || v.style === "pillv1";
  const stP = isPillStyle && st === "done" ? "idle" : st;
  // idle → idle · recording/transcribing → working · done → done · error → error.
  const stateColor =
    stP === "recording" || stP === "transcribing"
      ? v.colors.working
      : stP === "done"
        ? v.colors.done
        : stP === "error"
          ? v.colors.error
          : v.colors.idle;
  // Pill color modes: "glass" = always frost (colorless liquid glass), and
  // "idle_glass" = frost at rest, state colors only while working.
  const pillMode = v.pillColorMode ?? "color";
  const colTarget =
    isPillStyle &&
    (pillMode === "glass" || (pillMode === "idle_glass" && stP === "idle"))
      ? FROST
      : stateColor;
  // Smooth state-color transitions (TJ: the hard cuts felt abrupt) — one
  // lerped RGB per canvas eases every switch; ALL styles benefit. 0.08/frame
  // ≈ half a second to ~90 % (0.16 still read as a cut to TJ, v0.5.97).
  {
    const t3 = hexRgb(colTarget);
    if (!an.col) an.col = t3;
    else for (let i = 0; i < 3; i++) an.col[i] += (t3[i] - an.col[i]) * 0.08;
  }
  const base = rgbHex(an.col);
  const dotR = size * 0.1;
  // When idle animation is OFF, freeze every style's time-based motion so the
  // orb truly rests — the audio-track styles (bars/wave) then react ONLY to
  // real speech while recording, not to a constant idle shimmer. `ph` is the
  // frozen phase fed to the per-style oscillators.
  const idleStill = stP === "idle" && !v.idlePulse;
  const ph = idleStill ? 0 : t;

  ctx.clearRect(0, 0, w, h);

  // Idle behaviour: "hide" → render nothing (canvas already cleared); "dim" →
  // draw at reduced opacity (a calm, semi-transparent resting orb instead of
  // vanishing); "normal" → full strength.
  if (st === "idle" && v.idleMode === "hide") {
    an.appear = 0; // re-materialize the next time the orb shows
    return;
  }
  ctx.globalAlpha = st === "idle" && v.idleMode === "dim" ? 0.32 : 1;

  // ---- Materialize (appear) envelope -----------------------------------------
  // Plays after mount and every time the orb comes back from hidden (idle mode
  // "hide" → recording). Fixed cadence (~0.65 s @ 60 fps), deliberately NOT
  // scaled by v.speed — it's a UI transition, not part of the style's rhythm.
  const apStyle = v.appear ?? "bloom";
  // ~0.95 s statt 0.65 s — das Materialize las sich als zu abrupt (TJ).
  an.appear = apStyle === "none" ? 1 : Math.min(1, an.appear + 1 / 58);
  const ap = an.appear;
  ctx.save(); // paired with the restore right after the style switch
  let bloomA = 0; // strength of the additive light flash drawn on top
  if (ap < 1) {
    const easeOut = 1 - Math.pow(1 - ap, 3);
    if (apStyle === "fade") {
      ctx.globalAlpha *= easeOut;
    } else if (apStyle === "pop") {
      const s = 0.7 + 0.3 * backOut(ap);
      ctx.translate(cx, cy);
      ctx.scale(s, s);
      ctx.translate(-cx, -cy);
      ctx.globalAlpha *= Math.min(1, ap * 1.8);
    } else {
      // "bloom" — the standard: light condenses into the orb. The body springs
      // 0.7 → ~1.04 → 1 while a bright flash peaks early and dissolves into
      // the style's own ambient glow.
      const s = 0.82 + 0.18 * backOut(ap);
      ctx.translate(cx, cy);
      ctx.scale(s, s);
      ctx.translate(-cx, -cy);
      ctx.globalAlpha *= Math.min(1, ap * 1.6);
      bloomA = Math.sin(Math.min(1, ap * 1.25) * Math.PI) * 0.85;
    }
  }

  // breathing factor for idle / transcribing
  const breathe =
    st === "transcribing"
      ? 0.5 + 0.5 * Math.sin(t * 0.18)
      : st === "idle"
        ? v.idlePulse
          ? 0.55 + 0.45 * Math.sin(t * 0.05)
          : 0.7
        : 1;
  // While recording, energy is voice-dominated with only a small floor, so every
  // style visibly reacts to how loud you speak (not a constant idle shimmer).
  const energy = st === "recording" ? 0.12 + lvl * 0.88 : breathe * 0.6;
  const speaking = st === "recording";

  // ---- Per-band spectrum envelope --------------------------------------------
  // Advance `an.bandEnv` (16 bands, bass→sibilance) every frame: instant-ish
  // attack so a syllable pops the moment it lands, gentle release so bands sink
  // instead of flickering. Real spectrum when the caller provides one, otherwise
  // a synthetic voice-shaped fallback (lows follow the envelope, highs flutter)
  // so the configurator preview behaves like a live session.
  const haveBands = !!bands && bands.length > 0;
  for (let i = 0; i < 16; i++) {
    let raw = 0;
    if (speaking) {
      if (haveBands) {
        const x = (i / 15) * (bands.length - 1);
        const lo = Math.floor(x);
        const hi = Math.min(bands.length - 1, lo + 1);
        raw = bands[lo] + (bands[hi] - bands[lo]) * (x - lo);
      } else {
        raw =
          lvl *
          (0.55 + 0.45 * Math.sin(ph * (0.31 + i * 0.037) + i * 2.1)) *
          (1 - (i / 15) * 0.35);
      }
    }
    // Selbstheilung: non-finite Werte (NaN/Inf aus einem Audio-Glitch) niemals
    // in die Envelope lassen UND eine bereits vergiftete Envelope zurücksetzen.
    if (!Number.isFinite(raw)) raw = 0;
    const prev = Number.isFinite(an.bandEnv[i]) ? an.bandEnv[i] : 0;
    raw = Math.min(1, Math.max(0, raw));
    an.bandEnv[i] = raw > prev ? prev * 0.4 + raw * 0.6 : prev * 0.82 + raw * 0.18;
  }
  /** Smoothed band value at normalized spectrum position x (0 = bass, 1 = sibilance). */
  const bandAt = (x: number): number => {
    const p = Math.max(0, Math.min(1, x)) * 15;
    const lo = Math.floor(p);
    const hi = Math.min(15, lo + 1);
    return an.bandEnv[lo] + (an.bandEnv[hi] - an.bandEnv[lo]) * (p - lo);
  };
  // Per-band auto-gain: every band tracks its own recent peak (decay ~2.5 s)
  // and reads out relative to it. Absolute band levels are useless for the
  // pill — speech energy sits almost entirely in the low bands, so the treble
  // bars on the right never moved and quiet voices barely registered (TJ).
  // Normalised per band, EVERY bar rides its own dynamic range.
  if (!an.bandAgc) an.bandAgc = new Array(16).fill(0.18);
  const agc = an.bandAgc;
  for (let i = 0; i < 16; i++) {
    if (!Number.isFinite(agc[i])) agc[i] = 0.18; // Selbstheilung (Math.max propagiert NaN)
    agc[i] = Math.max(an.bandEnv[i], agc[i] * 0.9955, 0.1);
  }
  /** Auto-gained band value at normalized spectrum position x (0..1). */
  const bandNormAt = (x: number): number => {
    const p = Math.max(0, Math.min(1, x)) * 15;
    const lo = Math.floor(p);
    const hi = Math.min(15, lo + 1);
    const f = p - lo;
    const e = an.bandEnv[lo] + (an.bandEnv[hi] - an.bandEnv[lo]) * f;
    const g = agc[lo] + (agc[hi] - agc[lo]) * f;
    return Math.min(1, e / Math.max(0.05, g));
  };

  switch (v.style) {
    case "sphere": {
      const r = dotR * (1 + energy * 1.4);
      const grad = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.6);
      grad.addColorStop(0, hexA(base, 0.95));
      grad.addColorStop(0.6, hexA(base, 0.35));
      grad.addColorStop(1, hexA(base, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "bars": {
      const n = 5;
      const bw = size * 0.06;
      const gap = bw * 0.8;
      const total = n * bw + (n - 1) * gap;
      for (let i = 0; i < n; i++) {
        const k = Math.abs(i - (n - 1) / 2);
        const center = 1 - k * 0.22; // center-weighted profile (tallest in the middle)
        // While recording each bar rides its own REAL frequency band (bass on
        // the left → sibilance on the right) blended with the overall level, so
        // the meter shows the voice's timbre, not five copies of one number.
        // Otherwise (idle/transcribing) keep the gentle breathing.
        const amp = speaking
          ? Math.min(1, 0.05 + (0.45 * lvl + 0.95 * bandAt(i / (n - 1))) * center)
          : energy * center + 0.08;
        const shimmer = speaking ? 1 : 0.6 + 0.4 * Math.abs(Math.sin(ph * 0.2 + i));
        // At rest with idle animation OFF (and silent while recording), collapse each
        // bar to a small DOT (height == width → the roundRect's bw/2 radius makes it a
        // circle) instead of a standing bar or a frozen mid-animation frame.
        const bh = idleStill ? bw : Math.max(bw, size * 0.5 * amp * shimmer);
        const x = cx - total / 2 + i * (bw + gap);
        ctx.fillStyle = hexA(base, 0.9);
        const y = cy - bh / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, bw, bh, bw / 2);
        ctx.fill();
      }
      break;
    }
    case "wave": {
      // Flat, calm line at rest (idle animation off). While recording the wave
      // HEIGHT tracks the real mic level (near-flat when silent, swelling as you
      // speak); otherwise it breathes gently.
      const amp = idleStill
        ? size * 0.015
        : speaking
          ? size * (0.02 + lvl * 0.42)
          : size * 0.18 * (0.15 + energy);
      ctx.lineWidth = Math.max(2, size * 0.02);
      ctx.strokeStyle = hexA(base, 0.9);
      ctx.beginPath();
      for (let x = -size * 0.4; x <= size * 0.4; x += 2) {
        const y = Math.sin(x * 0.05 + ph * 0.2) * amp * Math.cos(x * 0.012);
        const px = cx + x;
        const py = cy + y;
        x === -size * 0.4 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
      break;
    }
    case "sonar": {
      for (let i = 0; i < 3; i++) {
        const phase = (ph * 0.03 + i / 3) % 1;
        const r = dotR + phase * size * 0.42;
        ctx.strokeStyle = hexA(base, (1 - phase) * 0.6 * (0.4 + energy));
        ctx.lineWidth = Math.max(1.5, size * 0.012);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = hexA(base, 0.95);
      ctx.beginPath();
      ctx.arc(cx, cy, dotR * 0.7, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "classic": {
      ctx.shadowBlur = size * 0.15 * energy;
      ctx.shadowColor = base;
      ctx.fillStyle = hexA(base, 0.9);
      ctx.beginPath();
      ctx.arc(cx, cy, dotR * (0.9 + energy * 0.4), 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      break;
    }
    case "ping2": {
      // Ping V2 — rings no longer emit on a fixed timer: they fire on VOICE
      // ONSETS (level spikes above the slow mic average), scaled by how loud
      // the syllable was, over a soft gradient core. The orb visibly ripples
      // WHEN you talk, not merely while the mic is open. Idle keeps a slow
      // calm ring so it still reads alive.
      const maxR = size * 0.47;
      an.lvlAvg = an.lvlAvg * 0.92 + lvl * 0.08;
      const onset = speaking && lvl > 0.1 && lvl > an.lvlAvg * 1.35;
      if (
        !idleStill &&
        ((onset && frame % 5 === 0) ||
          (!speaking && frame % Math.max(1, Math.round(110 / sp)) === 0))
      ) {
        rings.push({ r: dotR * 0.9, a0: speaking ? 0.35 + lvl * 0.55 : 0.22 + energy * 0.2 });
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i];
        ring.r += size * 0.004 * sp * (1 + energy * 0.5);
        const p = (ring.r - dotR) / (maxR - dotR);
        if (p >= 1) {
          rings.splice(i, 1);
          continue;
        }
        const a = ring.a0 * (1 - p) * (1 - p);
        ctx.strokeStyle = hexA(base, a);
        ctx.lineWidth = Math.max(1.2, size * 0.016 * (1 - p * 0.6));
        ctx.beginPath();
        ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      // gradient core that swells with the voice
      const r = dotR * (0.9 + energy * 0.8);
      const grad = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r * 1.7);
      grad.addColorStop(0, hexA(base, 0.95));
      grad.addColorStop(0.55, hexA(base, 0.4));
      grad.addColorStop(1, hexA(base, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.7, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "sonar2": {
      // Sonar V2 — a real radar: rotating beam with a fading afterglow over
      // faint range rings; while you speak, contact "blips" appear near the
      // beam and fade like radar returns. Idle animation off → just the calm
      // rings + centre dot (no frozen mid-sweep).
      const R = size * 0.42;
      ctx.lineWidth = 1;
      for (let i = 1; i <= 3; i++) {
        ctx.strokeStyle = hexA(base, 0.1 + 0.05 * energy);
        ctx.beginPath();
        ctx.arc(cx, cy, (R * i) / 3, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (!idleStill) {
        const ang = t * 0.045;
        const TRAIL = 26;
        for (let i = TRAIL; i >= 0; i--) {
          const a = ang - i * 0.05;
          const al = Math.pow(1 - i / TRAIL, 2) * (0.45 + energy * 0.4);
          ctx.strokeStyle = hexA(base, al);
          ctx.lineWidth = i === 0 ? Math.max(1.5, size * 0.014) : Math.max(1, size * 0.008);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
          ctx.stroke();
        }
        if (speaking && lvl > 0.12 && frame % 9 === 0) {
          blips.push({
            ang: ang - Math.random() * 1.2,
            dist: R * (0.3 + Math.random() * 0.6),
            a: 0.55 + lvl * 0.4,
          });
        }
      }
      for (let i = blips.length - 1; i >= 0; i--) {
        const b = blips[i];
        b.a -= 0.012 * sp;
        if (b.a <= 0) {
          blips.splice(i, 1);
          continue;
        }
        ctx.fillStyle = hexA(base, b.a);
        ctx.beginPath();
        ctx.arc(
          cx + Math.cos(b.ang) * b.dist,
          cy + Math.sin(b.ang) * b.dist,
          Math.max(2, size * 0.02),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.fillStyle = hexA(base, 0.95);
      ctx.beginPath();
      ctx.arc(cx, cy, dotR * 0.55, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "bars2":
    case "bars3": {
      // Bars V2 — a 13-band spectrum with slowly-falling peak-hold caps
      // (classic VU peaks), mirrored around the centre line. Same live-VU
      // contract as "bars": height IS the mic level while recording.
      // Bars V3 — the same look at the HYBRID density: 9 bands, sitting
      // between "bars" (5) and "bars2" (13), with slightly wider bars.
      const n = v.style === "bars3" ? 9 : 13;
      const bw = size * (n === 9 ? 0.038 : 0.028);
      const gap = bw * 0.65;
      const total = n * bw + (n - 1) * gap;
      for (let i = 0; i < n; i++) {
        const k = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2); // 0 centre → 1 edge
        const profile = 1 - k * k * 0.75;
        // Speaking: every column is its own REAL band (bass left → sibilance
        // right) — a genuine equalizer now, not level × sine shimmer.
        const band = 0.45 + 0.55 * Math.abs(Math.sin(ph * 0.13 + i * 1.7));
        const amp = speaking
          ? Math.min(1, (0.04 + 0.4 * lvl + 1.15 * bandAt(i / (n - 1))) * profile)
          : (energy * profile + 0.06) * band;
        const bh = idleStill ? bw : Math.max(bw, size * 0.52 * amp);
        const x = cx - total / 2 + i * (bw + gap);
        ctx.fillStyle = hexA(base, 0.9);
        ctx.beginPath();
        ctx.roundRect(x, cy - bh / 2, bw, bh, bw / 2);
        ctx.fill();
        // peak caps spring up with each spike, then sink back slowly
        peaks[i] = idleStill ? bh : Math.max(peaks[i] - size * 0.0045 * sp, bh);
        if (!idleStill && peaks[i] > bh + bw * 1.2) {
          ctx.fillStyle = hexA(base, 0.5);
          ctx.beginPath();
          ctx.roundRect(x, cy - peaks[i] / 2 - bw * 0.5, bw, bw * 0.55, bw * 0.28);
          ctx.fill();
          ctx.beginPath();
          ctx.roundRect(x, cy + peaks[i] / 2 - bw * 0.05, bw, bw * 0.55, bw * 0.28);
          ctx.fill();
        }
      }
      break;
    }
    case "duobars":
    case "duobars2":
    case "duobars3": {
      // Duo Bars — a visible centre baseline with bars swinging BOTH ways
      // from it: the top and bottom lobes of each bar run on different
      // phases, so they deflect independently (like a waveform editor)
      // instead of one mirrored pill. Same live-VU contract as "bars":
      // lobe height IS the mic level while recording, with only a small
      // per-lobe shimmer. Three densities: V1 = 5 bars (like "bars"),
      // V2 = 13 (like "bars2"), V3 = 9 (the hybrid middle).
      const n = v.style === "duobars" ? 5 : v.style === "duobars2" ? 13 : 9;
      const bw = size * (n === 5 ? 0.055 : n === 13 ? 0.026 : 0.038);
      const gap = bw * 0.7;
      const total = n * bw + (n - 1) * gap;
      const lobeMax = size * 0.24;
      const pad = Math.max(1.5, size * 0.014); // air between baseline and lobes
      // the centrally-placed element the lobes swing from
      ctx.lineCap = "round";
      ctx.strokeStyle = hexA(base, 0.4);
      ctx.lineWidth = Math.max(1.5, size * 0.012);
      ctx.beginPath();
      ctx.moveTo(cx - total / 2 - bw * 0.6, cy);
      ctx.lineTo(cx + total / 2 + bw * 0.6, cy);
      ctx.stroke();
      ctx.lineCap = "butt";
      for (let i = 0; i < n; i++) {
        const k = Math.abs(i - (n - 1) / 2) / Math.max(1, (n - 1) / 2);
        const profile = 1 - k * k * 0.7; // centre-weighted, tallest in the middle
        const x = cx - total / 2 + i * (bw + gap);
        // Top lobe (dir -1) rides the LOWER half of the real spectrum, bottom
        // lobe (dir 1) the UPPER half — vowels push up while consonants kick
        // down: genuinely different information per direction, not two phases
        // of the same number. Idle keeps the two-phase shimmer.
        const lobes: [number, number, number][] = [
          [
            speaking ? 1 : 0.5 + 0.5 * Math.abs(Math.sin(ph * 0.16 + i * 1.7)),
            -1,
            bandAt((i / Math.max(1, n - 1)) * 0.5),
          ],
          [
            speaking ? 1 : 0.5 + 0.5 * Math.abs(Math.sin(ph * 0.13 + i * 2.3 + 2.1)),
            1,
            bandAt(0.5 + (i / Math.max(1, n - 1)) * 0.5),
          ],
        ];
        for (const [shimmer, dir, bv] of lobes) {
          const amp = speaking
            ? Math.min(1, (0.05 + 0.4 * lvl + 1.1 * bv) * profile) * shimmer
            : (energy * profile + 0.07) * shimmer;
          // At rest with idle animation OFF, both lobes collapse to small
          // dots hugging the baseline (height == width → circle).
          const bh = idleStill ? bw : Math.max(bw, lobeMax * amp);
          ctx.fillStyle = hexA(base, 0.9);
          ctx.beginPath();
          ctx.roundRect(x, dir < 0 ? cy - pad - bh : cy + pad, bw, bh, bw / 2);
          ctx.fill();
        }
      }
      break;
    }
    case "wave2": {
      // Wave V2 — three stacked sine layers (main + two echoes at lower
      // alpha and different frequency/phase) under a soft glow, tapered to
      // the ends, so the line reads like a rich audio waveform instead of a
      // single thread. Height tracks the real mic level while recording.
      const half = size * 0.42;
      const baseAmp = idleStill
        ? size * 0.012
        : speaking
          ? size * (0.02 + lvl * 0.4)
          : size * 0.16 * (0.15 + energy);
      const layers = [
        { f: 0.052, off: 0, a: 0.95, k: 1 },
        { f: 0.041, off: 1.7, a: 0.4, k: 0.7 },
        { f: 0.067, off: 3.9, a: 0.22, k: 0.5 },
      ];
      for (const L of layers) {
        ctx.lineWidth = Math.max(1.6, size * 0.018);
        ctx.strokeStyle = hexA(base, L.a);
        if (L.k === 1) {
          ctx.shadowBlur = size * 0.06;
          ctx.shadowColor = base;
        }
        ctx.beginPath();
        for (let x = -half; x <= half; x += 2) {
          const env = Math.pow(Math.cos((x / half) * (Math.PI / 2)), 2);
          const y = Math.sin(x * L.f + ph * 0.22 + L.off) * baseAmp * L.k * env;
          x === -half ? ctx.moveTo(cx + x, cy + y) : ctx.lineTo(cx + x, cy + y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      break;
    }
    case "halo": {
      // Halo — a thin resting ring with two comet-like arcs chasing each
      // other around it; the arcs lengthen and the ring swells as you speak.
      // Minimal and premium, deliberately quiet at rest.
      const R = size * (0.24 + 0.07 * energy);
      ctx.lineCap = "round";
      ctx.strokeStyle = hexA(base, 0.18);
      ctx.lineWidth = Math.max(1.5, size * 0.014);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
      const arcLen = (0.5 + energy * 1.3) * Math.PI * 0.6;
      const SEG = 14;
      for (let j = 0; j < 2; j++) {
        const head = ph * 0.03 * (j === 0 ? 1 : 0.82) + j * Math.PI;
        for (let i = 0; i < SEG; i++) {
          const a0 = head - (arcLen * (i + 1)) / SEG;
          const a1 = head - (arcLen * i) / SEG;
          ctx.strokeStyle = hexA(base, Math.pow(1 - i / SEG, 1.6) * (0.55 + energy * 0.4));
          ctx.lineWidth = Math.max(2, size * 0.028 * (1 - (i / SEG) * 0.55));
          ctx.beginPath();
          ctx.arc(cx, cy, R, a0, a1);
          ctx.stroke();
        }
      }
      ctx.lineCap = "butt";
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, dotR * 1.2);
      grad.addColorStop(0, hexA(base, 0.85));
      grad.addColorStop(1, hexA(base, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, dotR * 1.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "orbit": {
      // Orbit — electrons circling a nucleus on three tilted elliptical
      // paths, each with a short fading trail; orbits widen slightly with
      // the energy. Trails skip when frozen so rest is truly still.
      const orbits = [
        { rx: 0.3, ry: 0.13, tilt: 0.5, v: 1.0, off: 0 },
        { rx: 0.26, ry: 0.32, tilt: -0.9, v: 0.74, off: 2.1 },
        { rx: 0.34, ry: 0.2, tilt: 1.9, v: 0.55, off: 4.4 },
      ];
      for (const o of orbits) {
        const rx = size * o.rx * (0.85 + energy * 0.3);
        const ry = size * o.ry * (0.85 + energy * 0.3);
        ctx.strokeStyle = hexA(base, 0.1);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, o.tilt, 0, Math.PI * 2);
        ctx.stroke();
        const head = ph * 0.035 * o.v + o.off;
        const ghosts = idleStill ? 0 : 5;
        for (let g = ghosts; g >= 0; g--) {
          const a = head - g * 0.16;
          const ex = rx * Math.cos(a);
          const ey = ry * Math.sin(a);
          const x = cx + ex * Math.cos(o.tilt) - ey * Math.sin(o.tilt);
          const y = cy + ex * Math.sin(o.tilt) + ey * Math.cos(o.tilt);
          ctx.fillStyle = hexA(base, Math.pow(1 - g / 6, 1.8) * 0.9);
          ctx.beginPath();
          ctx.arc(x, y, Math.max(1.5, size * 0.022 * (1 - g * 0.13)), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.fillStyle = hexA(base, 0.95);
      ctx.beginPath();
      ctx.arc(cx, cy, dotR * 0.6 * (1 + energy * 0.3), 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "aurora": {
      // Aurora — three soft gradient blobs drifting on Lissajous paths,
      // additively blended so overlaps bloom; the cloud tightens and
      // brightens as you speak. The most organic, "lava lamp" of the set.
      const prevOp = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = "lighter";
      const spread = size * (speaking ? 0.1 + (1 - lvl) * 0.05 : 0.14);
      const blobs = [
        { fx: 0.021, fy: 0.017, off: 0, r: 0.2 },
        { fx: 0.013, fy: 0.024, off: 2.4, r: 0.17 },
        { fx: 0.017, fy: 0.011, off: 4.6, r: 0.23 },
      ];
      for (const b of blobs) {
        const x = cx + Math.sin(ph * b.fx + b.off) * spread;
        const y = cy + Math.cos(ph * b.fy + b.off * 1.3) * spread;
        const r = size * b.r * (0.8 + energy * 0.5);
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, hexA(base, 0.5 + energy * 0.3));
        grad.addColorStop(1, hexA(base, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = prevOp;
      break;
    }
    case "spectrum": {
      // Spectrum — a circular equalizer: rounded spokes radiating from a
      // ring, each band dancing on its own phase; while recording the whole
      // crown follows the real mic level. Collapses to stubs at rest.
      const N = 28;
      const r0 = size * 0.16;
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(2, size * 0.018);
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 - Math.PI / 2;
        // Speaking: the crown is the REAL spectrum, mirrored left/right —
        // bass at the top, sibilance at the bottom. Idle keeps the shimmer.
        const pos = i / N;
        const mir = pos <= 0.5 ? pos * 2 : (1 - pos) * 2;
        const band = speaking
          ? 0.25 + 0.75 * bandAt(mir)
          : 0.35 + 0.65 * Math.abs(Math.sin(ph * 0.17 + i * 2.4));
        const len = idleStill
          ? size * 0.012
          : speaking
            ? size * (0.015 + (0.06 * lvl + 0.2 * bandAt(mir)))
            : size * 0.1 * energy * band + size * 0.01;
        ctx.strokeStyle = hexA(base, 0.45 + 0.5 * band);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
        ctx.stroke();
      }
      ctx.lineCap = "butt";
      ctx.fillStyle = hexA(base, 0.9);
      ctx.beginPath();
      ctx.arc(cx, cy, dotR * 0.55, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "ribbon": {
      // Ribbon — a filled, flowing waveform BAND (a liquid sibling of wave2):
      // a closed shape between a top and bottom sine edge, vertical-gradient
      // filled with a soft glow, tapered to the ends. Height tracks the real
      // mic level while recording. The two edges share a phase but the band
      // thickness breathes with energy, so it reads as a glossy liquid stream.
      const half = size * 0.42;
      const amp = idleStill
        ? size * 0.015
        : speaking
          ? size * (0.03 + lvl * 0.4)
          : size * 0.16 * (0.18 + energy);
      const thick = size * (0.03 + 0.03 * energy);
      const grad = ctx.createLinearGradient(0, cy - amp - thick, 0, cy + amp + thick);
      grad.addColorStop(0, hexA(base, 0));
      grad.addColorStop(0.5, hexA(base, 0.85));
      grad.addColorStop(1, hexA(base, 0));
      ctx.fillStyle = grad;
      ctx.shadowBlur = size * 0.05;
      ctx.shadowColor = base;
      ctx.beginPath();
      for (let x = -half; x <= half; x += 3) {
        const env = Math.pow(Math.cos((x / half) * (Math.PI / 2)), 1.3);
        const y = Math.sin(x * 0.045 + ph * 0.22) * amp * env;
        const px = cx + x;
        const py = cy + y - (thick * env + thick * 0.25);
        x === -half ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      for (let x = half; x >= -half; x -= 3) {
        const env = Math.pow(Math.cos((x / half) * (Math.PI / 2)), 1.3);
        const y = Math.sin(x * 0.045 + ph * 0.22) * amp * env;
        ctx.lineTo(cx + x, cy + y + (thick * env + thick * 0.25));
      }
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      break;
    }
    case "helix": {
      // Helix — a DNA double-strand: two dot strands running left→right, each a
      // sine offset π apart, with faint rungs where they cross. `depth` (the
      // cosine) fades the dots front/back so it reads 3-D as it rotates. The
      // strands widen with energy.
      const half = size * 0.38;
      const amp = size * (0.11 + 0.13 * energy);
      const turns = 2.2;
      const N = 26;
      const dot = size * 0.02;
      for (let i = 0; i <= N; i++) {
        const x = -half + 2 * half * (i / N);
        const a = (i / N) * Math.PI * 2 * turns + ph * 0.06;
        const y1 = Math.sin(a) * amp;
        const y2 = Math.sin(a + Math.PI) * amp;
        const d1 = (Math.cos(a) + 1) / 2;
        const d2 = (Math.cos(a + Math.PI) + 1) / 2;
        if (i % 2 === 0) {
          ctx.strokeStyle = hexA(base, 0.1 + 0.12 * energy);
          ctx.lineWidth = Math.max(1, size * 0.006);
          ctx.beginPath();
          ctx.moveTo(cx + x, cy + y1);
          ctx.lineTo(cx + x, cy + y2);
          ctx.stroke();
        }
        ctx.fillStyle = hexA(base, 0.35 + 0.6 * d1);
        ctx.beginPath();
        ctx.arc(cx + x, cy + y1, dot * (0.55 + 0.7 * d1), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = hexA(base, 0.35 + 0.6 * d2);
        ctx.beginPath();
        ctx.arc(cx + x, cy + y2, dot * (0.55 + 0.7 * d2), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "nova": {
      // Nova — a radiant core with rays that FLARE on voice onsets. Rays rotate
      // slowly and dance on their own phase; a syllable spike bumps `pulse`,
      // which lengthens + brightens every ray and swells the core. Energetic
      // without the constant motion of sonar.
      an.lvlAvg = an.lvlAvg * 0.9 + lvl * 0.1;
      const onset = speaking && lvl > 0.12 && lvl > an.lvlAvg * 1.3;
      an.pulse = idleStill
        ? an.pulse
        : Math.max(an.pulse * 0.9, onset ? Math.min(1, 0.5 + lvl * 0.5) : 0);
      const flare = energy * 0.5 + an.pulse;
      const N = 18;
      const r0 = dotR * 0.7;
      ctx.lineCap = "round";
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 + ph * 0.01;
        const long = i % 3 === 0;
        const len =
          size *
          (0.07 + (long ? 0.17 : 0.09) * flare) *
          (0.7 + 0.5 * Math.abs(Math.sin(ph * 0.1 + i)));
        ctx.strokeStyle = hexA(base, (long ? 0.7 : 0.4) * (0.45 + 0.55 * flare));
        ctx.lineWidth = Math.max(1.2, size * (long ? 0.012 : 0.007));
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
        ctx.stroke();
      }
      ctx.lineCap = "butt";
      const r = dotR * (0.8 + flare * 0.5);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.8);
      grad.addColorStop(0, hexA(base, 0.95));
      grad.addColorStop(0.5, hexA(base, 0.4));
      grad.addColorStop(1, hexA(base, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.8, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "droplet": {
      // Droplet — a glossy LIQUID blob: a circle whose radius is perturbed by a
      // few sine harmonics so the surface wobbles like a water bead, with a
      // radial gradient body and a specular highlight (very "liquid glass"). A
      // voice onset ripples the surface harder via `pulse`.
      an.lvlAvg = an.lvlAvg * 0.9 + lvl * 0.1;
      const onset = speaking && lvl > 0.12 && lvl > an.lvlAvg * 1.3;
      an.pulse = idleStill
        ? an.pulse
        : Math.max(an.pulse * 0.92, onset ? Math.min(1, 0.5 + lvl * 0.5) : 0);
      const R = dotR * (1.5 + energy * 0.7);
      const wob = 0.05 + 0.12 * energy + 0.18 * an.pulse;
      ctx.beginPath();
      const STEPS = 60;
      for (let i = 0; i <= STEPS; i++) {
        const a = (i / STEPS) * Math.PI * 2;
        const rr =
          R *
          (1 +
            wob *
              (0.5 * Math.sin(a * 3 + ph * 0.12) +
                0.3 * Math.sin(a * 5 - ph * 0.16) +
                0.2 * Math.sin(a * 2 + ph * 0.09)));
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      const grad = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R * 1.3);
      grad.addColorStop(0, hexA(base, 0.95));
      grad.addColorStop(0.7, hexA(base, 0.5));
      grad.addColorStop(1, hexA(base, 0.12));
      ctx.fillStyle = grad;
      ctx.fill();
      // specular gloss
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.beginPath();
      ctx.ellipse(cx - R * 0.34, cy - R * 0.4, R * 0.28, R * 0.16, -0.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "constellation": {
      // Constellation — a living network: nodes on a ring linked to each other
      // and the centre; the nodes jitter and the links brighten as you speak,
      // like a graph waking up. Calm and geometric at rest.
      const NODES = 9;
      const R = size * (0.2 + 0.06 * energy);
      const pts: [number, number][] = [];
      for (let i = 0; i < NODES; i++) {
        const a = (i / NODES) * Math.PI * 2 + ph * 0.012;
        const jit = idleStill ? 0 : (0.08 + energy * 0.2) * Math.sin(ph * 0.2 + i * 1.7);
        const rr = R * (1 + jit);
        pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
      }
      ctx.lineWidth = Math.max(1, size * 0.005);
      for (let i = 0; i < NODES; i++) {
        const [x, y] = pts[i];
        const [nx, ny] = pts[(i + 1) % NODES];
        ctx.strokeStyle = hexA(base, 0.12 + 0.32 * energy);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(nx, ny);
        ctx.stroke();
        ctx.strokeStyle = hexA(base, 0.06 + 0.2 * energy);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(cx, cy);
        ctx.stroke();
      }
      for (const [x, y] of pts) {
        ctx.fillStyle = hexA(base, 0.85);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.5, size * 0.016 * (0.8 + energy)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = hexA(base, 0.95);
      ctx.beginPath();
      ctx.arc(cx, cy, dotR * 0.5 * (1 + energy * 0.3), 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "nebula": {
      // ★ Nebula — a slowly rotating spiral galaxy of ~110 additively-blended
      // particles on a tilted disc. Each particle rides the REAL band its
      // radius maps to (core = bass … rim = sibilance), so vowels make the
      // heart glow while consonants sparkle through the outer arms; a voice
      // onset sends a soft shockwave ring through the disc.
      if (an.parts.length === 0) {
        // Deterministic layout (LCG, no Math.random) so resume/preview repeat.
        let seed = 7;
        const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        for (let i = 0; i < 110; i++) {
          const d = 0.1 + 0.9 * Math.pow(rnd(), 0.72); // denser towards the core
          an.parts.push({
            d,
            a0: (i % 3) * ((Math.PI * 2) / 3) + d * 2.7 + rnd() * 0.55, // 3 log-spiral arms
            sz: 0.55 + rnd() * 1.15,
            v: 0.55 + rnd() * 0.85,
          });
        }
      }
      an.lvlAvg = an.lvlAvg * 0.9 + lvl * 0.1;
      const onset = speaking && lvl > 0.12 && lvl > an.lvlAvg * 1.3;
      an.pulse = idleStill
        ? an.pulse
        : Math.max(an.pulse * 0.93, onset ? Math.min(1, 0.4 + lvl * 0.6) : 0);
      if (!idleStill && onset && frame % 7 === 0) {
        rings.push({ r: size * 0.08, a0: 0.28 + lvl * 0.35 });
      }
      const tilt = -0.35;
      const ct = Math.cos(tilt);
      const stl = Math.sin(tilt);
      const disc = (x: number, y: number): [number, number] => [
        cx + x * ct - y * 0.6 * stl,
        cy + x * stl + y * 0.6 * ct,
      ];
      const prevOp = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = "lighter";
      // shockwave rings ripple outwards through the disc
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i];
        ring.r += size * 0.006 * sp;
        const p = ring.r / (size * 0.5);
        if (p >= 1) {
          rings.splice(i, 1);
          continue;
        }
        ctx.strokeStyle = hexA(base, ring.a0 * (1 - p) * (1 - p));
        ctx.lineWidth = Math.max(1, size * 0.008);
        ctx.beginPath();
        ctx.ellipse(cx, cy, ring.r, ring.r * 0.6, tilt, 0, Math.PI * 2);
        ctx.stroke();
      }
      const R = size * 0.46;
      const spin = ph * 0.006;
      for (const p of an.parts) {
        const bv = speaking ? bandAt(p.d) : 0;
        const glow = speaking ? 0.16 + bv * 0.95 : 0.18 + energy * 0.42;
        const rr = R * p.d * (1 + an.pulse * 0.14 * (1 - p.d) + bv * 0.08);
        const a = p.a0 + spin * p.v;
        const [x, y] = disc(Math.cos(a) * rr, Math.sin(a) * rr);
        const pr = Math.max(0.6, size * 0.008 * p.sz * (0.8 + bv * 0.7));
        ctx.fillStyle = hexA(base, Math.min(0.85, glow));
        ctx.beginPath();
        ctx.arc(x, y, pr, 0, Math.PI * 2);
        ctx.fill();
        // bright particles get a soft halo — cheap two-draw bloom
        if (glow > 0.55) {
          ctx.fillStyle = hexA(base, (glow - 0.55) * 0.35);
          ctx.beginPath();
          ctx.arc(x, y, pr * 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // luminous core — swells with the bass end of the spectrum
      const bass = speaking ? bandAt(0.08) : 0;
      const coreR = size * (0.09 + 0.05 * energy + 0.06 * bass + 0.04 * an.pulse);
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.2);
      core.addColorStop(0, "rgba(255,255,255,0.75)");
      core.addColorStop(0.25, hexA(base, 0.85));
      core.addColorStop(1, hexA(base, 0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = prevOp;
      break;
    }
    case "ferro": {
      // ★ Ferrofluid — a liquid-metal bead whose surface is displaced by the
      // REAL spectrum: low bands roll broad slow lobes, upper bands raise
      // sharp magnet-spikes (|sin|³ keeps them needle-like), and a voice
      // onset shivers the whole surface. Glossy gradient + rim light + double
      // specular sell the liquid.
      an.lvlAvg = an.lvlAvg * 0.9 + lvl * 0.1;
      const onset = speaking && lvl > 0.12 && lvl > an.lvlAvg * 1.3;
      an.pulse = idleStill
        ? an.pulse
        : Math.max(an.pulse * 0.9, onset ? Math.min(1, 0.45 + lvl * 0.55) : 0);
      const bass = bandAt(0.08);
      const treb = (an.bandEnv[12] + an.bandEnv[13] + an.bandEnv[14] + an.bandEnv[15]) / 4;
      const R = dotR * (1.4 + energy * 0.5 + bass * 0.45);
      ctx.beginPath();
      const STEPS = 120;
      for (let i = 0; i <= STEPS; i++) {
        const a = (i / STEPS) * Math.PI * 2;
        let disp: number;
        if (speaking) {
          disp =
            0.07 * bandAt(0.12) * Math.sin(a * 2 + ph * 0.08) +
            0.1 * bandAt(0.35) * Math.sin(a * 3 - ph * 0.11) +
            0.12 * bandAt(0.58) * Math.sin(a * 5 + ph * 0.15) +
            0.13 * bandAt(0.8) * Math.sin(a * 8 - ph * 0.2) +
            0.24 * treb * Math.pow(Math.abs(Math.sin(a * 11 + ph * 0.26)), 3) +
            0.1 * an.pulse * Math.sin(a * 6 + ph * 0.3);
        } else {
          disp = idleStill
            ? 0
            : 0.05 * energy * Math.sin(a * 3 + ph * 0.09) +
              0.03 * energy * Math.sin(a * 5 - ph * 0.12);
        }
        const rr = R * (1 + disp);
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      const grad = ctx.createRadialGradient(
        cx - R * 0.35,
        cy - R * 0.35,
        R * 0.08,
        cx,
        cy,
        R * 1.45,
      );
      grad.addColorStop(0, hexA(base, 0.98));
      grad.addColorStop(0.5, hexA(base, 0.62));
      grad.addColorStop(0.85, hexA(base, 0.24));
      grad.addColorStop(1, hexA(base, 0.06));
      ctx.fillStyle = grad;
      ctx.shadowBlur = size * (0.04 + 0.05 * energy);
      ctx.shadowColor = base;
      ctx.fill();
      ctx.shadowBlur = 0;
      // rim light along the displaced surface
      ctx.strokeStyle = hexA(base, 0.5 + 0.3 * energy);
      ctx.lineWidth = Math.max(1, size * 0.007);
      ctx.stroke();
      // double specular: main gloss + a small counter-sparkle
      ctx.fillStyle = "rgba(255,255,255,0.26)";
      ctx.beginPath();
      ctx.ellipse(cx - R * 0.36, cy - R * 0.42, R * 0.26, R * 0.13, -0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.ellipse(cx + R * 0.3, cy + R * 0.34, R * 0.1, R * 0.05, 0.7, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "scope": {
      // ★ Oscilloscope — a studio scope for the voice: the REAL level history
      // scrolls left, so the last few seconds of speech are literally readable
      // in the orb — syllables, pauses, emphasis. Symmetric gradient fill,
      // glowing centre trace, live playhead dot at the newest sample.
      const W = 96;
      if (an.hist.length !== W) an.hist = new Array(W).fill(0);
      if (!idleStill && frame % Math.max(1, Math.round(2 / sp)) === 0) {
        an.hist.push(
          speaking ? lvl : st === "idle" && v.idlePulse ? 0.03 + 0.02 * Math.sin(t * 0.05) : 0.015,
        );
        an.hist.shift();
      }
      const half = size * 0.42;
      const hMax = size * 0.3;
      const xAt = (i: number) => cx - half + 2 * half * (i / (W - 1));
      // faint baseline + scope ticks
      ctx.strokeStyle = hexA(base, 0.16);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - half, cy);
      ctx.lineTo(cx + half, cy);
      ctx.stroke();
      ctx.strokeStyle = hexA(base, 0.07);
      for (let g = 1; g <= 3; g++) {
        const gx = cx - half + (2 * half * g) / 4;
        ctx.beginPath();
        ctx.moveTo(gx, cy - hMax * 0.8);
        ctx.lineTo(gx, cy + hMax * 0.8);
        ctx.stroke();
      }
      // symmetric envelope fill, faded toward the old (left) edge
      const fade = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
      fade.addColorStop(0, hexA(base, 0));
      fade.addColorStop(0.35, hexA(base, 0.3));
      fade.addColorStop(1, hexA(base, 0.55));
      ctx.fillStyle = fade;
      ctx.beginPath();
      for (let i = 0; i < W; i++) {
        const y = cy - Math.max(size * 0.006, an.hist[i] * hMax);
        i === 0 ? ctx.moveTo(xAt(i), y) : ctx.lineTo(xAt(i), y);
      }
      for (let i = W - 1; i >= 0; i--) {
        ctx.lineTo(xAt(i), cy + Math.max(size * 0.006, an.hist[i] * hMax));
      }
      ctx.closePath();
      ctx.fill();
      // bright top trace with glow
      ctx.strokeStyle = hexA(base, 0.95);
      ctx.lineWidth = Math.max(1.4, size * 0.012);
      ctx.shadowBlur = size * 0.04;
      ctx.shadowColor = base;
      ctx.beginPath();
      for (let i = 0; i < W; i++) {
        const y = cy - Math.max(size * 0.006, an.hist[i] * hMax);
        i === 0 ? ctx.moveTo(xAt(i), y) : ctx.lineTo(xAt(i), y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      // playhead — the "now" dot rides the newest sample
      const nowY = cy - Math.max(size * 0.006, an.hist[W - 1] * hMax);
      const pr = Math.max(2, size * (0.016 + 0.014 * lvl));
      const pg = ctx.createRadialGradient(cx + half, nowY, 0, cx + half, nowY, pr * 3);
      pg.addColorStop(0, "rgba(255,255,255,0.9)");
      pg.addColorStop(0.35, hexA(base, 0.8));
      pg.addColorStop(1, hexA(base, 0));
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(cx + half, nowY, pr * 3, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "prism": {
      // ★ Prisma — a rotating hexagonal crystal: each facet is lit by its own
      // slice of the REAL spectrum (bass facet → sibilance facet), the edges
      // catch light with the energy, and a voice onset fires thin refraction
      // rays from the vertices. A counter-rotating inner core adds depth.
      an.lvlAvg = an.lvlAvg * 0.9 + lvl * 0.1;
      const onset = speaking && lvl > 0.12 && lvl > an.lvlAvg * 1.3;
      an.pulse = idleStill
        ? an.pulse
        : Math.max(an.pulse * 0.91, onset ? Math.min(1, 0.45 + lvl * 0.55) : 0);
      const R = size * (0.23 + 0.05 * energy);
      const rot = ph * 0.008;
      const vx: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const a = rot + (i / 6) * Math.PI * 2 - Math.PI / 2;
        vx.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]);
      }
      // dim base outline first — the per-facet lit edges paint OVER it, so
      // the band-lighting stays readable instead of being overdrawn
      ctx.strokeStyle = hexA(base, 0.28 + 0.15 * energy);
      ctx.lineWidth = Math.max(1.2, size * 0.008);
      ctx.shadowBlur = size * 0.03 * (0.5 + energy);
      ctx.shadowColor = base;
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const [x, y] = vx[i % 6];
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      // facets — gradient wedges from the heart to each edge
      for (let i = 0; i < 6; i++) {
        const [x1, y1] = vx[i];
        const [x2, y2] = vx[(i + 1) % 6];
        const bv = speaking
          ? bandAt(i / 5)
          : idleStill
            ? 0.12
            : energy * (0.35 + 0.3 * Math.sin(ph * 0.1 + i * 1.9));
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        const fg = ctx.createLinearGradient(cx, cy, mx, my);
        fg.addColorStop(0, hexA(base, 0.03));
        fg.addColorStop(1, hexA(base, 0.08 + 0.72 * Math.min(1, bv)));
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.closePath();
        ctx.fill();
        // the outer edge of a lit facet catches its band's light — this is
        // what makes the "frequency facets" readable at a glance
        ctx.strokeStyle = hexA(base, 0.12 + 0.85 * Math.min(1, bv));
        ctx.lineWidth = Math.max(1.4, size * 0.011);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      // counter-rotating inner core hexagon
      ctx.strokeStyle = hexA(base, 0.25 + 0.3 * energy);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const a = -rot * 1.6 + ((i % 6) / 6) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(a) * R * 0.45;
        const y = cy + Math.sin(a) * R * 0.45;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      // refraction rays burst from the vertices on syllables
      if (an.pulse > 0.06 && !idleStill) {
        ctx.lineWidth = 1;
        for (let i = 0; i < 6; i++) {
          const a = rot + (i / 6) * Math.PI * 2 - Math.PI / 2;
          const bv = speaking ? bandAt(i / 5) : energy * 0.5;
          const len = size * (0.05 + 0.17 * an.pulse * (0.35 + bv));
          ctx.strokeStyle = hexA(base, 0.65 * an.pulse);
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
          ctx.lineTo(cx + Math.cos(a) * (R + len), cy + Math.sin(a) * (R + len));
          ctx.stroke();
        }
      }
      // glowing heart
      const heart = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.42);
      heart.addColorStop(0, "rgba(255,255,255,0.5)");
      heart.addColorStop(0.3, hexA(base, 0.75));
      heart.addColorStop(1, hexA(base, 0));
      ctx.fillStyle = heart;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.42, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "spectra": {
      // ★ Spectra — a circular REAL-spectrum analyzer: 48 rounded spokes
      // around a breathing ring (bass at the top, mirrored down both sides to
      // sibilance at the bottom), each with a peak-hold cap that springs up
      // and sinks back — the classic high-end visualizer, tuned to voice.
      const N = 48;
      if (an.caps.length !== N) an.caps = new Array(N).fill(0);
      const r0 = size * 0.2;
      const maxLen = size * 0.2;
      ctx.strokeStyle = hexA(base, 0.14);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r0 * 0.93, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineCap = "round";
      for (let i = 0; i < N; i++) {
        const a = -Math.PI / 2 + (i / N) * Math.PI * 2 + ph * 0.004;
        const pos = i / N;
        const mir = pos <= 0.5 ? pos * 2 : (1 - pos) * 2;
        const bv = speaking
          ? bandAt(mir)
          : idleStill
            ? 0
            : energy * (0.22 + 0.3 * Math.abs(Math.sin(ph * 0.11 + i * 1.3)));
        const len = size * 0.012 + maxLen * Math.min(1, bv);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        ctx.lineWidth = Math.max(1.6, size * 0.014);
        ctx.strokeStyle = hexA(base, 0.3 + 0.65 * bv);
        ctx.beginPath();
        ctx.moveTo(cx + ca * r0, cy + sa * r0);
        ctx.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len));
        ctx.stroke();
        // short inner mirror of each spoke — the crown reads on both sides
        ctx.strokeStyle = hexA(base, 0.14 + 0.3 * bv);
        ctx.lineWidth = Math.max(1.2, size * 0.01);
        ctx.beginPath();
        ctx.moveTo(cx + ca * (r0 * 0.86), cy + sa * (r0 * 0.86));
        ctx.lineTo(cx + ca * (r0 * 0.86 - len * 0.3), cy + sa * (r0 * 0.86 - len * 0.3));
        ctx.stroke();
        // peak-hold cap: springs with the band, sinks back (fast enough to
        // hug the crown — slower and the dots read as scattered noise)
        an.caps[i] = idleStill ? len : Math.max(an.caps[i] - size * 0.0058 * sp, len);
        if (!idleStill && an.caps[i] > len + size * 0.015) {
          ctx.fillStyle = hexA(base, 0.42);
          ctx.beginPath();
          ctx.arc(
            cx + ca * (r0 + an.caps[i] + size * 0.012),
            cy + sa * (r0 + an.caps[i] + size * 0.012),
            Math.max(1, size * 0.007),
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
      }
      ctx.lineCap = "butt";
      // breathing core that follows the voice level
      const coreR = dotR * (0.75 + energy * 0.45);
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 1.9);
      core.addColorStop(0, hexA(base, 0.95));
      core.addColorStop(0.55, hexA(base, 0.35));
      core.addColorStop(1, hexA(base, 0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 1.9, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "pillv1": {
      // ★ Pille V1 — the ORIGINAL liquid-glass capsule from the Echo website's
      // speed race, exactly as it first migrated into Echo (v0.5.88): a static
      // glass pill with a specular streak, a gradient hairline border, a soft
      // state-colored ambient glow and FIVE voice-reactive EQ bars inside
      // (driven by the real spectrum via bandAt). Short capsule (H = W·0.4),
      // no dome lens — the nostalgic standard. Kept alongside the V2 dome pill
      // (TJ 2026-07-09: "die alte V1 Pille soll noch mit ins Menü").
      an.lvlAvg = an.lvlAvg * 0.9 + lvl * 0.1;
      const onset = speaking && lvl > 0.12 && lvl > an.lvlAvg * 1.3;
      an.pulse = idleStill
        ? an.pulse
        : Math.max(an.pulse * 0.9, onset ? Math.min(1, 0.4 + lvl * 0.6) : 0);

      const W = size * 0.94;
      const H = W * 0.4;
      const x0 = cx - W / 2;
      const y0 = cy - H / 2;
      const capsule = () => {
        const r = H / 2;
        ctx.beginPath();
        ctx.moveTo(x0 + r, y0);
        ctx.lineTo(x0 + W - r, y0);
        ctx.arc(x0 + W - r, y0 + r, r, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(x0 + r, y0 + H);
        ctx.arc(x0 + r, y0 + r, r, Math.PI / 2, (3 * Math.PI) / 2);
        ctx.closePath();
      };

      // 1) ambient glow — breathes with the voice, flares on syllable onsets
      ctx.save();
      ctx.shadowColor = hexA(base, 0.38 + 0.3 * energy + 0.25 * an.pulse);
      ctx.shadowBlur = size * (0.08 + 0.05 * energy + 0.04 * an.pulse);
      ctx.fillStyle = hexA(base, 0.08);
      capsule();
      ctx.fill();
      ctx.restore();

      // 2) glass body — dark smoke for contrast on any desktop, then the
      //    website's 165° white→transparent→tint gradient on top
      capsule();
      ctx.fillStyle = "rgba(8,14,26,0.42)";
      ctx.fill();
      const gDir = { x: Math.cos(1.31), y: Math.sin(1.31) }; // ~165° like the site
      const body = ctx.createLinearGradient(
        cx - gDir.x * W * 0.5,
        cy - gDir.y * H * 0.9,
        cx + gDir.x * W * 0.5,
        cy + gDir.y * H * 0.9,
      );
      body.addColorStop(0, "rgba(255,255,255,0.20)");
      body.addColorStop(0.48, "rgba(255,255,255,0.045)");
      body.addColorStop(1, hexA(base, 0.13));
      capsule();
      ctx.fillStyle = body;
      ctx.fill();

      // 3) specular streak (top-left), clipped to the glass
      ctx.save();
      capsule();
      ctx.clip();
      const spec = ctx.createRadialGradient(
        cx - W * 0.24,
        y0 + H * 0.2,
        0,
        cx - W * 0.24,
        y0 + H * 0.2,
        W * 0.32,
      );
      spec.addColorStop(0, "rgba(255,255,255,0.30)");
      spec.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = spec;
      ctx.fillRect(x0, y0, W, H);
      ctx.restore();

      // 4) hairline border — bright top edge sinking to a faint bottom
      const rim = ctx.createLinearGradient(cx, y0, cx, y0 + H);
      rim.addColorStop(0, `rgba(255,255,255,${0.42 + 0.2 * an.pulse})`);
      rim.addColorStop(1, "rgba(255,255,255,0.10)");
      ctx.strokeStyle = rim;
      ctx.lineWidth = Math.max(1.1, size * 0.011);
      capsule();
      ctx.stroke();

      // 5) five EQ bars — the website's echo-eq, fed by the real voice spectrum
      //    (bass→sibilance across the pill); calm breathing at rest
      const REST = [0.34, 0.55, 0.68, 0.47, 0.3];
      const POS = [0.12, 0.35, 0.55, 0.75, 0.92];
      const barW = Math.max(1.6, H * 0.085);
      const gap = barW * 1.7;
      const totalW = 4 * gap;
      ctx.lineCap = "round";
      ctx.save();
      ctx.shadowColor = hexA(base, 0.7);
      ctx.shadowBlur = Math.max(3, H * 0.16);
      for (let i = 0; i < 5; i++) {
        let hBar: number;
        if (speaking) {
          // wide dynamic range: whisper = small ticks, loud = near full height
          hBar = H * Math.min(0.78, REST[i] * (0.3 + 1.35 * bandAt(POS[i])));
        } else {
          // echo-eq breathing (phase-offset per bar), frozen when idleStill
          const wave = idleStill ? 0.35 : 0.5 + 0.5 * Math.sin(ph * 0.11 + i * 1.15);
          hBar = H * REST[i] * (0.5 + 0.32 + 0.68 * wave * energy);
        }
        const bx = cx - totalW / 2 + i * gap;
        ctx.strokeStyle = hexA(base, 0.92);
        ctx.lineWidth = barW;
        ctx.beginPath();
        ctx.moveTo(bx, cy - hBar / 2);
        ctx.lineTo(bx, cy + hBar / 2);
        ctx.stroke();
      }
      ctx.restore();
      ctx.lineCap = "butt";
      break;
    }
    case "pill":
    case "pill2": {
      // ★ Pille v2 — a NEUTRAL liquid-glass capsule with a dome lens: the
      // glass itself carries no state color (chic, transparent — TJ), only
      // the nine spectrum bars inside glow. The lens look follows the SCAI
      // sidebar dome recipe (magnified centre, compressed rims, light
      // bending at the edge — src/index.css .snav-lens* / GlassSlider.tsx):
      // bar positions run through a dome mapping, heights get a vertical
      // dome factor, and a thick inner refraction rim doubles the edge.
      // At rest the bars collapse to DOTS (idle pulse = gentle dot breathe).
      an.lvlAvg = an.lvlAvg * 0.9 + lvl * 0.1;
      const onset = speaking && lvl > 0.12 && lvl > an.lvlAvg * 1.3;
      an.pulse = idleStill
        ? an.pulse
        : Math.max(an.pulse * 0.9, onset ? Math.min(1, 0.4 + lvl * 0.6) : 0);

      // Opt-in customization (Settings → "Pille"): which visualizer plays in
      // the glass and whether the glass itself is illuminated. Both default
      // to today's exact look — unknown values fall through to the default
      // branches, so a stale preset can never break the pill.
      const viz = v.pillVisual ?? "standard";
      const glow = v.pillGlow ?? "aus";
      const flowViz = viz === "laufband" || viz === "zentrum";
      // Rolling loudness history for the flow visuals — one sample per frame,
      // newest first. Blend of broadband level and low-mid band: the envelope
      // that reads as "my voice going in".
      {
        const amp = speaking ? Math.min(1, 0.55 * lvl + 0.5 * bandAt(0.3)) : 0;
        an.pillHist.unshift(Number.isFinite(amp) ? amp : 0);
        if (an.pillHist.length > 240) an.pillHist.length = 240;
      }
      // Smoothed spectral centroid for the glow — where the voice's energy
      // sits right now (0 bass … 1 sibilance); the light leans toward it.
      if (glow !== "aus") {
        let s = 0;
        let sw = 0;
        for (let i = 0; i < 16; i++) {
          s += an.bandEnv[i];
          sw += an.bandEnv[i] * i;
        }
        const c0 = speaking && s > 0.02 ? sw / s / 15 : 0.5;
        an.pillCent += (c0 - an.pillCent) * 0.06;
        if (!Number.isFinite(an.pillCent)) an.pillCent = 0.5; // Selbstheilung
      }

      // Longer + slimmer than v1 (TJ: mehr horizontale Länge).
      const W = size * 0.98;
      const H = W * 0.32;
      const x0 = cx - W / 2;
      const y0 = cy - H / 2;
      const capsule = (inset = 0) => {
        const xx = x0 + inset;
        const yy = y0 + inset;
        const ww = W - inset * 2;
        const hh = H - inset * 2;
        const r = hh / 2;
        ctx.beginPath();
        ctx.moveTo(xx + r, yy);
        ctx.lineTo(xx + ww - r, yy);
        ctx.arc(xx + ww - r, yy + r, r, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(xx + r, yy + hh);
        ctx.arc(xx + r, yy + r, r, Math.PI / 2, (3 * Math.PI) / 2);
        ctx.closePath();
      };

      // 1) ambient halo — NEUTRAL white and very soft; the glass must not be
      //    tinted by the state (color lives only in the bars). With the opt-in
      //    illumination the halo takes the light's tint instead — the pill
      //    visibly radiates ("beleuchtet"), not just its inside.
      const haloA = 0.14 + 0.1 * energy + 0.1 * an.pulse;
      ctx.save();
      ctx.shadowColor =
        glow === "status"
          ? hexA(base, haloA + 0.24)
          : glow === "siri"
            ? hexA("#8f7bff", haloA + 0.24)
            : `rgba(255,255,255,${haloA})`;
      ctx.shadowBlur =
        size *
        (0.05 +
          0.03 * energy +
          // extra radiance ONLY for the known illumination modes — an unknown
          // value must render byte-identical to the default (fall-through)
          (glow === "status" || glow === "siri" ? 0.025 : 0));
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      capsule();
      ctx.fill();
      ctx.restore();

      // 2) glass body — smoke for contrast + a pure white 165° gradient
      //    (no color stop: the capsule stays neutral on any desktop).
      capsule();
      ctx.fillStyle = "rgba(10,14,22,0.34)";
      ctx.fill();
      const gDir = { x: Math.cos(1.31), y: Math.sin(1.31) };
      const body = ctx.createLinearGradient(
        cx - gDir.x * W * 0.5,
        cy - gDir.y * H * 0.9,
        cx + gDir.x * W * 0.5,
        cy + gDir.y * H * 0.9,
      );
      body.addColorStop(0, "rgba(255,255,255,0.17)");
      body.addColorStop(0.48, "rgba(255,255,255,0.035)");
      body.addColorStop(1, "rgba(255,255,255,0.07)");
      capsule();
      ctx.fillStyle = body;
      ctx.fill();

      // 2b) inner illumination (opt-in "Beleuchtung", Settings → Pille): the
      //     glass itself lights up and follows the voice. "status" = one soft
      //     light in the smoothed state color that leans toward the voice's
      //     spectral centroid; "siri" = a drifting multicolor aurora whose
      //     hues ride the timbre (bass → blue, mids → violet, treble → pink)
      //     and whose brightness rides the level. Clipped to the capsule and
      //     screen-blended over the smoke so it reads as light IN the glass,
      //     never as a painted tint. Default "aus" skips all of this.
      if (glow === "status" || glow === "siri") {
        const gEn = speaking
          ? 0.5 + 0.5 * Math.min(1, lvl * 1.15 + an.pulse * 0.25)
          : idleStill
            ? 0.26
            : 0.26 + 0.1 * Math.sin(ph * 0.045);
        ctx.save();
        capsule();
        ctx.clip();
        ctx.globalCompositeOperation = "screen";
        if (glow === "status") {
          const gx = cx + (an.pillCent - 0.5) * W * 0.55;
          const g = ctx.createRadialGradient(gx, cy, 0, gx, cy, W * 0.5);
          g.addColorStop(0, hexA(base, 0.52 * gEn));
          g.addColorStop(0.55, hexA(base, 0.24 * gEn));
          g.addColorStop(1, hexA(base, 0));
          ctx.fillStyle = g;
          ctx.fillRect(x0, y0, W, H);
        } else {
          // ★ Siri (Redesign nach TJ-Feedback zu v0.5.129): the RIM itself
          // lights up in traveling multicolor and radiates INWARD — the
          // Apple-Intelligence edge-glow — plus two ROUND, morphing Siri
          // orbs inside the glass. The palette cycles along the rim, the
          // voice drives brightness and inward bleed, the spectral centroid
          // leans the hot zone toward where the voice lives, and syllable
          // onsets flash the edge. (First cut was flat wash + smeared blobs
          // — TJ: "soll rund sein wie Siri, der Rand soll aufleuchten".)
          const SIRI = ["#3a8bff", "#8b5cf6", "#ff5fa2", "#ff9a3d"];
          const mix3 = (a: number[], b: number[], f: number) => [
            a[0] + (b[0] - a[0]) * f,
            a[1] + (b[1] - a[1]) * f,
            a[2] + (b[2] - a[2]) * f,
          ];
          /** Cyclic palette sample at u (wraps) — the traveling Siri color. */
          const siriCol = (u: number): string => {
            const uu = ((u % 1) + 1) % 1;
            const p = uu * SIRI.length;
            const i = Math.floor(p);
            return rgbHex(
              mix3(hexRgb(SIRI[i % SIRI.length]), hexRgb(SIRI[(i + 1) % SIRI.length]), p - i),
            );
          };
          // colors travel along the rim; the centroid shifts the phase so
          // deep vs. bright voices literally re-color the edge
          const drift = ph * 0.0035 + (an.pillCent - 0.5) * 0.5;
          const flash = 1 + 0.5 * an.pulse; // syllable onset → the edge flares
          const mkRim = (alpha: number) => {
            const g = ctx.createLinearGradient(x0, y0, x0 + W, y0 + H);
            for (let s = 0; s <= 5; s++)
              g.addColorStop(s / 5, hexA(siriCol(drift + s / 5), alpha));
            return g;
          };
          // three clipped rim strokes = the inward radiation (half of every
          // stroke falls outside the clip → pure edge-lit bleed): wide soft
          // wash, mid band, hot line at the glass edge.
          const bleed = 0.36 + 0.3 * gEn; // how deep the light reaches inward
          ctx.lineWidth = H * bleed * 2;
          ctx.strokeStyle = mkRim(0.17 * gEn * flash);
          capsule();
          ctx.stroke();
          ctx.lineWidth = H * 0.2;
          ctx.strokeStyle = mkRim(0.42 * gEn * flash);
          capsule();
          ctx.stroke();
          ctx.save();
          ctx.shadowColor = hexA(siriCol(drift + 0.5), 0.8 * gEn);
          ctx.shadowBlur = H * 0.2 * flash;
          ctx.lineWidth = Math.max(1.4, H * 0.055);
          ctx.strokeStyle = mkRim(0.95 * gEn * flash);
          capsule();
          ctx.stroke();
          ctx.restore();
          // two ROUND morphing orbs — white-hot core, colored fringe (the
          // Siri sphere feel); size breathes with "their" spectral region,
          // positions orbit slowly, luminous where they overlap.
          ctx.globalCompositeOperation = "lighter";
          for (let k = 0; k < 2; k++) {
            const gx = cx + Math.cos(ph * 0.011 + k * Math.PI) * W * 0.17;
            const gy = cy + Math.sin(ph * 0.017 + k * 2.1) * H * 0.2;
            const region = k === 0 ? 0.15 : 0.7; // bass orb + treble orb
            const morph = speaking ? 0.55 + 0.65 * bandNormAt(region) : 0.7 + 0.2 * Math.sin(ph * 0.023 + k);
            const rr = H * (0.36 + 0.1 * Math.sin(ph * 0.029 + k * 1.7)) * morph;
            const colK = siriCol(drift + 0.25 + k * 0.5);
            const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(1, rr));
            g.addColorStop(0, `rgba(255,255,255,${0.34 * gEn})`);
            g.addColorStop(0.32, hexA(colK, 0.4 * gEn));
            g.addColorStop(1, hexA(colK, 0));
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(gx, gy, Math.max(1, rr), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }

      // 3) specular streak (top-left), clipped to the glass; sweeps in from
      //    the left while the pill materializes (light catching the lens).
      ctx.save();
      capsule();
      ctx.clip();
      const specX =
        ap < 1 ? x0 + W * (0.08 + 0.18 * (1 - Math.pow(1 - ap, 2))) : cx - W * 0.24;
      const spec = ctx.createRadialGradient(
        specX,
        y0 + H * 0.2,
        0,
        specX,
        y0 + H * 0.2,
        W * 0.3,
      );
      spec.addColorStop(0, "rgba(255,255,255,0.28)");
      spec.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = spec;
      ctx.fillRect(x0, y0, W, H);
      // bottom-edge counter light: thick glass catches light on the lower rim
      const under = ctx.createLinearGradient(cx, y0 + H * 0.55, cx, y0 + H);
      under.addColorStop(0, "rgba(255,255,255,0)");
      under.addColorStop(1, "rgba(255,255,255,0.09)");
      ctx.fillStyle = under;
      ctx.fillRect(x0, y0, W, H);
      ctx.restore();

      // 4) rims — outer hairline + inner refraction ring (the "thick glass"
      //    double edge from the SCAI dome lens / iOS glass).
      const rim = ctx.createLinearGradient(cx, y0, cx, y0 + H);
      rim.addColorStop(0, `rgba(255,255,255,${0.4 + 0.18 * an.pulse})`);
      rim.addColorStop(1, "rgba(255,255,255,0.12)");
      ctx.strokeStyle = rim;
      ctx.lineWidth = Math.max(1.1, size * 0.01);
      capsule();
      ctx.stroke();
      const rimIn = ctx.createLinearGradient(cx, y0, cx, y0 + H);
      rimIn.addColorStop(0, "rgba(255,255,255,0.15)");
      rimIn.addColorStop(0.5, "rgba(255,255,255,0.02)");
      rimIn.addColorStop(1, "rgba(255,255,255,0.08)");
      ctx.strokeStyle = rimIn;
      ctx.lineWidth = Math.max(1.6, size * 0.016);
      capsule(Math.max(2.2, size * 0.022));
      ctx.stroke();

      // 5) nine spectrum bars behind the dome lens. Bass→sibilance left to
      //    right; positions run through the dome mapping (centre spacing
      //    magnified, rims compressed → content "bends" at the glass edge),
      //    heights get the vertical dome factor, alpha feathers out at the
      //    rims (the SCAI edge mask). At idle the bars rest as DOTS.
      const REST = [0.2, 0.33, 0.47, 0.62, 0.72, 0.62, 0.47, 0.33, 0.2];
      const N = 9;
      const barW = Math.max(1.8, H * 0.1);
      const span = W - H * 1.15; // usable width between the rounded ends
      if (!an.barH || an.barH.length !== N) an.barH = new Array(N).fill(0);
      // Balance pass (TJ 2026-07-09): rims listen to living speech frequencies
      // (walk ends ~upper-mid), every bar keeps a small broadband share so
      // none sits dead. Dynamics pass (TJ, same day, after v0.5.110): that
      // version opened ALL bars almost fully on every word, like a round fan —
      // the 25% broadband moved every bar in lockstep, the pure per-band AGC
      // pinned each band near its own peak, and mirror bars were pixel-
      // identical twins. Counters: mostly-AGC is blended with the ABSOLUTE
      // envelope (bass really is bigger than treble → bars get identity
      // back), broadband drops to 10%, and each side detunes its sampling a
      // touch so left and right stop moving as one.
      // Per-bar character (fixed, not random): each bar follows the voice at
      // its own attack/release speed — that desync is the "playful" motion.
      const PHI = [0.93, 0.18, 0.66, 0.41, 1, 0.29, 0.74, 0.12, 0.55];
      const DET = [-0.02, 0.045, -0.035, 0.02, 0, -0.03, 0.04, -0.045, 0.015];
      // TWO selectable REACTION types on the SAME dome pill, chosen in the
      // separate "Reaktion" menu (orb_pill_reaction), NOT the style picker:
      // "dynamik" (default) = the per-bar-character response below; "klassisch"
      // = the v0.5.109 centre-out response (strong centre arc, deep dynamics)
      // with only the rims gently livened. Shape is orthogonal to reaction.
      const reactionDyn = (v.pillReaction ?? "dynamik") !== "klassisch";
      let spk: number[] | null = null;
      if (speaking && reactionDyn) {
        const raw = new Array(N).fill(0);
        for (let i = 0; i < N; i++) {
          const d = Math.abs(i - (N - 1) / 2) / ((N - 1) / 2); // 0 Mitte .. 1 Rand
          // Fixed per-bar detune (breaks BOTH mirror pairs and neighbours —
          // a plain left/right split muted whichever rim drew the quiet side,
          // and parity tricks keep mirrors in sync). Scaled by d so the
          // centre stays pure bass; every position lands in living speech
          // frequencies (max walk 0.78 + 0.045 ≈ upper-mid, not sibilance).
          const pos = Math.min(1, Math.max(0, Math.pow(d, 1.35) * 0.78 + DET[i] * d));
          // d-weighted blend: rims lean on the auto-gain (their absolute
          // energy is tiny — pure absolute would mute them again), the centre
          // leans on the absolute envelope (it HAS energy — pure auto-gain
          // pinned it at full). Small broadband share keeps a common breath.
          const agcW = 0.5 + 0.2 * d;
          const absW = 0.42 - 0.3 * d;
          const bbW = 0.06 + 0.1 * d; // rims get more common breath — their
          // absolute energy is tiny; the centre barely any (it pumps itself)
          raw[i] = agcW * bandNormAt(pos) + absW * bandAt(pos) + bbW * Math.min(1, lvl);
        }
        // Gentler cohesion than v0.5.110 — enough to melt lone spikes, not
        // enough to iron the wave flat.
        spk = raw.map((_, i) => {
          const a = raw[Math.max(0, i - 1)];
          const b = raw[Math.min(N - 1, i + 1)];
          return 0.08 * a + 0.84 * raw[i] + 0.08 * b;
        });
      }
      ctx.lineCap = "round";
      ctx.save();
      ctx.shadowColor = hexA(base, 0.7);
      ctx.shadowBlur = Math.max(3, H * 0.18);
      if (speaking && viz === "welle") {
        // ★ Welle (Settings → Pille): a live oscilloscope trace — ONE glowing
        // line whose amplitude is the loudness history and whose carrier
        // phase advances with age, so the whole waveform visibly streams
        // right → left while you speak. (A filled mirrored envelope was the
        // first cut and read as a blob at pill size — the single line is the
        // elegant, instantly-readable "voice wave".) Amplitude tapers toward
        // the rims (the lens feel); the nine bar heights keep tracking the
        // trace's envelope so the release morph starts seamless.
        const M = 72;
        const slot = Math.max(2, Math.min(20, 4 / sp));
        const reach = (N - 1) * slot; // history span across the pill
        const sampleAt = (k: number): { x: number; env: number; age: number } => {
          const u = (k / (M - 1)) * 2 - 1;
          const uL = u * (1.1 - 0.22 * u * u);
          const domeY = 1.08 - 0.16 * uL * uL;
          const edge = 1 - 0.4 * Math.pow(Math.abs(uL), 3);
          const age = ((M - 1 - k) / (M - 1)) * reach;
          const a0 = Math.floor(age);
          const f = age - a0;
          const h0 = an.pillHist[a0] ?? 0;
          const h1 = an.pillHist[a0 + 1] ?? 0;
          const h2 = an.pillHist[a0 + 2] ?? 0;
          const h3 = an.pillHist[a0 + 3] ?? 0;
          // 4-tap smoothing — per-frame samples are too jittery for a line
          const sm = (h0 + (h1 - h0) * f) * 0.5 + h1 * 0.2 + h2 * 0.18 + h3 * 0.12;
          return {
            x: cx + (uL * span) / 2,
            env:
              H *
              Math.min(0.4, (0.045 + 0.36 * Math.pow(sm, 0.9)) * domeY) *
              Math.pow(edge, 0.7),
            age,
          };
        };
        const mzA =
          ap < 1 && apStyle !== "none" && apStyle !== "fade"
            ? Math.max(0, Math.min(1, (ap - 0.3) / 0.4))
            : 1;
        if (mzA > 0) {
          const pts: { x: number; y: number }[] = [];
          for (let k = 0; k < M; k++) {
            const p = sampleAt(k);
            // carrier rides the AGE: at a fixed x the phase advances every
            // frame → the wave itself streams leftward with the history
            pts.push({ x: p.x, y: cy - p.env * Math.sin(p.age * 0.55) });
          }
          const trace = () => {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let k = 1; k < M; k++) {
              const mx = (pts[k - 1].x + pts[k].x) / 2;
              const my = (pts[k - 1].y + pts[k].y) / 2;
              ctx.quadraticCurveTo(pts[k - 1].x, pts[k - 1].y, mx, my);
            }
            ctx.lineTo(pts[M - 1].x, pts[M - 1].y);
          };
          // wide soft pass = the light body, narrow bright pass = the trace
          ctx.strokeStyle = hexA(base, 0.22 * mzA);
          ctx.lineWidth = Math.max(3, H * 0.16);
          trace();
          ctx.stroke();
          ctx.strokeStyle = hexA(base, 0.95 * mzA);
          ctx.lineWidth = Math.max(1.4, H * 0.055);
          trace();
          ctx.stroke();
        }
        // hand the envelope to the bar smoother (seamless state morphs)
        for (let i = 0; i < N; i++) {
          const p = sampleAt(Math.round((i / (N - 1)) * (M - 1)));
          if (!Number.isFinite(an.barH[i])) an.barH[i] = 0;
          an.barH[i] += (p.env * 2 - an.barH[i]) * 0.5;
        }
        ctx.restore();
        ctx.lineCap = "butt";
        break;
      }

      // Session hygiene for the stateful visuals: a fresh idle clears the
      // word train and the spark pool (cheap no-ops in the default path —
      // both arrays stay empty unless their visual ran).
      if (stP === "idle") {
        if (an.words.length || an.wordCount) {
          an.words = [];
          an.wordCount = 0;
        }
        if (an.sparks.length) an.sparks = [];
      }
      // Materialize gate shared by the new visuals (bars use their per-bar
      // centre-out ignite instead).
      const mzGate = () =>
        ap < 1 && apStyle !== "none" && apStyle !== "fade"
          ? Math.max(0, Math.min(1, (ap - 0.3) / 0.4))
          : 1;
      // Soft resting-dot row + bar-smoother settle — the baseline under the
      // Funken/Puls visuals so the pill never looks empty mid-word.
      const dotRow = (alpha: number) => {
        const bH = an.barH as number[]; // initialised above on every pill frame
        for (let i = 0; i < N; i++) {
          const u = (i - (N - 1) / 2) / ((N - 1) / 2);
          const uL = u * (1.1 - 0.22 * u * u);
          const edgeA = 1 - 0.4 * Math.pow(Math.abs(uL), 3);
          ctx.fillStyle = hexA(base, alpha * edgeA);
          ctx.beginPath();
          ctx.arc(cx + (uL * span) / 2, cy, barW / 2, 0, Math.PI * 2);
          ctx.fill();
          if (!Number.isFinite(bH[i])) bH[i] = 0;
          bH[i] += (barW - bH[i]) * 0.2;
        }
      };

      // ★ Worte (Settings → Pille): what you SAY flows through the glass —
      // the live stable partial (echo://stream-partial) feeds a word train
      // that slides in from the right and streams out to the left, over a
      // subtle voice wave so the pill lives before the first word lands (and
      // in batch mode, where no partials exist, the wave carries it alone).
      // On release the train streams out; a fresh session resets it.
      if (viz === "worte" && (speaking || an.words.length > 0)) {
        const mzA = mzGate();
        if (speaking) {
          const raw = (text ?? "").trim();
          const ws = raw ? raw.split(/\s+/) : [];
          // the stable partial only ever grows within a session — a shrink
          // means a new session started while we still held old words
          if (ws.length < an.wordCount) {
            an.words = [];
            an.wordCount = 0;
          }
          while (an.wordCount < ws.length) {
            an.words.push({ w: ws[an.wordCount], x: Number.NaN, wpx: 0 });
            an.wordCount++;
          }
          if (an.words.length > 12) an.words.splice(0, an.words.length - 12);
        }
        // subtle voice wave underneath (a quiet mini-"welle")
        if (speaking && mzA > 0) {
          const slot = Math.max(2, Math.min(20, 4 / sp));
          const Mw = 40;
          ctx.strokeStyle = hexA(base, 0.3 * mzA);
          ctx.lineWidth = Math.max(1, H * 0.035);
          ctx.beginPath();
          for (let k = 0; k < Mw; k++) {
            const u = (k / (Mw - 1)) * 2 - 1;
            const uL = u * (1.1 - 0.22 * u * u);
            const age = ((Mw - 1 - k) / (Mw - 1)) * (N - 1) * slot;
            const a0 = Math.floor(age);
            const h0 = an.pillHist[a0] ?? 0;
            const h1 = an.pillHist[a0 + 1] ?? 0;
            const sm = h0 + (h1 - h0) * (age - a0);
            const xx = cx + (uL * span) / 2;
            const yy = cy + H * (0.05 + 0.32 * sm) * Math.sin(age * 0.55) * 0.5;
            if (k === 0) ctx.moveTo(xx, yy);
            else ctx.lineTo(xx, yy);
          }
          ctx.stroke();
        }
        // the word train — right-aligned targets, spring-in, stream-out
        const fs = Math.max(9, Math.round(H * 0.34));
        ctx.font = `600 ${fs}px -apple-system, system-ui, sans-serif`;
        ctx.textBaseline = "middle";
        for (const wd of an.words) if (!wd.wpx) wd.wpx = ctx.measureText(wd.w).width;
        const gapW = fs * 0.42;
        const targets = new Array<number>(an.words.length);
        let rightEdge = x0 + W - H * 0.55;
        for (let i = an.words.length - 1; i >= 0; i--) {
          targets[i] = rightEdge - an.words[i].wpx;
          rightEdge = targets[i] - gapW;
        }
        ctx.save();
        capsule();
        ctx.clip(); // words must never leave the glass
        ctx.shadowColor = hexA(base, 0.55);
        ctx.shadowBlur = H * 0.12;
        for (let i = an.words.length - 1; i >= 0; i--) {
          const wd = an.words[i];
          if (!Number.isFinite(wd.x)) wd.x = x0 + W + fs;
          if (speaking) wd.x += (targets[i] - wd.x) * 0.16;
          else wd.x -= H * 0.14; // released → the train streams out left
          // Asymmetric fade: born OUTSIDE the right rim a word fades IN as
          // it slides through the glass edge, and fades OUT approaching the
          // left rim. Removal ONLY on full left exit — a fresh word must
          // never be culled by its own spawn position (first cut did, the
          // train stayed forever empty).
          if (wd.x + wd.wpx < x0 + H * 0.3) {
            an.words.splice(i, 1);
            continue;
          }
          const xc = wd.x + wd.wpx / 2;
          const fadeL = Math.max(0, Math.min(1, (xc - (x0 + H * 0.45)) / (W * 0.16)));
          const fadeR = Math.max(0, Math.min(1, (x0 + W - H * 0.25 - xc) / (W * 0.07)));
          const aW = fadeL * fadeR;
          if (aW <= 0.01) continue; // outside the glass — slide on, invisible
          ctx.fillStyle = hexA(base, 0.95 * aW * mzA);
          ctx.fillText(wd.w, wd.x, cy);
        }
        ctx.restore();
        // keep the bar smoother settled → calm morph when the bars return
        for (let i = 0; i < N; i++) {
          if (!Number.isFinite(an.barH[i])) an.barH[i] = 0;
          an.barH[i] += (barW - an.barH[i]) * 0.2;
        }
        ctx.restore();
        ctx.lineCap = "butt";
        break;
      }

      // ★ Funken (eigener Stil): syllables strike sparks — glowing embers fly
      // off the voice, ride a leftward wind with a little flicker and burn
      // out. Spawn is deterministic (sin-hash of frame+index, no
      // Math.random) so preview and overlay render reproducibly.
      if (viz === "funken" && (speaking || an.sparks.length > 0)) {
        const mzA = mzGate();
        const rnd = (n: number) => {
          const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
          return s - Math.floor(s);
        };
        if (speaking && !idleStill) {
          const want = lvl > 0.06 ? Math.min(6, Math.floor(1 + lvl * 3 + an.pulse * 4)) : 0;
          for (let k = 0; k < want; k++) {
            const r1 = rnd(frame * 7.13 + k * 13.7);
            const r2 = rnd(frame * 3.71 + k * 29.3);
            const r3 = rnd(frame * 11.9 + k * 5.1);
            an.sparks.push({
              x: cx + (r1 - 0.35) * span * 0.55, // right bias — embers drift left
              y: cy + (r2 - 0.5) * H * 0.3,
              vx: -(0.4 + r3 * 1.4) * H * 0.028 * sp,
              vy: (r2 - 0.5) * H * 0.014,
              life: 1,
              sz: barW * (0.3 + 0.5 * r1),
            });
          }
          if (an.sparks.length > 90) an.sparks.splice(0, an.sparks.length - 90);
        }
        dotRow(0.35 * mzA); // ember baseline: the dots stay softly lit
        ctx.save();
        capsule();
        ctx.clip();
        ctx.globalCompositeOperation = "lighter";
        for (let i = an.sparks.length - 1; i >= 0; i--) {
          const s = an.sparks[i];
          s.x += s.vx;
          s.y += s.vy + Math.sin((s.x - x0) * 0.08 + ph * 0.1) * H * 0.004;
          s.life *= speaking ? 0.965 : 0.9;
          if (s.life < 0.04 || s.x < x0 - 4) {
            an.sparks.splice(i, 1);
            continue;
          }
          ctx.fillStyle = hexA(base, 0.9 * s.life * mzA);
          ctx.beginPath();
          ctx.arc(s.x, s.y, Math.max(0.6, s.sz * s.life), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        ctx.restore();
        ctx.lineCap = "butt";
        break;
      }

      // ★ Puls (eigener Stil): sonar under the lens — every syllable births
      // an elliptic ring in the centre that expands toward the pill's ends
      // and dissolves; loud voices fire bright dense rings, silence leaves
      // the calm dot row. Rides the shared `an.rings` pool (progress 0..1).
      if (viz === "puls" && (speaking || rings.length > 0)) {
        const mzA = mzGate();
        // Sparse by design: onsets fire, plus a slow heartbeat while loud —
        // the first cut (every 22 frames at slow expansion) stacked ~30
        // concentric rings into a muddy tunnel. Cap keeps worst-case clean.
        if (speaking && !idleStill && (onset || (lvl > 0.15 && frame % 36 === 0))) {
          rings.push({ r: 0, a0: 0.4 + 0.6 * Math.min(1, lvl + an.pulse * 0.4) });
          if (rings.length > 10) rings.shift();
        }
        dotRow(0.35 * mzA);
        ctx.save();
        capsule();
        ctx.clip();
        for (let i = rings.length - 1; i >= 0; i--) {
          const ring = rings[i];
          ring.r += 0.021 * sp * (1 + ring.a0 * 0.3); // r doubles as progress 0..1
          const p = ring.r;
          if (p >= 1) {
            rings.splice(i, 1);
            continue;
          }
          ctx.strokeStyle = hexA(base, ring.a0 * Math.pow(1 - p, 1.6) * mzA);
          ctx.lineWidth = Math.max(1, H * 0.05 * (1 - p * 0.5));
          ctx.beginPath();
          ctx.ellipse(
            cx,
            cy,
            H * 0.2 + p * (span / 2 - H * 0.1),
            H * (0.1 + 0.3 * p),
            0,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        }
        ctx.restore();
        ctx.restore();
        ctx.lineCap = "butt";
        break;
      }

      // ★ Helix (eigener Stil): two counter-phased strands wind around the
      // centre line like DNA — the amplitude is the voice envelope (the
      // helix opens where you speak), the phase drifts so it visibly
      // rotates, and faint rungs tie the strands together.
      if (speaking && viz === "helix") {
        const mzA = mzGate();
        const Mh = 64;
        const slot = Math.max(2, Math.min(20, 4 / sp));
        const envAt = (k: number): number => {
          const age = ((Mh - 1 - k) / (Mh - 1)) * (N - 1) * slot;
          const a0 = Math.floor(age);
          const h0 = an.pillHist[a0] ?? 0;
          const h1 = an.pillHist[a0 + 1] ?? 0;
          const h2 = an.pillHist[a0 + 2] ?? 0;
          const sm = (h0 + (h1 - h0) * (age - a0)) * 0.6 + (h1 + h2) * 0.2;
          return H * Math.min(0.36, 0.06 + 0.32 * Math.pow(sm, 0.9));
        };
        const xAt = (k: number): number => {
          const u = (k / (Mh - 1)) * 2 - 1;
          return cx + (u * (1.1 - 0.22 * u * u) * span) / 2;
        };
        const yAt = (k: number, strand: number): number =>
          cy +
          envAt(k) * Math.sin((k / (Mh - 1)) * Math.PI * 3.6 + ph * 0.07 + strand * Math.PI);
        if (mzA > 0) {
          // rungs first (behind the strands)
          ctx.strokeStyle = hexA(base, 0.2 * mzA);
          ctx.lineWidth = Math.max(0.8, H * 0.022);
          for (let k = 4; k < Mh - 3; k += 8) {
            ctx.beginPath();
            ctx.moveTo(xAt(k), yAt(k, 0));
            ctx.lineTo(xAt(k), yAt(k, 1));
            ctx.stroke();
          }
          // strands as midpoint quadratics — straight segments read angular
          // at the crossings (screenshot pass)
          for (let strand = 0; strand < 2; strand++) {
            ctx.strokeStyle = hexA(base, (strand === 0 ? 0.95 : 0.55) * mzA);
            ctx.lineWidth = Math.max(1.2, H * 0.05);
            ctx.beginPath();
            ctx.moveTo(xAt(0), yAt(0, strand));
            for (let k = 1; k < Mh; k++) {
              const mx = (xAt(k - 1) + xAt(k)) / 2;
              const my = (yAt(k - 1, strand) + yAt(k, strand)) / 2;
              ctx.quadraticCurveTo(xAt(k - 1), yAt(k - 1, strand), mx, my);
            }
            ctx.lineTo(xAt(Mh - 1), yAt(Mh - 1, strand));
            ctx.stroke();
          }
        }
        // hand the envelope to the bar smoother (seamless state morphs)
        for (let i = 0; i < N; i++) {
          const e2 = envAt(Math.round((i / (N - 1)) * (Mh - 1))) * 2;
          if (!Number.isFinite(an.barH[i])) an.barH[i] = 0;
          an.barH[i] += (e2 - an.barH[i]) * 0.5;
        }
        ctx.restore();
        ctx.lineCap = "butt";
        break;
      }
      for (let i = 0; i < N; i++) {
        const u = (i - (N - 1) / 2) / ((N - 1) / 2); // -1..1 across the pill
        const uL = u * (1.1 - 0.22 * u * u); // dome: centre magnified, rims squeezed
        const domeY = 1.08 - 0.16 * uL * uL; // vertical lens magnification
        const edgeA = 1 - 0.4 * Math.pow(Math.abs(uL), 3); // rim feather
        const bx = cx + (uL * span) / 2;

        let tH: number;
        if (speaking && flowViz) {
          // "Laufband"/"Zentrum" (Settings → Pille): the loudness history
          // flows THROUGH the nine bars — each bar reads the history at an
          // age proportional to its distance from the entry edge ("laufband":
          // speech runs in on the right and marches left) or from the centre
          // ("zentrum": syllables surface in the middle and drift out to both
          // rims). Fractional reads make the wave travel smoothly instead of
          // stepping; the speed slider drives the travel (frames per bar).
          const slot = Math.max(2, Math.min(20, 4 / sp));
          const age =
            (viz === "laufband" ? N - 1 - i : Math.abs(i - (N - 1) / 2) * 2) * slot;
          const a0 = Math.floor(age);
          const f = age - a0;
          const h0 = an.pillHist[a0] ?? 0;
          const h1 = an.pillHist[a0 + 1] ?? 0;
          const sm = h0 + (h1 - h0) * f;
          tH = H * Math.min(0.85, 0.09 + 0.83 * Math.pow(sm, 0.8));
        } else if (speaking && spk) {
          // "Dynamik": per-bar frequency colouring + flatter shape + more
          // contrast — every bar plays its own game (see the block above).
          const resp = Math.pow(spk[i], 0.85);
          const shape = 0.68 + 0.32 * REST[i];
          tH = H * Math.min(0.85, shape * (0.08 + 0.92 * resp));
        } else if (speaking) {
          // "Klassisch" = the v0.5.109 response, verbatim — centre-out spectrum,
          // centre-tall shape, deep dynamics — plus ONE gentle touch: the
          // rims get a small voice-following lift (they sampled sibilance
          // land and sat dead between 's' sounds; TJ: "wenn nur die außen
          // bisschen mehr reagieren würden"). Centre bars are untouched.
          const d = Math.abs(i - (N - 1) / 2) / ((N - 1) / 2); // 0 Mitte .. 1 Rand
          const dd = d * d * d * d; // only the outermost pair really feels the lift
          const bn = Math.min(1, bandNormAt(d) + 0.2 * dd * Math.min(1, lvl));
          const resp = Math.pow(bn, 0.7);
          const shape = 0.55 + 0.45 * REST[i];
          tH = H * Math.min(0.85, shape * (0.1 + 0.95 * resp));
        } else if (stP === "idle") {
          // resting = DOTS; the idle-animation toggle makes them breathe.
          // NEGATIVE phase offset → the crest travels left → right (TJ; with
          // +i the right dots led the phase and the wave read right → left).
          const wave =
            v.idlePulse && !idleStill ? 0.5 + 0.5 * Math.sin(ph * 0.09 - i * 0.8) : 0;
          tH = barW * (1 + 0.65 * wave);
        } else {
          // transcribing: barely above the dots — a subtle shimmer that says
          // "arbeitet" without lighting the whole pill up (the old 0.55+0.6
          // amplitude made every release flash all bars at once — TJ). Error
          // stays taller so a dead mic is still unmissable.
          const wave = idleStill ? 0.35 : 0.5 + 0.5 * Math.sin(ph * 0.11 - i * 0.9);
          const amp = stP === "error" ? 0.45 + 0.4 * wave : 0.26 + 0.28 * wave * energy;
          tH = H * REST[i] * amp;
        }
        tH *= domeY;
        // Per-bar smoothing: while speaking every bar has its OWN attack and
        // release speed (PHI) — syllables pop different bars at different
        // moments and each sinks on its own clock. That fixed desync is what
        // makes the pill "play" instead of opening as one synced fan (TJ).
        // State edges (release → transcribing → idle) keep the slow morph.
        if (!Number.isFinite(an.barH[i])) an.barH[i] = 0; // Selbstheilung
        const kBar = speaking
          ? flowViz
            ? 0.5 // flow visuals: the history is already smooth — follow crisply
            : reactionDyn
              ? tH > an.barH[i]
                ? 0.32 + 0.42 * PHI[i]
                : 0.14 + 0.16 * PHI[i]
              : 0.55 // klassisch: the v0.5.109 uniform snap
          : 0.16;
        an.barH[i] += (tH - an.barH[i]) * kBar;
        let hBar = an.barH[i];

        // Materialize: bars ignite centre-out after the glass has condensed.
        if (ap < 1 && apStyle !== "none" && apStyle !== "fade") {
          const bs = Math.max(
            0,
            Math.min(1, (ap - 0.3 - Math.abs(i - (N - 1) / 2) * 0.055) / 0.28),
          );
          if (bs <= 0) continue;
          hBar *= backOut(bs);
        }

        if (hBar <= barW * 1.7) {
          // resting dot — a filled circle reads cleaner than a zero-length
          // round-cap stroke (breathing scales the radius slightly)
          ctx.fillStyle = hexA(base, 0.92 * edgeA);
          ctx.beginPath();
          ctx.arc(bx, cy, (barW / 2) * Math.max(1, hBar / barW), 0, Math.PI * 2);
          ctx.fill();
        } else if (viz === "matrix" && hBar > barW * 2.6) {
          // ★ Matrix (Settings → Pille): the bar's smoothed height quantises
          // into a column of discrete LED dots growing from the centre —
          // retro VU. The height pipeline (reaction, AGC, morphs) is shared
          // with the bars; only the drawing is discretised. Below the 2.6×
          // threshold (resting dots, the idle breathing crest, tiny release
          // tails) matrix falls through to the standard drawing, so at rest
          // it is pixel-identical to the standard pill.
          const nD = Math.max(2, Math.min(5, Math.round(hBar / (barW * 1.55))));
          const gapD = Math.min(barW * 1.7, hBar / (nD - 1));
          ctx.fillStyle = hexA(base, 0.92 * edgeA);
          for (let j = 0; j < nD; j++) {
            ctx.beginPath();
            ctx.arc(bx, cy + (j - (nD - 1) / 2) * gapD, barW / 2, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          ctx.strokeStyle = hexA(base, 0.92 * edgeA);
          ctx.lineWidth = barW;
          ctx.beginPath();
          ctx.moveTo(bx, cy - hBar / 2);
          ctx.lineTo(bx, cy + hBar / 2);
          ctx.stroke();
        }
      }
      ctx.restore();
      ctx.lineCap = "butt";
      break;
    }
    default: {
      // "ping" — slow echo rings that expand WIDE and fade out softly, + center dot.
      // Emit far less often than before (TJ: old frequency was way too high) and let
      // each ring travel almost to the edge while easing its alpha down to nothing.
      const maxR = size * 0.47;
      const grow = size * 0.0026 * (1 + energy * 0.6) * sp;
      const spawnEvery = (st === "recording" ? Math.max(30, 64 - lvl * 34) : 96) / sp;
      // No new echo rings while resting with idle animation off — let the
      // in-flight ones fade out, leaving just the calm centre dot.
      if (!idleStill && frame % Math.max(1, Math.round(spawnEvery)) === 0) {
        rings.push({ r: dotR, a0: 0.5 + energy * 0.35 });
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i];
        ring.r += grow;
        const p = (ring.r - dotR) / (maxR - dotR); // 0 at birth → 1 at the edge
        if (p >= 1) {
          rings.splice(i, 1);
          continue;
        }
        // ease-out fade: bright near the dot, gone by the time it's big + thinning line
        const a = ring.a0 * (1 - p) * (1 - p);
        ctx.strokeStyle = hexA(base, a);
        ctx.lineWidth = Math.max(1.2, size * 0.012 * (1 - p * 0.5));
        ctx.beginPath();
        ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = hexA(base, 0.85 + 0.15 * energy);
      ctx.beginPath();
      ctx.arc(cx, cy, dotR * (0.85 + energy * 0.3), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore(); // undo the materialize scale/alpha

  // Bloom flash — additive light ON TOP of the freshly drawn style, so the
  // orb literally lights up out of nothing and the flare fades into its glow.
  // Flash color = the configured IDLE color (TJ) — the orb wakes up in its
  // resting tint, not in whatever state triggered the show; frost when the
  // pill runs in the colorless glass mode.
  if (bloomA > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const isPill = isPillStyle;
    const flashCol = isPill && pillMode === "glass" ? FROST : v.colors.idle;
    const rx = (isPill ? size * 0.44 : size * 0.36) * (0.6 + 0.7 * ap);
    const ry = (isPill ? size * 0.19 : size * 0.36) * (0.6 + 0.7 * ap);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    g.addColorStop(0, `rgba(255,255,255,${0.55 * bloomA})`);
    g.addColorStop(0.35, hexA(flashCol, 0.5 * bloomA));
    g.addColorStop(1, hexA(flashCol, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.globalAlpha = 1; // reset after a dimmed idle frame
}
