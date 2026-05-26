import { useEffect, useRef } from "react";
import doneWav from "../assets/sounds/done.wav";
import startWav from "../assets/sounds/start.wav";
import { onState, type EngineState } from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";

/** Subtle UI sounds: a ping on record-start, a pop on done. Renders nothing. */
export function SoundFx() {
  const { config } = useConfig();
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const last = useRef<EngineState>("idle");

  useEffect(() => {
    const play = (url: string) => {
      const c = cfgRef.current;
      if (!c?.sound_enabled) return;
      const a = new Audio(url);
      a.volume = Math.min(1, Math.max(0, c.sound_volume ?? 0.6));
      a.play().catch(() => {});
    };
    const un = onState((p) => {
      if (p.state === "recording" && last.current !== "recording") play(startWav);
      else if (p.state === "done" && last.current !== "done") play(doneWav);
      last.current = p.state;
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  return null;
}
