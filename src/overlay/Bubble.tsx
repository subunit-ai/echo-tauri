import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { onState, type EngineState } from "../lib/ipc";

// Compact, non-interactive fallback indicator shown when the orb is off but
// "Bubble anzeigen" is on. A centered pill: a state dot + a live waveform +
// a short label. Auto-hides after done/error; invisible while idle.

const LABEL: Record<EngineState, string> = {
  idle: "",
  recording: "Aufnahme",
  transcribing: "Transkribiere",
  done: "Fertig",
  error: "Fehler",
};
const COLOR: Record<EngineState, string> = {
  idle: "#22d3ee",
  recording: "#ff5c5c",
  transcribing: "#22d3ee",
  done: "#50dc82",
  error: "#ffc450",
};

export function Bubble() {
  const [st, setSt] = useState<EngineState>("idle");
  const [visible, setVisible] = useState(false);
  const stRef = useRef<EngineState>("idle");
  const level = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const un = onState((p) => {
      stRef.current = p.state;
      setSt(p.state);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (p.state === "recording" || p.state === "transcribing") {
        setVisible(true);
      } else if (p.state === "done" || p.state === "error") {
        setVisible(true);
        hideTimer.current = window.setTimeout(
          () => setVisible(false),
          p.state === "error" ? 2500 : 1800,
        );
      } else {
        setVisible(false);
      }
    });
    return () => {
      un.then((f) => f());
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);

  // Live waveform: poll mic level while recording, animate bars otherwise.
  useEffect(() => {
    const poll = window.setInterval(async () => {
      if (stRef.current === "recording") {
        try {
          level.current = await invoke<number>("mic_level");
        } catch {
          /* ignore */
        }
      } else {
        level.current *= 0.85;
      }
    }, 60);

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d") ?? null;
    let raf = 0;
    let t = 0;
    const draw = () => {
      t += 1;
      if (canvas && ctx) {
        const dpr = window.devicePixelRatio || 1;
        const w = (canvas.width = Math.floor(64 * dpr));
        const h = (canvas.height = Math.floor(28 * dpr));
        ctx.clearRect(0, 0, w, h);
        const color = COLOR[stRef.current] ?? "#22d3ee";
        const n = 5;
        const bw = w * 0.1;
        const gap = bw * 0.7;
        const total = n * bw + (n - 1) * gap;
        const lvl = Math.min(1, level.current);
        for (let i = 0; i < n; i++) {
          const k = Math.abs(i - (n - 1) / 2);
          const energy =
            stRef.current === "recording"
              ? 0.2 + lvl * (1 - k * 0.18)
              : 0.25 + 0.2 * Math.abs(Math.sin(t * 0.15 + i));
          const bh = h * 0.85 * Math.min(1, energy);
          const x = (w - total) / 2 + i * (bw + gap);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.roundRect(x, (h - bh) / 2, bw, bh, bw / 2);
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      window.clearInterval(poll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 14px 8px 10px",
          borderRadius: 999,
          background: "rgba(8,16,30,0.94)",
          border: `1px solid ${COLOR[st]}66`,
          boxShadow: "0 10px 26px -10px rgba(0,0,0,0.7)",
          opacity: visible ? 1 : 0,
          transform: visible ? "scale(1)" : "scale(0.9)",
          transition: "opacity 0.22s ease, transform 0.22s ease",
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: COLOR[st],
            boxShadow: `0 0 8px ${COLOR[st]}`,
            flex: "none",
          }}
        />
        <canvas ref={canvasRef} style={{ width: 64, height: 28, flex: "none" }} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "#dceaf7",
            whiteSpace: "nowrap",
          }}
        >
          {LABEL[st]}
        </span>
      </div>
    </div>
  );
}
