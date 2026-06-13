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
}

/** Mutable per-canvas animation scratch — advanced in place by `drawOrb`. */
export interface OrbAnim {
  t: number;
  frame: number;
  rings: { r: number; a0: number }[];
  blips: { ang: number; dist: number; a: number }[];
  peaks: number[];
  lvlAvg: number;
}

export function newOrbAnim(): OrbAnim {
  return { t: 0, frame: 0, rings: [], blips: [], peaks: new Array(16).fill(0), lvlAvg: 0 };
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
 * animation forward between calls. Returns nothing; mutates `ctx` and `an`.
 */
export function drawOrb(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  v: OrbVisual,
  st: EngineState,
  level: number,
  an: OrbAnim,
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
  const lvl = Math.min(1, level);
  // idle → idle · recording/transcribing → working · done → done · error → error.
  const base =
    st === "recording" || st === "transcribing"
      ? v.colors.working
      : st === "done"
        ? v.colors.done
        : st === "error"
          ? v.colors.error
          : v.colors.idle;
  const dotR = size * 0.1;
  // When idle animation is OFF, freeze every style's time-based motion so the
  // orb truly rests — the audio-track styles (bars/wave) then react ONLY to
  // real speech while recording, not to a constant idle shimmer. `ph` is the
  // frozen phase fed to the per-style oscillators.
  const idleStill = st === "idle" && !v.idlePulse;
  const ph = idleStill ? 0 : t;

  ctx.clearRect(0, 0, w, h);

  // Idle behaviour: "hide" → render nothing (canvas already cleared); "dim" →
  // draw at reduced opacity (a calm, semi-transparent resting orb instead of
  // vanishing); "normal" → full strength.
  if (st === "idle" && v.idleMode === "hide") {
    return;
  }
  ctx.globalAlpha = st === "idle" && v.idleMode === "dim" ? 0.32 : 1;

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
        // While recording, the bar HEIGHT is the real mic level (center-weighted) —
        // small dots when silent, springing up as you speak — with only a tiny per-bar
        // shimmer so it reads as a live VU meter, not a self-running animation.
        // Otherwise (idle/transcribing) keep the gentle breathing.
        const amp = speaking
          ? Math.min(1, 0.05 + lvl * center * 1.55)
          : energy * center + 0.08;
        const shimmer = speaking
          ? 0.9 + 0.1 * Math.sin(ph * 0.5 + i)
          : 0.6 + 0.4 * Math.abs(Math.sin(ph * 0.2 + i));
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
        const band = speaking
          ? 0.55 + 0.45 * Math.abs(Math.sin(ph * 0.33 + i * 1.7))
          : 0.45 + 0.55 * Math.abs(Math.sin(ph * 0.13 + i * 1.7));
        const amp = speaking
          ? Math.min(1, (0.04 + lvl * 1.5) * profile * band)
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
        // top (dir -1) and bottom (dir 1) on different frequencies/offsets —
        // that asymmetry is what makes it read "up AND down", not mirrored.
        const lobes: [number, number][] = [
          [
            speaking
              ? 0.72 + 0.28 * Math.abs(Math.sin(ph * 0.45 + i * 1.7))
              : 0.5 + 0.5 * Math.abs(Math.sin(ph * 0.16 + i * 1.7)),
            -1,
          ],
          [
            speaking
              ? 0.72 + 0.28 * Math.abs(Math.sin(ph * 0.37 + i * 2.3 + 2.1))
              : 0.5 + 0.5 * Math.abs(Math.sin(ph * 0.13 + i * 2.3 + 2.1)),
            1,
          ],
        ];
        for (const [shimmer, dir] of lobes) {
          const amp = speaking
            ? Math.min(1, (0.05 + lvl * 1.5) * profile) * shimmer
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
        const band = 0.35 + 0.65 * Math.abs(Math.sin(ph * 0.17 + i * 2.4));
        const len = idleStill
          ? size * 0.012
          : speaking
            ? size * (0.015 + lvl * 0.23 * band)
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

  ctx.globalAlpha = 1; // reset after a dimmed idle frame
}
