import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  onState,
  orbCycle,
  orbQuick,
  setOrbPosition,
  type EngineState,
  type OrbQuick,
} from "../lib/ipc";

// Per-state orb colors are user-configurable in Settings (idle / working / done).
// `working` covers both recording AND transcribing (the "busy" states). The error
// state keeps a fixed warning amber — it signals a problem and shouldn't blend into
// the chosen palette. Defaults mirror the previous hardcoded look.
const DEFAULT_IDLE = "#22d3ee";
const DEFAULT_WORKING = "#ff5c5c";
const DEFAULT_DONE = "#50dc82";
const ERROR_COLOR = "#ffc450";

function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * The floating orb. A transparent, click-through overlay window renders this.
 * It reflects the engine state (idle/recording/transcribing/done/error) and
 * reacts to the mic level, in one of six styles.
 */
const MODE_LABEL: Record<string, string> = { local: "LOK", cloud: "CLD", superfast: "FAST" };
const MODE_COLOR: Record<string, string> = {
  local: "#22d3ee",
  cloud: "#5b9dff",
  superfast: "#ff9f43",
};
const CLEANUP_LABEL: Record<string, string> = {
  off: "—",
  prompt: "PR",
  email: "@",
  slack: "#",
  formal: "FM",
};
const langLabel = (l: string) => (l === "auto" ? "AUTO" : l.toUpperCase());

export function Orb() {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef<EngineState>("idle");
  const level = useRef(0);
  const style = useRef("ping");
  const colorIdle = useRef(DEFAULT_IDLE);
  const colorWorking = useRef(DEFAULT_WORKING);
  const colorDone = useRef(DEFAULT_DONE);
  const idlePulse = useRef(true);
  const idleMode = useRef<"normal" | "dim" | "hide">("normal");
  const speed = useRef(0.6);
  const [quick, setQuick] = useState<OrbQuick | null>(null);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    invoke<Record<string, unknown>>("get_config")
      .then((c) => {
        style.current = (c.orb_overlay_style as string) || "ping";
        if (typeof c.orb_color_idle === "string" && c.orb_color_idle) colorIdle.current = c.orb_color_idle;
        if (typeof c.orb_color_working === "string" && c.orb_color_working) colorWorking.current = c.orb_color_working;
        if (typeof c.orb_color_done === "string" && c.orb_color_done) colorDone.current = c.orb_color_done;
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
      idlePulse.current = p.idlePulse !== false;
      if (p.idleMode) idleMode.current = p.idleMode;
      if (typeof p.speed === "number") speed.current = p.speed;
      if (p.quick) setQuick(p.quick);
    });
    return () => {
      un.then((f) => f());
      unCfg.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    // Mic level: poll while recording, decay otherwise.
    const poll = window.setInterval(async () => {
      if (state.current === "recording") {
        try {
          level.current = await invoke<number>("mic_level");
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
      // · error → fixed warning amber.
      const base =
        st === "recording" || st === "transcribing"
          ? colorWorking.current
          : st === "done"
            ? colorDone.current
            : st === "error"
              ? ERROR_COLOR
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
      const energy = st === "recording" ? 0.25 + lvl * 0.75 : breathe * 0.6;

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
            const amp = energy * (1 - k * 0.18) + 0.08;
            // At rest with idle animation OFF, render a flat row of short, equal
            // bars (an equaliser at silence) rather than freezing mid-animation in
            // whatever jagged formation it happened to be in.
            const bh = idleStill
              ? size * 0.11
              : size * 0.5 * amp * (0.6 + 0.4 * Math.abs(Math.sin(ph * 0.2 + i)));
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
          // Flat, calm line at rest (idle animation off) instead of a frozen wave.
          const amp = idleStill ? size * 0.015 : size * 0.18 * (0.15 + energy);
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
  // data-tauri-drag-region, so dragging it moves this window). Debounced so we
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
          await setOrbPosition(pos.x / sf, pos.y / sf);
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

  const cycle = (which: "mode" | "language" | "cleanup") => (e: ReactMouseEvent) => {
    e.stopPropagation();
    orbCycle(which).then(setQuick).catch(() => {});
  };

  const satBase: CSSProperties = {
    position: "absolute",
    minWidth: 26,
    height: 22,
    padding: "0 6px",
    border: "1px solid rgba(34,211,238,0.45)",
    borderRadius: 999,
    background: "rgba(8,16,30,0.92)",
    color: "#cfeefb",
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: "0.02em",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    userSelect: "none",
    opacity: hover ? 1 : 0,
    transition: "opacity 0.18s ease",
    pointerEvents: hover ? "auto" : "none",
    boxShadow: "0 4px 12px -4px rgba(0,0,0,0.5)",
  };

  return (
    <div
      style={{ position: "relative", width: "100%", height: "100%" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <canvas
        ref={canvasRef}
        data-tauri-drag-region
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />
      {quick && (
        <>
          {/* W — transcription mode */}
          <button
            title={t("overlay.tooltipMode", { value: quick.mode })}
            onClick={cycle("mode")}
            style={{
              ...satBase,
              left: 0,
              top: "50%",
              transform: "translateY(-50%)",
              color: MODE_COLOR[quick.mode] ?? "#cfeefb",
              borderColor: `${MODE_COLOR[quick.mode] ?? "#22d3ee"}88`,
            }}
          >
            {MODE_LABEL[quick.mode] ?? quick.mode}
          </button>
          {/* N — language */}
          <button
            title={t("overlay.tooltipLanguage", { value: quick.language })}
            onClick={cycle("language")}
            style={{ ...satBase, top: 0, left: "50%", transform: "translateX(-50%)" }}
          >
            {langLabel(quick.language)}
          </button>
          {/* E — cleanup style */}
          <button
            title={t("overlay.tooltipCleanup", { value: quick.cleanup })}
            onClick={cycle("cleanup")}
            style={{ ...satBase, right: 0, top: "50%", transform: "translateY(-50%)" }}
          >
            {CLEANUP_LABEL[quick.cleanup] ?? quick.cleanup.slice(0, 2).toUpperCase()}
          </button>
        </>
      )}
    </div>
  );
}
