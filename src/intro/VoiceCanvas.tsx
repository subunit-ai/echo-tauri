import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { useReducedMotion } from "./useReducedMotion";

// Large reactive voice meter for the intro: center-weighted rounded bars driven
// by the recorder's mic level (same VU smoothing as the overlay orb — instant
// attack, gentle decay). While inactive the bars rest as small dots.

const BARS = 28;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function VoiceCanvas({
  active,
  height = 160,
  onLevel,
}: {
  active: boolean;
  height?: number;
  /** Smoothed level per poll — lets the mic scene detect "no signal". */
  onLevel?: (lvl: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const level = useRef(0);
  const activeRef = useRef(active);
  const reduced = useReducedMotion();
  activeRef.current = active;

  // Poll the mic level only while a recording runs; decay back to rest otherwise.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(async () => {
      try {
        const raw = await invoke<number>("mic_level");
        // VU: jump up instantly, release smoothly (matches Orb.tsx).
        level.current = raw > level.current ? raw : level.current * 0.82 + raw * 0.18;
        onLevel?.(level.current);
      } catch {
        /* recorder not running yet — keep the last value decaying */
      }
    }, 80);
    return () => window.clearInterval(id);
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cyan = cssVar("--cyan", "#22d3ee");

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    let phase = 0;
    const draw = () => {
      const w = canvas.clientWidth;
      const h = height;
      ctx.clearRect(0, 0, w, h);
      if (!activeRef.current) level.current *= 0.85;
      const lvl = Math.min(1, level.current);
      phase += 0.045;

      const gap = 6;
      const bw = Math.max(3, (w - gap * (BARS + 1)) / BARS);
      const mid = h / 2;
      for (let i = 0; i < BARS; i++) {
        // Center-weighted envelope so the meter blooms from the middle.
        const t = i / (BARS - 1);
        const envelope = 0.25 + 0.75 * Math.sin(Math.PI * t) ** 1.4;
        // Per-bar shimmer while speaking; pure level under reduced motion
        // (the height itself is functional feedback, the shimmer is not).
        const shimmer = reduced ? 1 : 0.82 + 0.18 * Math.sin(phase * 2.1 + i * 0.9);
        const amp = lvl * envelope * shimmer;
        const bh = Math.max(4, amp * (h - 24));
        const x = gap + i * (bw + gap);
        ctx.fillStyle = cyan;
        ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, amp * 2.2);
        const r = bw / 2;
        ctx.beginPath();
        ctx.roundRect(x, mid - bh / 2, bw, bh, r);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [height, reduced]);

  return (
    <div className="intro-voice">
      <canvas ref={canvasRef} style={{ height }} />
    </div>
  );
}
