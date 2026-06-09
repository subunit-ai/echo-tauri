import { useEffect, useRef } from "react";
import { onState, type EngineState } from "../lib/ipc";
import { playSound } from "../lib/sounds";
import { useConfig } from "../state/ConfigContext";

/** Subtle UI sounds: an activation cue on record-start, a paste cue on done.
 *  Each is independently toggleable and its tone is user-selectable. Renders nothing. */
export function SoundFx() {
  const { config } = useConfig();
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const last = useRef<EngineState>("idle");

  useEffect(() => {
    const un = onState((p) => {
      const c = cfgRef.current;
      const vol = c?.sound_volume ?? 0.6;
      if (p.state === "recording" && last.current !== "recording") {
        if (c?.sound_start_enabled) playSound(c.sound_start_id || "standard", "start", vol);
      } else if (p.state === "done" && last.current !== "done") {
        if (c?.sound_paste_enabled) playSound(c.sound_paste_id || "standard", "paste", vol);
      }
      last.current = p.state;
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  return null;
}
