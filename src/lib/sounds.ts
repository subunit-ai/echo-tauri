// UI sound presets for the activation (record-start) and paste (done) cues.
//
// "standard" plays the bundled wav for the event; the rest are synthesized on the
// fly via Web Audio so new options can be added here WITHOUT shipping asset files
// (TJ: "settings for later sounds you can pick"). Each preset is a short,
// unobtrusive cue. `playSound` is also used by the Settings preview button.

import doneWav from "../assets/sounds/done.wav";
import startWav from "../assets/sounds/start.wav";

export type SoundEvent = "start" | "paste";

/** Selectable presets (id + i18n label key). Add new entries here to grow the list. */
export const SOUND_PRESETS: { id: string; labelKey: string }[] = [
  { id: "standard", labelKey: "settings.soundStandard" },
  { id: "pop", labelKey: "settings.soundPop" },
  { id: "chime", labelKey: "settings.soundChime" },
  { id: "blip", labelKey: "settings.soundBlip" },
  { id: "click", labelKey: "settings.soundClick" },
  { id: "marimba", labelKey: "settings.soundMarimba" },
];

type Note = { f: number; t: number; d: number; type?: OscillatorType };

// Synth recipes: a tiny envelope per note (attack 8ms → exponential decay).
const SYNTH: Record<string, Note[]> = {
  pop: [{ f: 660, t: 0, d: 0.13 }],
  chime: [
    { f: 880, t: 0, d: 0.18 },
    { f: 1320, t: 0.07, d: 0.24 },
  ],
  blip: [{ f: 920, t: 0, d: 0.08, type: "triangle" }],
  click: [{ f: 1500, t: 0, d: 0.045, type: "square" }],
  marimba: [
    { f: 523, t: 0, d: 0.22 },
    { f: 784, t: 0.005, d: 0.24 },
  ],
};

const clamp = (v: number) => Math.min(1, Math.max(0, v));

let actx: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  try {
    if (!actx) actx = new AudioContext();
    if (actx.state === "suspended") void actx.resume();
    return actx;
  } catch {
    return null;
  }
}

function synth(notes: Note[], volume: number) {
  const ac = audioCtx();
  if (!ac) return;
  const now = ac.currentTime;
  const peak = clamp(volume) * 0.5; // headroom — synth tones are loud at 1.0
  for (const n of notes) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = n.type ?? "sine";
    osc.frequency.value = n.f;
    const start = now + n.t;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(peak, start + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, start + n.d);
    osc.connect(g).connect(ac.destination);
    osc.start(start);
    osc.stop(start + n.d + 0.03);
  }
}

/** Play a sound preset for the given event at `volume` (0–1). Best-effort: any
 *  failure (autoplay policy, no AudioContext) is swallowed — sounds are non-critical. */
export function playSound(id: string, event: SoundEvent, volume: number) {
  if (id === "standard") {
    try {
      const a = new Audio(event === "start" ? startWav : doneWav);
      a.volume = clamp(volume);
      void a.play().catch(() => {});
    } catch {
      /* ignore */
    }
    return;
  }
  const notes = SYNTH[id];
  if (notes) synth(notes, volume);
}
