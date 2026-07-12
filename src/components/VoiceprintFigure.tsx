import { useMemo } from "react";

/**
 * Der Stimmabdruck als SPEKTRAL-ROSETTE — das Spektrogramm der Stimme, polar
 * aufgewickelt (TJ 2026-07-12; löst den Fingerabdruck aus v0.5.125 ab, der als
 * falsche Biometrie empfunden wurde: er erzählte Haut, nicht Klang).
 *
 * Geometrie: Winkel = Zeit, Radius = Frequenz, Bögen = Obertonenergie. Ein
 * langsam wandernder Grundton legt Obertonreihen (k·f0) über die Ringe, Phrasen
 * und Pausen entstehen aus der Aktivitäts-Hüllkurve — man sieht buchstäblich
 * Sprache im Kreis laufen. Dicht wie eine Iris, streng geometrisch.
 *
 * Puzzle: unverändert zu v0.5.125 — jeder Bogen ist ein Teil, die Teile werden
 * sektor-kohärent auf die DREI Quellen verteilt (45 % Kern · 30 % Meeting ·
 * 25 % Diktat, Server-Formel) und jede Quelle füllt nach ihrem EIGENEN
 * Fortschritt → gefüllte Teile / alle Teile == `completeness`.
 *
 * NEU: `seed` (Account-Key) macht die Rosette PRO PERSON einzigartig — der
 * Fingerabdruck war für alle User identisch. Deterministisch bleibt sie: kein
 * Math.random, dasselbe Konto zeigt immer dieselbe Rosette.
 */

type Progress = { core: number; far: number; near: number };

type Piece = { d: string; ri: number };
type Placed = Piece & { on: boolean; group: "core" | "far" | "near"; order: number };

