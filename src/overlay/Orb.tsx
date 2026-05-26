import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { onState, type EngineState } from "../lib/ipc";

const THEME: Record<string, string> = {
  cyan: "#22d3ee",
  violet: "#aa6eff",
  mint: "#6ee6be",
};
// State overrides the theme color.
const STATE_COLOR: Partial<Record<EngineState, string>> = {
  recording: "#ff5c5c",
  done: "#50dc82",
  error: "#ffc450",
};

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
export function Orb() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef<EngineState>("idle");
  const level = useRef(0);
  const style = useRef("ping");
  const color = useRef(THEME.cyan);
  const idlePulse = useRef(true);
  const autoHide = useRef(false);

  useEffect(() => {
    invoke<Record<string, unknown>>("get_config")
      .then((c) => {
        style.current = (c.orb_overlay_style as string) || "ping";
        color.current = THEME[c.orb_color_theme as string] || THEME.cyan;
        idlePulse.current = c.orb_idle_pulse !== false;
        autoHide.current = c.orb_overlay_auto_hide === true;
      })
      .catch(() => {});
    const un = onState((p) => {
      state.current = p.state;
    });
    return () => {
      un.then((f) => f());
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
    let raf = 0;
    const rings: { r: number; a: number }[] = [];

    const loop = () => {
      t += 1;
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const size = Math.min(w, h);
      const lvl = Math.min(1, level.current);
      const st = state.current;
      const base = STATE_COLOR[st] ?? color.current;
      const dotR = size * 0.1;

      ctx.clearRect(0, 0, w, h);

      // Auto-hide: render nothing while idle (canvas already cleared).
      if (autoHide.current && st === "idle") {
        raf = requestAnimationFrame(loop);
        return;
      }

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
            const bh = size * 0.5 * amp * (0.6 + 0.4 * Math.abs(Math.sin(t * 0.2 + i)));
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
          const amp = size * 0.18 * (0.15 + energy);
          ctx.lineWidth = Math.max(2, size * 0.02);
          ctx.strokeStyle = hexA(base, 0.9);
          ctx.beginPath();
          for (let x = -size * 0.4; x <= size * 0.4; x += 2) {
            const y = Math.sin(x * 0.05 + t * 0.2) * amp * Math.cos(x * 0.012);
            const px = cx + x;
            const py = cy + y;
            x === -size * 0.4 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          }
          ctx.stroke();
          break;
        }
        case "sonar": {
          for (let i = 0; i < 3; i++) {
            const phase = (t * 0.03 + i / 3) % 1;
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
          // "ping" — expanding echo rings + center dot
          const spawnEvery = st === "recording" ? Math.max(6, 22 - lvl * 16) : 40;
          if (t % Math.round(spawnEvery) === 0) {
            rings.push({ r: dotR, a: 0.55 + energy * 0.4 });
          }
          for (let i = rings.length - 1; i >= 0; i--) {
            const ring = rings[i];
            ring.r += size * 0.006 * (1 + energy);
            ring.a -= 0.008;
            if (ring.a <= 0 || ring.r > size * 0.5) {
              rings.splice(i, 1);
              continue;
            }
            ctx.strokeStyle = hexA(base, ring.a);
            ctx.lineWidth = Math.max(1.5, size * 0.012);
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

      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(poll);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} />;
}
