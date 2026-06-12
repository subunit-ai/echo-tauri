import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  BAN_PATHS,
  BRIEFCASE_PATHS,
  CLOUD_PATHS,
  GLOBE_PATHS,
  HASH_PATHS,
  MAIL_PATHS,
  SHIELD_CHECK_PATHS,
  SPARKLES_PATHS,
  STAR4_PATHS,
  TERMINAL_PATHS,
  WAND_PATHS,
  StrokeIcon,
} from "../components/icons";
import {
  onState,
  orbQuick,
  orbSet,
  setOrbPosition,
  type EngineState,
  type OrbQuick,
} from "../lib/ipc";

// Per-state orb colors are user-configurable in Settings (idle / working / done /
// error). `working` covers both recording AND transcribing (the "busy" states).
// `error` defaults to a warning amber but is now themable like the rest.
// Defaults mirror the previous hardcoded look.
const DEFAULT_IDLE = "#22d3ee";
const DEFAULT_WORKING = "#ff5c5c";
const DEFAULT_DONE = "#50dc82";
const DEFAULT_ERROR = "#ffc450";

function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ---- Island layout --------------------------------------------------------
// The window is the orb square PLUS transparent gutters where the islands live
// (left / right / above / below) so they never cover the canvas drawing.
// KEEP IN SYNC with GUTTER_* in src-tauri/src/overlay.rs.
const GUTTER_X = 168;
const GUTTER_TOP = 168;
const GUTTER_BOTTOM = 64;
const GAP = 18; // clear air between the orb canvas and an island
const CHIP = 38; // collapsed island (icon chip) diameter
const PANEL_W = GUTTER_X - GAP; // expanded island width — fills its gutter

const MODE_COLOR: Record<string, string> = {
  local: "#22d3ee",
  cloud: "#5b9dff",
};

// Liquid-Glass (dark, floats over arbitrary screen content). The overlay window
// is transparent, so `backdrop-filter` blurs the real desktop/app content BEHIND
// it — a thin translucent navy tint over that blur reads as proper frosted glass
// (TJ: "noch transparenter, mehr Liquid Glass"). Hairline + top rim keep the edge.
const glassSurface: CSSProperties = {
  background: "rgba(12,24,46,0.52)",
  backdropFilter: "blur(22px) saturate(1.6)",
  WebkitBackdropFilter: "blur(22px) saturate(1.6)",
  border: "1px solid rgba(165,200,240,0.16)",
  boxShadow:
    "inset 0 1px 0 rgba(205,228,255,0.16), 0 16px 38px -18px rgba(0,0,0,0.55)",
};

const EASE = "cubic-bezier(.2,.8,.2,1)";

const rowStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 9,
  height: 34,
  padding: "0 10px",
  borderRadius: 12,
  border: `1px solid ${active ? "rgba(34,211,238,0.5)" : "transparent"}`,
  background: active ? "rgba(34,211,238,0.14)" : "transparent",
  color: active ? "#67e8f9" : "#cfe0f2",
  fontSize: 12.5,
  fontWeight: 600,
  letterSpacing: "0.01em",
  whiteSpace: "nowrap",
  cursor: "pointer",
  userSelect: "none",
  textAlign: "left",
  width: "100%",
});

/** One option inside an expanded island: icon + label, cyan when active. */
function Row({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string[];
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      style={rowStyle(active)}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "rgba(255,255,255,0.07)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <StrokeIcon paths={icon} size={15} strokeWidth={1.9} />
      {label}
    </button>
  );
}

/**
 * The floating orb. A transparent, click-through overlay window renders this;
 * the Rust hit-test loop reports engagement via `echo://orb-hover` (the webview
 * gets no mouse events while click-through, so it can't track hover itself).
 *
 * Engaged → three icon-only glass chips appear around the orb (mode left,
 * language above, cleanup right) plus the ✦ console chip below. Each chip
 * springs on hover and blooms ONLY its own option panel — every value visible,
 * one click to set (`orb_set`). The other chips stay put so you can switch.
 * Returning to the orb collapses the panel back to a chip; leaving the window
 * hides everything.
 */
