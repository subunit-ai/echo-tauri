// UI sound presets for the activation (record-start), release (record-stop) and
// paste (done) cues.
//
// "standard" plays the bundled wav for the event; the rest are synthesized on the
// fly via Web Audio so new options can be added here WITHOUT shipping asset files
// (TJ: "settings for later sounds you can pick"). Each preset is a short,
// unobtrusive cue. `playSound` is also used by the Settings preview button.
//
// "stop" (v0.5.89) is `start.wav` reversed (+ trimmed to content, faded) — the
// natural acoustic counterpart to the start cue TJ asked for. It only exists for
// "standard"; there's no separate preset picker or toggle for it (see sound.rs /
// SoundFx). The REAL record-stop cue is played natively (sound.rs::play_stop) so
// it's instant even with the main window hidden — the buffer here exists for
// parity with the other bundled cues (Settings preview / decode-once pattern),
// not as the primary playback path.
//
// Latency: EVERYTHING goes through one Web Audio context. The bundled wavs are
// fetched + decoded ONCE into AudioBuffers at startup (`preloadSounds`) and the
// context is created warm with `latencyHint:"interactive"`, so the record-start
// cue fires the instant the "recording" state arrives — no per-press fetch/decode
// (the old `new Audio()` path) and no first-play AudioContext resume stall.

import doneWav from "../assets/sounds/done.wav";
import sonarPingMp3 from "../assets/sounds/sonar-ping.mp3";
import startWav from "../assets/sounds/start.wav";
import stopWav from "../assets/sounds/stop.wav";

export type SoundEvent = "start" | "stop" | "paste";

/** Selectable presets (id + i18n label key). Add new entries here to grow the list. */
export const SOUND_PRESETS: { id: string; labelKey: string }[] = [
  { id: "standard", labelKey: "settings.soundStandard" },
  { id: "sonar_ping", labelKey: "settings.soundSonarPing" },
  { id: "pop", labelKey: "settings.soundPop" },
  { id: "chime", labelKey: "settings.soundChime" },
  { id: "blip", labelKey: "settings.soundBlip" },
  { id: "click", labelKey: "settings.soundClick" },
  { id: "marimba", labelKey: "settings.soundMarimba" },
];

/** File-based presets (real audio files, not synth). Decoded once like the
 *  bundled cues; decodeAudioData handles mp3 in both WebView2 and WKWebView. */
const FILE_SOUNDS: Record<string, string> = {
  sonar_ping: sonarPingMp3,
};
/** Decoded file presets, keyed by id (`undefined` = not loaded, `null` = failed). */
const fileBuffers: Record<string, AudioBuffer | null | undefined> = {};

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
    // `interactive` asks CoreAudio for the smallest output buffer — lowest
    // possible latency between `start()` and sound, which is the whole point here.
    if (!actx) actx = new AudioContext({ latencyHint: "interactive" });
    if (actx.state === "suspended") void actx.resume();
    return actx;
  } catch {
    return null;
  }
}

// Decoded bundled cues, keyed by event. `undefined` = not loaded yet, `null` =
// decode failed (fall back to HTMLAudio).
const buffers: Partial<Record<SoundEvent, AudioBuffer | null>> = {};

async function decode(url: string): Promise<AudioBuffer | null> {
  const ac = audioCtx();
  if (!ac) return null;
  try {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    return await ac.decodeAudioData(arr);
  } catch {
    return null;
  }
}

/** Warm the audio context and decode the bundled cues ahead of the first press.
 *  Idempotent + best-effort; call once at app start (see SoundFx). */
export function preloadSounds() {
  audioCtx(); // create + resume now, not on the hot path
  if (!("start" in buffers)) {
    buffers.start = null;
    void decode(startWav).then((b) => (buffers.start = b));
  }
  if (!("stop" in buffers)) {
    buffers.stop = null;
    void decode(stopWav).then((b) => (buffers.stop = b));
  }
  if (!("paste" in buffers)) {
    buffers.paste = null;
    void decode(doneWav).then((b) => (buffers.paste = b));
  }
  for (const [id, url] of Object.entries(FILE_SOUNDS)) {
    if (!(id in fileBuffers)) {
      fileBuffers[id] = null;
      void decode(url).then((b) => (fileBuffers[id] = b));
    }
  }
}

function playBuffer(buf: AudioBuffer, volume: number) {
  const ac = audioCtx();
  if (!ac) return;
  const src = ac.createBufferSource();
  const g = ac.createGain();
  g.gain.value = clamp(volume);
  src.buffer = buf;
  src.connect(g).connect(ac.destination);
  src.start();
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
    const buf = buffers[event];
    if (buf) {
      playBuffer(buf, volume);
      return;
    }
    // Not decoded yet (very first press right after launch): one-shot HTMLAudio
    // fallback so the cue still plays, and kick off the decode for next time.
    preloadSounds();
    const url = event === "start" ? startWav : event === "stop" ? stopWav : doneWav;
    try {
      const a = new Audio(url);
      a.volume = clamp(volume);
      void a.play().catch(() => {});
    } catch {
      /* ignore */
    }
    return;
  }
  if (id in FILE_SOUNDS) {
    const buf = fileBuffers[id];
    if (buf) {
      playBuffer(buf, volume);
    } else if (buf === undefined) {
      // Not requested yet → decode now and play once ready (rare; preload covers it).
      void decode(FILE_SOUNDS[id]).then((b) => {
        fileBuffers[id] = b;
        if (b) playBuffer(b, volume);
      });
    }
    return;
  }
  const notes = SYNTH[id];
  if (notes) synth(notes, volume);
}
