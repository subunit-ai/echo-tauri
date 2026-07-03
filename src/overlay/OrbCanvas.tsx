import { useEffect, useRef } from "react";
import type { EngineState } from "../lib/ipc";
import { drawOrb, newOrbAnim, type OrbVisual } from "./orbRender";

// A self-contained, presentational orb that renders the SAME way the floating
// overlay does (shared `drawOrb`). Used by the in-app Orb configurator for a big
// live preview: change a colour / style / speed in Settings and this updates
// instantly. It never touches the engine or the real overlay window.
//
// `state` chooses which look to show (idle / recording / transcribing / done /
// error). When `demo` is on, the component drives a lifelike "speaking" envelope
// internally (no microphone needed) so the voice reaction is visible right here.

interface Props {
  visual: OrbVisual;
  /** Which engine state to render. Ignored while `demo` runs (it cycles states). */
  state?: EngineState;
  /** Run a built-in voice/state demo so the preview reacts like a live session. */
  demo?: boolean;
  /** Called whenever the demo's current state changes — lets the parent light up
   *  a state legend (idle / active / done / error) in sync with the playback. */
  onPhase?: (s: EngineState) => void;
  /** Logical pixel size of the square canvas. */
  size?: number;
  className?: string;
}

export function OrbCanvas({ visual, state = "idle", demo = false, onPhase, size = 220, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Live values the RAF loop reads — synced from props so changing config never
  // restarts the animation (keeps in-flight rings/blips, no flicker).
  const visualRef = useRef(visual);
  const stateRef = useRef<EngineState>(state);
  const demoRef = useRef(demo);
  const levelRef = useRef(0);
  const onPhaseRef = useRef(onPhase);
  visualRef.current = visual;
  onPhaseRef.current = onPhase;
  // While demoing we own the state; otherwise it follows the prop.
  if (!demo) stateRef.current = state;
  demoRef.current = demo;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const px = Math.floor(size * dpr);
    canvas.width = px;
    canvas.height = px;

    const anim = newOrbAnim();
    let raf = 0;
    // Demo state machine: idle → recording (a few seconds of synthetic speech)
    // → done → back to idle. `tick` counts frames; cadence is generous so the
    // user can actually watch each state. Synthetic mic level is a couple of
    // layered sines plus a slow envelope, shaped to feel like real speech.
    let tick = 0;
    let phase: EngineState = "idle";
    let lastPhase: EngineState | null = null;

    // Synthetic syllable-like voice envelope: bursts of energy with brief
    // gaps; jump up fast, ease down — mirrors the overlay's VU smoothing.
    const speak = () => {
      const f = tick * 0.13;
      const syllable = Math.max(0, Math.sin(f) * 0.5 + 0.5);
      const flutter = 0.5 + 0.5 * Math.sin(f * 3.7);
      const gap = Math.sin(tick * 0.045) > -0.3 ? 1 : 0.15; // occasional pauses
      const target = Math.min(1, syllable * flutter * gap * 1.1);
      levelRef.current = target > levelRef.current ? target : levelRef.current * 0.8 + target * 0.2;
    };

    const loop = () => {
      tick += 1;
      if (demoRef.current) {
        // Cycle through EVERY state so each legend entry lights up in turn,
        // incl. a brief error flash: idle → recording → transcribing → done →
        // error → idle.
        const cycle = tick % 560;
        if (cycle < 70) phase = "idle";
        else if (cycle < 310) phase = "recording";
        else if (cycle < 360) phase = "transcribing";
        else if (cycle < 420) phase = "done";
        else if (cycle < 480) phase = "error";
        else phase = "idle";
        stateRef.current = phase;
        if (phase !== lastPhase) {
          lastPhase = phase;
          onPhaseRef.current?.(phase);
        }
        if (phase === "recording") speak();
        else levelRef.current *= 0.85;
      } else if (stateRef.current === "recording") {
        // Pinned "Aktiv" (demo stopped via the legend): keep the synthetic
        // voice talking — the preview must never sit dead (TJ).
        speak();
      } else {
        levelRef.current *= 0.85;
      }
      drawOrb(ctx, canvas.width, canvas.height, visualRef.current, stateRef.current, levelRef.current, anim);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size, display: "block" }}
    />
  );
}