export function Orb() {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const state = useRef<EngineState>("idle");
  const level = useRef(0);
  const style = useRef("ping");
  const colorIdle = useRef(DEFAULT_IDLE);
  const colorWorking = useRef(DEFAULT_WORKING);
  const colorDone = useRef(DEFAULT_DONE);
  const colorError = useRef(DEFAULT_ERROR);
  const idlePulse = useRef(true);
  const idleMode = useRef<"normal" | "dim" | "hide">("normal");
  const speed = useRef(0.6);
  const [quick, setQuick] = useState<OrbQuick | null>(null);
  const [hover, setHover] = useState(false);
  // Which single satellite is expanded (null = just the icon chips). Hovering a
  // chip opens ONLY its own panel — not all three at once (TJ).
  const [openPanel, setOpenPanel] = useState<"mode" | "language" | "cleanup" | null>(null);

  useEffect(() => {
    invoke<Record<string, unknown>>("get_config")
      .then((c) => {
        style.current = (c.orb_overlay_style as string) || "ping";
        if (typeof c.orb_color_idle === "string" && c.orb_color_idle) colorIdle.current = c.orb_color_idle;
        if (typeof c.orb_color_working === "string" && c.orb_color_working) colorWorking.current = c.orb_color_working;
        if (typeof c.orb_color_done === "string" && c.orb_color_done) colorDone.current = c.orb_color_done;
        if (typeof c.orb_color_error === "string" && c.orb_color_error) colorError.current = c.orb_color_error;
        idlePulse.current = c.orb_idle_pulse !== false;
        if (c.orb_idle_mode === "dim" || c.orb_idle_mode === "hide") idleMode.current = c.orb_idle_mode;
        else idleMode.current = "normal";
        if (typeof c.orb_speed === "number") speed.current = c.orb_speed;
      })
      .catch(() => {});
    orbQuick().then(setQuick).catch(() => {});
    const un = onState((p) => {
      state.current = p.state;
    });
    // Live config updates from Settings (set_config emits this) — restyle without
    // reload, and refresh the satellite quick-state so a mode/language/cleanup
    // change made in the main window shows on the orb too.
    const unCfg = listen<{
      style?: string;
      colorIdle?: string;
      colorWorking?: string;
      colorDone?: string;
      colorError?: string;
      idlePulse?: boolean;
      idleMode?: "normal" | "dim" | "hide";
      speed?: number;
      quick?: OrbQuick;
    }>("echo://orb-config", (e) => {
      const p = e.payload;
      if (typeof p.style === "string") style.current = p.style;
      if (p.colorIdle) colorIdle.current = p.colorIdle;
      if (p.colorWorking) colorWorking.current = p.colorWorking;
      if (p.colorDone) colorDone.current = p.colorDone;
      if (p.colorError) colorError.current = p.colorError;
      idlePulse.current = p.idlePulse !== false;
      if (p.idleMode) idleMode.current = p.idleMode;
      if (typeof p.speed === "number") speed.current = p.speed;
      if (p.quick) setQuick(p.quick);
    });
    // Engagement from the Rust hit-test loop: shows/hides the islands. On
    // disengage the panels also fold back so the next hover starts calm.
    const unHover = listen<{ hover: boolean }>("echo://orb-hover", (e) => {
      setHover(e.payload.hover);
      if (!e.payload.hover) setOpenPanel(null);
    });
    return () => {
      un.then((f) => f());
      unCfg.then((f) => f());
      unHover.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // The canvas covers ONLY the orb square (the gutters belong to the islands),
    // so it sizes against its box, not the window.
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = Math.floor(box.clientWidth * dpr);
      canvas.height = Math.floor(box.clientHeight * dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    // Mic level: poll while recording, decay otherwise. VU-style smoothing — jump UP
    // instantly on a louder sample (so bars pop the moment you speak) but ease DOWN
    // gently, so the orb tracks the voice instead of just shimmering on its own.
    const poll = window.setInterval(async () => {
      if (state.current === "recording") {
        try {
          const raw = await invoke<number>("mic_level");
          level.current = raw > level.current ? raw : level.current * 0.82 + raw * 0.18;
        } catch {
          /* ignore */
        }
      } else {
        level.current *= 0.85;
      }
    }, 50);

    let t = 0;
    let frame = 0;
    let raf = 0;
    const rings: { r: number; a0: number }[] = [];
    // Per-style persistent state (kept across frames, harmless when unused):
    // sonar2 contact blips · bars2 peak-hold caps · ping2's slow mic average
    // (rings fire on voice ONSETS — level spikes above this average).
    const blips: { ang: number; dist: number; a: number }[] = [];
    const peaks: number[] = new Array(16).fill(0);
    let lvlAvg = 0;

    const loop = () => {
      // Animation speed (TJ: the default cadence felt too fast — now adjustable).
      // `t` (scaled) drives every continuous frequency below; `frame` (real frames)
      // drives the discrete ping-ring spawn cadence so its modulo stays integer.
      const sp = Math.max(0.2, Math.min(2, speed.current));
      frame += 1;
      t += sp;
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const size = Math.min(w, h);
      const lvl = Math.min(1, level.current);
      const st = state.current;
      // idle → colorIdle · recording/transcribing → colorWorking · done → colorDone
      // · error → colorError (defaults to warning amber).
      const base =
        st === "recording" || st === "transcribing"
          ? colorWorking.current
          : st === "done"
            ? colorDone.current
            : st === "error"
              ? colorError.current
              : colorIdle.current;
      const dotR = size * 0.1;
      // When idle animation is OFF, freeze every style's time-based motion so the
      // orb truly rests — the audio-track styles (bars/wave) then react ONLY to
      // real speech while recording, not to a constant idle shimmer. `ph` is the
      // frozen phase fed to the per-style oscillators.
      const idleStill = st === "idle" && !idlePulse.current;
      const ph = idleStill ? 0 : t;

      ctx.clearRect(0, 0, w, h);

      // Idle behaviour: "hide" → render nothing (canvas already cleared); "dim" →
      // draw at reduced opacity (a calm, semi-transparent resting orb instead of
      // vanishing); "normal" → full strength.
      if (st === "idle" && idleMode.current === "hide") {
        raf = requestAnimationFrame(loop);
        return;
      }
      ctx.globalAlpha = st === "idle" && idleMode.current === "dim" ? 0.32 : 1;

      // breathing factor for idle / transcribing
      const breathe =
        st === "transcribing"
          ? 0.5 + 0.5 * Math.sin(t * 0.18)
          : st === "idle"
            ? idlePulse.current
              ? 0.55 + 0.45 * Math.sin(t * 0.05)
              : 0.7
            : 1;
      // While recording, energy is voice-dominated with only a small floor, so every
      // style visibly reacts to how loud you speak (not a constant idle shimmer).
      const energy = st === "recording" ? 0.12 + lvl * 0.88 : breathe * 0.6;
      const speaking = st === "recording";

      switch (style.current) {
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
          lvlAvg = lvlAvg * 0.92 + lvl * 0.08;
          const onset = speaking && lvl > 0.1 && lvl > lvlAvg * 1.35;
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
        case "bars2": {
          // Bars V2 — a 13-band spectrum with slowly-falling peak-hold caps
          // (classic VU peaks), mirrored around the centre line. Same live-VU
          // contract as "bars": height IS the mic level while recording.
          const n = 13;
          const bw = size * 0.028;
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
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(poll);
      window.removeEventListener("resize", resize);
    };
  }, []);

  // Persist the position after the user drags the orb (the canvas is a
  // data-tauri-drag-region, so dragging it moves this window). The saved value
  // is the ORB square's top-left (window + gutters) — the same coordinate the
  // pre-gutter builds saved, so old positions keep working. Debounced so we
  // save once the drag settles, not on every intermediate move event.
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: number | undefined;
    const un = win.onMoved(() => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const pos = await win.outerPosition();
          const sf = await win.scaleFactor();
          await setOrbPosition(pos.x / sf + GUTTER_X, pos.y / sf + GUTTER_TOP);
        } catch {
          /* ignore */
        }
      }, 450);
    });
    return () => {
      if (timer) window.clearTimeout(timer);
      un.then((f) => f());
    };
  }, []);

  const pick = (which: "mode" | "language" | "cleanup", value: string) => () => {
    orbSet(which, value).then(setQuick).catch(() => {});
  };

  // Vertical center of the orb square, as a CSS calc (the orb sits between the
  // top and bottom gutters; its box height is only known to CSS).
  const orbMidY = `calc(${GUTTER_TOP}px + (100% - ${GUTTER_TOP + GUTTER_BOTTOM}px) / 2)`;

  const chipBase: CSSProperties = {
    ...glassSurface,
    position: "absolute",
    width: CHIP,
    height: CHIP,
    borderRadius: 999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#cfe0f2",
    cursor: "pointer",
    userSelect: "none",
    padding: 0,
    transition: `opacity 0.18s ease, transform 0.22s ${EASE}`,
  };
  // A chip shows while engaged, EXCEPT the one whose own panel is currently open
  // (that panel takes its place). The others stay as chips so you can switch.
  const chipVis = (vis: boolean): CSSProperties => ({
    opacity: vis ? 1 : 0,
    transform: vis ? "scale(1)" : "scale(0.7)",
    pointerEvents: vis ? "auto" : "none",
  });

  const panelBase: CSSProperties = {
    ...glassSurface,
    position: "absolute",
    width: PANEL_W,
    borderRadius: 18,
    padding: 6,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    transition: `opacity 0.22s ${EASE}, transform 0.22s ${EASE}`,
  };
  // Only the open panel is visible — keep it mounted so it stays put while the
  // pointer travels from its chip onto it (leaving sets openPanel back to null).
  const panelVis = (key: "mode" | "language" | "cleanup", origin: string): CSSProperties => {
    const on = openPanel === key;
    return {
      opacity: on ? 1 : 0,
      transform: on ? "scale(1)" : "scale(0.72)",
      transformOrigin: origin,
      pointerEvents: on ? "auto" : "none",
    };
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Orb square between the gutters. Returning here folds the panels back. */}
      <div
        ref={boxRef}
        onMouseEnter={() => setOpenPanel(null)}
        style={{
          position: "absolute",
          left: GUTTER_X,
          right: GUTTER_X,
          top: GUTTER_TOP,
          bottom: GUTTER_BOTTOM,
        }}
      >
        <canvas
          ref={canvasRef}
          data-tauri-drag-region
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />
      </div>

      {quick && (
        <>
          {/* ---- Collapsed chips: icon-only, floating clear of the orb.
               Hovering ANY of them blooms all three option panels. ---- */}
          {/* W — transcription mode */}
          <button
            className="orb-chip"
            title={t("overlay.tooltipMode", { value: quick.mode })}
            onMouseEnter={() => setOpenPanel("mode")}
            style={{
              ...chipBase,
              ...chipVis(hover && openPanel !== "mode"),
              left: GUTTER_X - GAP - CHIP,
              top: orbMidY,
              marginTop: -CHIP / 2,
              color: MODE_COLOR[quick.mode] ?? "#cfe0f2",
            }}
          >
            <StrokeIcon
              paths={quick.mode === "local" ? SHIELD_CHECK_PATHS : CLOUD_PATHS}
              size={17}
              strokeWidth={1.9}
            />
          </button>
          {/* N — language */}
          <button
            className="orb-chip"
            title={t("overlay.tooltipLanguage", { value: quick.language })}
            onMouseEnter={() => setOpenPanel("language")}
            style={{
              ...chipBase,
              ...chipVis(hover && openPanel !== "language"),
              left: `calc(50% - ${CHIP / 2}px)`,
              top: GUTTER_TOP - GAP - CHIP,
            }}
          >
            <StrokeIcon paths={GLOBE_PATHS} size={17} strokeWidth={1.9} />
          </button>
          {/* E — cleanup style */}
          <button
            className="orb-chip"
            title={t("overlay.tooltipCleanup", { value: quick.cleanup })}
            onMouseEnter={() => setOpenPanel("cleanup")}
            style={{
              ...chipBase,
              ...chipVis(hover && openPanel !== "cleanup"),
              left: `calc(100% - ${GUTTER_X - GAP}px)`,
              top: orbMidY,
              marginTop: -CHIP / 2,
              color: quick.cleanup === "off" ? "#7d8da3" : "#22d3ee",
            }}
          >
            <StrokeIcon paths={SPARKLES_PATHS} size={17} strokeWidth={1.9} />
          </button>

          {/* ---- Expanded island: ONLY the hovered chip's panel blooms ---- */}
          {/* Mode — left of the orb */}
          <div
            onMouseEnter={() => setOpenPanel("mode")}
            style={{
              ...panelBase,
              ...panelVis("mode", "right center"),
              left: 0,
              top: orbMidY,
              translate: "0 -50%",
            }}
          >
            <Row
              icon={SHIELD_CHECK_PATHS}
              label={t("mode.localTitle")}
              active={quick.mode === "local"}
              onClick={pick("mode", "local")}
            />
            <Row
              icon={CLOUD_PATHS}
              label={t("mode.cloudTitle")}
              active={quick.mode === "cloud"}
              onClick={pick("mode", "cloud")}
            />
          </div>
          {/* Language — above the orb */}
          <div
            onMouseEnter={() => setOpenPanel("language")}
            style={{
              ...panelBase,
              ...panelVis("language", "center bottom"),
              left: `calc(50% - ${PANEL_W / 2}px)`,
              bottom: `calc(100% - ${GUTTER_TOP - GAP}px)`,
            }}
          >
            <Row
              icon={GLOBE_PATHS}
              label="Deutsch"
              active={quick.language === "de"}
              onClick={pick("language", "de")}
            />
            <Row
              icon={GLOBE_PATHS}
              label="English"
              active={quick.language === "en"}
              onClick={pick("language", "en")}
            />
            <Row
              icon={GLOBE_PATHS}
              label={t("overlay.langAuto")}
              active={quick.language === "auto"}
              onClick={pick("language", "auto")}
            />
          </div>
          {/* Cleanup — right of the orb */}
          <div
            onMouseEnter={() => setOpenPanel("cleanup")}
            style={{
              ...panelBase,
              ...panelVis("cleanup", "left center"),
              left: `calc(100% - ${PANEL_W}px)`,
              top: orbMidY,
              translate: "0 -50%",
            }}
          >
            <Row
              icon={BAN_PATHS}
              label={t("common.off")}
              active={quick.cleanup === "off"}
              onClick={pick("cleanup", "off")}
            />
            {/* Auto — style follows the focused app (Auto-Mode) */}
            <Row
              icon={WAND_PATHS}
              label={t("settings.autoMode")}
              active={quick.cleanup === "auto"}
              onClick={pick("cleanup", "auto")}
            />
            <Row
              icon={TERMINAL_PATHS}
              label={t("settings.cleanupStylePrompt")}
              active={quick.cleanup === "prompt"}
              onClick={pick("cleanup", "prompt")}
            />
            <Row
              icon={MAIL_PATHS}
              label={t("settings.cleanupStyleEmail")}
              active={quick.cleanup === "email"}
              onClick={pick("cleanup", "email")}
            />
            <Row
              icon={HASH_PATHS}
              label={t("settings.cleanupStyleSlack")}
              active={quick.cleanup === "slack"}
              onClick={pick("cleanup", "slack")}
            />
            <Row
              icon={BRIEFCASE_PATHS}
              label={t("settings.cleanupStyleFormal")}
              active={quick.cleanup === "formal"}
              onClick={pick("cleanup", "formal")}
            />
          </div>
        </>
      )}

      {/* S — Prompt Console (action chip, stays a chip in both stages) */}
      <button
        className="orb-chip"
        title={t("overlay.tooltipPrompt")}
        onClick={() => {
          invoke("prompt_console_toggle").catch(() => {});
        }}
        style={{
          ...chipBase,
          ...chipVis(hover),
          left: `calc(50% - ${CHIP / 2}px)`,
          top: `calc(100% - ${GUTTER_BOTTOM - 14}px)`,
          color: "#a78bfa",
        }}
      >
        <StrokeIcon paths={STAR4_PATHS} size={16} strokeWidth={1.9} />
      </button>
    </div>
  );
}
