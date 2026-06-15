import { useEffect, useRef } from "react";
import { onState, type EngineState } from "../lib/ipc";
import { playSound, preloadSounds } from "../lib/sounds";
import { useConfig } from "../state/ConfigContext";

/** Subtle UI sounds: an activation cue on record-start, a paste cue on done.
 *  Each is independently toggleable and its tone is user-selectable. Renders nothing. */
export function SoundFx() {
  const { config } = useConfig();
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const last = useRef<EngineState>("idle");

  useEffect(() => {
    // Decode the cues + warm the AudioContext up front so the very first
    // record-start sound is instant (no fetch/decode/resume on the hot path).
    preloadSounds();
    const un = onState((p) => {
      const c = cfgRef.current;
      const vol = c?.sound_volume ?? 0.6;
      if (p.state === "recording" && last.current !== "recording") {
        const id = c?.sound_start_id || "standard";
        // The "standard" record-start cue is played NATIVELY by Rust (instant even
        // when the main window is hidden to the tray — WebKit suspends a hidden
        // page's AudioContext, which delayed this). Here we only play the synth
        // presets for record-start; the paste cue still plays from the webview.
        if (c?.sound_start_enabled && id !== "standard") playSound(id, "start", vol);
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
