import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { onState, type EngineState } from "../lib/ipc";

// Compact, non-interactive fallback indicator shown when the orb is off but
// "Bubble anzeigen" is on. A centered pill: a state dot + a live waveform +
// a short label. Auto-hides after done/error; invisible while idle.

const COLOR: Record<EngineState, string> = {
  idle: "#22d3ee",
  recording: "#ff5c5c",
  transcribing: "#22d3ee",
  done: "#50dc82",
  error: "#ffc450",
};

const LABEL_KEY: Record<EngineState, string> = {
  idle: "",
  recording: "overlay.recording",
  transcribing: "overlay.transcribing",
  done: "common.done",
  error: "common.error",
};

export function Bubble() {
  const { t } = useTranslation();
  const [st, setSt] = useState<EngineState>("idle");
  const [visible, setVisible] = useState(false);
  const stRef = useRef<EngineState>("idle");
  const level = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  // Animation speed multiplier (shared orb_speed setting; default calmer 0.6).
  const speed = useRef(0.6);
  // Per-state colors, shared with the orb. `working` covers recording AND
  // transcribing (the busy states), so both map to it — same as the orb.
  const colors = useRef<Record<EngineState, string>>({ ...COLOR });
  // Fold the 4 configurable orb colors into the bubble's 5-state map. Empty/missing
  // values are ignored so we keep the current value (defaults on first load).
  const applyColors = (p: { idle?: string; working?: string; done?: string; error?: string }) => {
    if (p.idle) colors.current.idle = p.idle;
    if (p.working) {
      colors.current.recording = p.working;
      colors.current.transcribing = p.working;
    }
    if (p.done) colors.current.done = p.done;
    if (p.error) colors.current.error = p.error;
  };

  // Pick up the shared overlay speed (and live updates from Settings) so the
  // bubble's idle shimmer honours the same "too fast" fix as the orb.
  useEffect(() => {
    invoke<Record<string, unknown>>("get_config")
      .then((c) => {
        if (typeof c.orb_speed === "number") speed.current = c.orb_speed as number;
        applyColors({
          idle: c.orb_color_idle as string,
          working: c.orb_color_working as string,
          done: c.orb_color_done as string,
          error: c.orb_color_error as string,
        });
      })
      .catch(() => {});
    const un = listen<{
      speed?: number;
      colorIdle?: string;
      colorWorking?: string;
      colorDone?: string;
      colorError?: string;
    }>("echo://orb-config", (e) => {
      if (typeof e.payload.speed === "number") speed.current = e.payload.speed;
      applyColors({
        idle: e.payload.colorIdle,
        working: e.payload.colorWorking,
        done: e.payload.colorDone,
        error: e.payload.colorError,
      });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

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
      t += Math.max(0.2, Math.min(2, speed.current));
      if (canvas && ctx) {
        const dpr = window.devicePixelRatio || 1;
        const w = (canvas.width = Math.floor(64 * dpr));
        const h = (canvas.height = Math.floor(28 * dpr));
        ctx.clearRect(0, 0, w, h);
        const color = colors.current[stRef.current] ?? "#22d3ee";
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
    // Centered in the ORB zone (the window is larger than the orb by the island
    // gutters — see Orb.tsx GUTTER_*), so the pill shows up where the orb would.
    <div
      style={{
        position: "absolute",
        left: 168,
        right: 168,
        top: 168,
        bottom: 64,
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
          {LABEL_KEY[st] ? t(LABEL_KEY[st]) : ""}
        </span>
      </div>
    </div>
  );
}