/** Deterministisch — der Abdruck einer Person darf sich nie zufällig ändern. */
function h1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
function seedOf(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Stimm-Charakter aus dem Seed: Formant-Hüllkurve + Phasen (= Stimmenfarbe). */
function makeVoice(seed: string) {
  const r = rng(seedOf("echo-vp:" + seed));
  const formants: { mu: number; sig: number; amp: number }[] = [];
  let pos = 0.1 + r() * 0.07;
  for (let k = 0; k < 4; k++) {
    formants.push({ mu: pos, sig: 0.05 + r() * 0.05, amp: (k === 0 ? 0.9 : 0.5) + r() * 0.5 });
    pos += 0.17 + r() * 0.13;
  }
  return { formants, ph1: r() * 6.283, ph2: r() * 6.283, ph3: r() * 6.283, wob: 0.6 + r() * 0.9 };
}

function buildRosette(size: number, seed: string): Piece[] {
  const v = makeVoice(seed);
  const fenv = (x: number) => {
    let e = 0;
    for (const f of v.formants)
      e += f.amp * Math.exp(-((x - f.mu) * (x - f.mu)) / (2 * f.sig * f.sig));
    return e;
  };
  const S = 96; // Sektoren (Zeit)
  const rings = 17; // Frequenz-Bänder
  const cx = size / 2;
  const cy = size / 2;
  const r0 = size * 0.105;
  const r1 = size * 0.475;

  const cand: { s: number; g: number; th: number; inten: number }[] = [];
  for (let s = 0; s < S; s++) {
    const th = (s / S) * Math.PI * 2;
    // Phrasen + Pausen: die Stimme ist nicht immer an
    let act = 0.72 + 0.4 * Math.sin(s * 0.3 + v.ph1) + 0.26 * Math.sin(s * 0.11 * v.wob + v.ph2);
    act = clamp(act, 0, 1);
    if (act < 0.15) act = 0;
    // Grundton wandert langsam → Obertonreihen werden konzentrische Bänder
    const f0 = 1.15 + 0.55 * Math.sin(s * 0.15 + v.ph3) + 0.25 * Math.sin(s * 0.06 * v.wob + v.ph1);
    for (let g = 0; g < rings; g++) {
      let harm = 0;
      for (let k = 1; k <= 13; k++) {
        const d = g - k * f0;
        harm = Math.max(harm, Math.exp(-(d * d) / (2 * 0.55 * 0.55)) * (1 - 0.035 * k));
      }
      const inten =
        act * harm * (0.55 + 0.65 * fenv(g / rings)) * (0.84 + 0.32 * h1(s * 7.7 + g * 3.1));
      if (inten > 0.09) cand.push({ s, g, th, inten: Math.min(inten, 1) });
    }
  }
  cand.sort((a, b) => b.inten - a.inten);
  const keep = cand.slice(0, 620);

  return keep.map((c) => {
    const rr = r0 + ((c.g + 0.5) * (r1 - r0)) / rings;
    const half = (Math.PI / S) * (0.65 + 0.95 * c.inten);
    const a0 = c.th - half;
    const a1 = c.th + half;
    const p0x = cx + rr * Math.cos(a0);
    const p0y = cy + rr * Math.sin(a0);
    const p1x = cx + rr * Math.cos(a1);
    const p1y = cy + rr * Math.sin(a1);
    return {
      d:
        "M " + p0x.toFixed(1) + " " + p0y.toFixed(1) +
        " A " + rr.toFixed(1) + " " + rr.toFixed(1) + " 0 0 1 " +
        p1x.toFixed(1) + " " + p1y.toFixed(1),
      // Sektor-kohärente Quellen-Zuordnung: Teile desselben Moments gehören
      // meist zur selben Quelle (sonst wirkt es wie Konfetti)
      ri: c.s,
    };
  });
}

function place(pieces: Piece[], p: Progress): Placed[] {
  const order = pieces
    .map((pc, i) => ({ i, k: 0.55 * h1(pc.ri * 3.71 + 0.5) + 0.45 * h1(i * 12.9898 + 78.233) }))
    .sort((a, b) => a.k - b.k);
  const N = order.length;
  const nCore = Math.round(N * 0.45);
  const nFar = Math.round(N * 0.3);
  const groups: { g: Placed["group"]; items: typeof order; prog: number }[] = [
    { g: "core", items: order.slice(0, nCore), prog: p.core },
    { g: "far", items: order.slice(nCore, nCore + nFar), prog: p.far },
    { g: "near", items: order.slice(nCore + nFar), prog: p.near },
  ];
  const out: Placed[] = pieces.map((pc) => ({ ...pc, on: false, group: "core", order: 0 }));
  let step = 0;
  for (const grp of groups) {
    const fill = Math.round(grp.items.length * Math.max(0, Math.min(1, grp.prog)));
    grp.items.forEach((it, idx) => {
      out[it.i].group = grp.g;
      if (idx < fill) {
        out[it.i].on = true;
        out[it.i].order = step++;
      }
    });
  }
  return out;
}

const COLOR: Record<Placed["group"], string> = {
  core: "var(--cyan)",
  far: "var(--violet)",
  near: "var(--emerald)",
};

export function VoiceprintFigure({
  progress,
  size = 224,
  live = 0,
  recording = false,
  seed = "local",
}: {
  progress: Progress;
  size?: number;
  /** Mikrofon-Pegel 0..1 — lässt die gesetzten Bögen während der Aufnahme atmen. */
  live?: number;
  recording?: boolean;
  /** Account-Key (ws:<id> | em:<mail> | local) — jede Person, eigene Rosette. */
  seed?: string;
}) {
  // Der Aufbau hängt nur an Größe + Person → einmal pro (size, seed).
  const geom = useMemo(() => buildRosette(size, seed), [size, seed]);
  const pieces = useMemo(
    () => place(geom, progress),
    [geom, progress.core, progress.far, progress.near], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div
      className={"vp-fp" + (recording ? " rec" : "")}
      style={{ ["--vp-live" as string]: String(Math.max(0, Math.min(1, live))) }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {pieces.map((p, i) =>
          p.on ? (
            // key trägt den Zustand: ein Teil, das NEU dazukommt, wird neu gemountet
            // und zeichnet sich dadurch sichtbar ein (das Puzzle setzt sich zusammen).
            <path
              key={`on-${i}`}
              className="vp-fp-on"
              d={p.d}
              pathLength={1}
              stroke={COLOR[p.group]}
              style={{ animationDelay: `${Math.min(p.order * 4, 1400)}ms` }}
            />
          ) : (
            <path key={`off-${i}`} className="vp-fp-off" d={p.d} />
          ),
        )}
      </svg>
    </div>
  );
}
