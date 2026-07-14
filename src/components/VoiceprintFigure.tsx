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
 * DICHTE (2026-07-14, TJ: „bei 70 % zu große Löcher, muss dichter, verschiedene
 * Farben und Dicken"):
 *  - Polar-Gitter mit ringweise HALBIERTER Sektorzahl nach innen (33/66/132) →
 *    jedes Stück ist ~5 px lang, egal auf welchem Ring; keine Innen-Blobs, kein
 *    ausgedünnter Außenrand. 24 Ringe × bis zu 132 Sektoren, ~1750 Teile.
 *  - Zwischen den Obertonreihen liegt ein TEXTUR-BODEN (schwache, dünne Bögen)
 *    statt Leere → die Rosette liest sich als Abdruck, nicht als Speichenrad.
 *  - Energie steuert Strichstärke (0,85–3,0 px), Deckkraft und Farbton → jede
 *    Quelle hat eine Farb-FAMILIE (5 Stufen, zum Nachbarakzent gemischt) statt
 *    einer flachen Farbe.
 *  - Füll-Reihenfolge innerhalb einer Quelle ist BLAU-RAUSCH-artig gestreut
 *    (Van-der-Corput) statt sektor-kohärent → bei 70 % fehlen viele winzige
 *    Stücke gleichmäßig verteilt, nicht ein paar große Keile.
 *
 * Puzzle: Semantik unverändert seit v0.5.125 — jeder Bogen ist ein Teil, die
 * Teile gehören sektor-kohärent zu den DREI Quellen (45 % Kern · 30 % Meeting ·
 * 25 % Diktat, Server-Formel) und jede Quelle füllt nach ihrem EIGENEN
 * Fortschritt → gefüllte Teile / alle Teile == `completeness`.
 *
 * `seed` (Account-Key) macht die Rosette PRO PERSON einzigartig. Deterministisch
 * bleibt sie: kein Math.random, dasselbe Konto zeigt immer dieselbe Rosette.
 */

type Progress = { core: number; far: number; near: number };

type Piece = {
  d: string;
  /** Voll-Auflösungs-Sektor (Zeit) — trägt die kohärente Quellen-Zuordnung. */
  ri: number;
  /** Zonen-Feld 0..1, GLATT über den Winkel → die Quellen bilden zusammenhängende
   *  Farbregionen statt Konfetti (die Legende muss ablesbar bleiben). */
  zk: number;
  /** Ring (Frequenz) — nur für die räumliche Streuung der Füll-Reihenfolge. */
  g: number;
  /** Strichstärke in px (Energie). */
  w: number;
  /** Deckkraft 0..1 (Energie). */
  o: number;
  /** Stufe in der Farb-Familie der Quelle (0 = pur, 4 = am stärksten getönt). */
  tone: number;
};
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

/** Radikal-Inverse zur Basis 2 — streut eine Folge gleichmäßig über [0,1). */
function vdc(i: number): number {
  let n = i >>> 0;
  n = ((n >>> 1) & 0x55555555) | ((n & 0x55555555) << 1);
  n = ((n >>> 2) & 0x33333333) | ((n & 0x33333333) << 2);
  n = ((n >>> 4) & 0x0f0f0f0f) | ((n & 0x0f0f0f0f) << 4);
  n = ((n >>> 8) & 0x00ff00ff) | ((n & 0x00ff00ff) << 8);
  n = ((n >>> 16) & 0xffff) | ((n & 0xffff) << 16);
  return (n >>> 0) / 4294967296;
}

/** Stimm-Charakter aus dem Seed: Formant-Hüllkurve + Phasen (= Stimmenfarbe). */
function makeVoice(seed: string) {
  const r = rng(seedOf("echo-vp:" + seed));
  const formants: { mu: number; sig: number; amp: number }[] = [];
  let pos = 0.1 + r() * 0.07;
  for (let k = 0; k < 4; k++) {
    formants.push({ mu: pos, sig: 0.05 + r() * 0.05, amp: (k === 0 ? 0.9 : 0.5) + r() * 0.5 });
    pos += 0.17 + r() * 0.13;
  }
  return {
    formants,
    ph1: r() * 6.283,
    ph2: r() * 6.283,
    ph3: r() * 6.283,
    wob: 0.6 + r() * 0.9,
    // Phasen des Zonen-Felds (welche Quelle wo liegt) + der Ridge-Verformung
    zp1: r() * 6.283,
    zp2: r() * 6.283,
    wp1: r() * 6.283,
    wp2: r() * 6.283,
  };
}

const S = 132; // Sektoren (Zeit) auf dem äußersten Ring
const RINGS = 24; // Frequenz-Bänder
// KEIN Ausdünnen mehr: JEDE Zelle bekommt ein Stück (~2180). Die Struktur trägt
// allein Dicke/Deckkraft/Farbton — sonst reißt das Top-N-Ranking die leisen
// Sektoren (Pausen) komplett raus und es entstehen genau die Keil-Löcher, die
// TJ gestört haben. Ein Abdruck ist flächendeckend; er ist nur unterschiedlich
// stark eingefärbt.

/** Sektoren dieses Rings: nach innen halbiert, damit jedes Stück ~gleich lang ist. */
function sectorsAt(g: number): number {
  if (g < 6) return S / 4;
  if (g < 12) return S / 2;
  return S;
}

function buildRosette(size: number, seed: string): Piece[] {
  const v = makeVoice(seed);
  const fenv = (x: number) => {
    let e = 0;
    for (const f of v.formants)
      e += f.amp * Math.exp(-((x - f.mu) * (x - f.mu)) / (2 * f.sig * f.sig));
    return e;
  };
  const cx = size / 2;
  const cy = size / 2;
  const r0 = size * 0.105;
  const r1 = size * 0.475;
  const band = (r1 - r0) / RINGS;

  type Cell = { th: number; g: number; ri: number; zk: number; inten: number };
  // Glattes Zonen-Feld über den Winkel: benachbarte Momente gehören meist zur
  // selben Quelle → große, ablesbare Farbregionen (statt Sprenkel).
  const zone = (th: number) =>
    clamp(
      0.5 + 0.34 * Math.sin(th + v.zp1) + 0.18 * Math.sin(2.6 * th + v.zp2) + 0.06 * Math.sin(5.3 * th),
      0,
      1,
    );
  const cand: Cell[] = [];
  for (let g = 0; g < RINGS; g++) {
    const Sg = sectorsAt(g);
    for (let s = 0; s < Sg; s++) {
      const th = (s / Sg) * Math.PI * 2;
      // Zeit läuft über den WINKEL (nicht den Sektor-Index) → Obertonbänder
      // bleiben über alle Ring-Auflösungen hinweg radial ausgerichtet.
      const tt = (th / (Math.PI * 2)) * S;
      // Phrasen + Pausen: die Stimme ist nicht immer an. Der Boden (0.32) hält
      // auch die Pausen als feine Textur sichtbar — sonst klaffen Keile.
      let act = 0.72 + 0.4 * Math.sin(tt * 0.3 + v.ph1) + 0.26 * Math.sin(tt * 0.11 * v.wob + v.ph2);
      act = clamp(act, 0.32, 1);
      // Grundton wandert langsam → Obertonreihen werden konzentrische Bänder
      const f0 = 1.15 + 0.55 * Math.sin(tt * 0.15 + v.ph3) + 0.25 * Math.sin(tt * 0.06 * v.wob + v.ph1);
      let harm = 0;
      for (let k = 1; k <= 18; k++) {
        const d = g - k * f0;
        harm = Math.max(harm, Math.exp(-(d * d) / (2 * 0.6 * 0.6)) * (1 - 0.028 * k));
      }
      // Textur-Boden zwischen den Reihen: leise, aber da (Abdruck statt Speichen).
      const floor = 0.22 + 0.1 * h1(g * 5.3 + tt * 1.7 + 11.1);
      const e = Math.max(harm, floor);
      const inten = clamp(
        act * e * (0.55 + 0.65 * fenv(g / RINGS)) * (0.86 + 0.28 * h1(tt * 7.7 + g * 3.1)),
        0,
        1,
      );
      cand.push({ th, g, ri: Math.round((th / (Math.PI * 2)) * S) % S, zk: zone(th), inten });
    }
  }

  return cand.map((c) => {
    const Sg = sectorsAt(c.g);
    // Ridge-Verformung: die Ringe laufen leicht wellig (Abdruck, kein Vinyl) —
    // reine Ästhetik, die radiale Ordnung (Frequenz) bleibt erhalten.
    const warp =
      0.45 * Math.sin(2 * c.th + v.wp1) +
      0.26 * Math.sin(3.4 * c.th + v.wp2) +
      0.2 * (h1(c.g * 9.1 + c.th * 4.4) - 0.5);
    const rr = r0 + (c.g + 0.5 + warp) * band;
    // Kräftige Stücke überlappen minimal → Bögen verschmelzen zu Ridge-Linien.
    const half = (Math.PI / Sg) * (0.92 + 0.5 * c.inten);
    const a0 = c.th - half;
    const a1 = c.th + half;
    const p0x = cx + rr * Math.cos(a0);
    const p0y = cy + rr * Math.sin(a0);
    const p1x = cx + rr * Math.cos(a1);
    const p1y = cy + rr * Math.sin(a1);
    // Energie → Dicke · Deckkraft · Farbstufe. Hohe Ringe (Höhen) und starke
    // Energie tönen zum Nachbarakzent → jede Quelle wird eine Farb-Familie.
    const w = 0.75 + 2.35 * Math.pow(c.inten, 0.9);
    const o = 0.3 + 0.7 * c.inten;
    const tone = clamp(
      Math.floor(
        ((c.g / RINGS) * 0.62 + 0.3 * c.inten + 0.16 * (h1(c.th * 3.3 + c.g * 1.9) - 0.5)) * 5,
      ),
      0,
      4,
    );
    return {
      d:
        "M " + p0x.toFixed(1) + " " + p0y.toFixed(1) +
        " A " + rr.toFixed(1) + " " + rr.toFixed(1) + " 0 0 1 " +
        p1x.toFixed(1) + " " + p1y.toFixed(1),
      ri: c.ri,
      zk: c.zk,
      g: c.g,
      w: Number(w.toFixed(2)),
      o: Number(o.toFixed(2)),
      tone,
    };
  });
}

function place(pieces: Piece[], p: Progress): Placed[] {
  // 1) Quellen-Zuordnung über das glatte Zonen-Feld → jede Quelle bekommt eine
  //    zusammenhängende Region (Ränder leicht ausgefranst, kein Tortenstück).
  const order = pieces
    .map((pc, i) => ({ i, k: 0.86 * pc.zk + 0.14 * h1(i * 12.9898 + 78.233) }))
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
    // 2) Füllen aber GESTREUT: räumlich sortieren (Ring, dann Winkel), dann per
    //    Van-der-Corput permutieren → die ersten x % liegen gleichmäßig über die
    //    ganze Fläche der Quelle verteilt. Sonst fehlt bei 70 % ein ganzer Keil.
    const spatial = grp.items
      .map((it) => ({ it, key: pieces[it.i].g * 1000 + pieces[it.i].ri }))
      .sort((a, b) => a.key - b.key)
      .map((x, idx) => ({ it: x.it, k: vdc(idx + 1) }))
      .sort((a, b) => a.k - b.k);
    const fill = Math.round(spatial.length * clamp(grp.prog, 0, 1));
    spatial.forEach((x, idx) => {
      out[x.it.i].group = grp.g;
      if (idx < fill) {
        out[x.it.i].on = true;
        out[x.it.i].order = step++;
      }
    });
  }
  return out;
}

/**
 * Farb-Familien: Basis der Quelle, in 5 Stufen zum Nachbarakzent getönt. Alle
 * Töne kommen aus den Theme-Tokens (--cyan/--violet/--emerald) → das `black`-
 * Theme (Zero-Hue-Regel) grauträgt sie automatisch mit.
 */
const RAMP: Record<Placed["group"], string[]> = {
  core: [
    "var(--cyan)",
    "color-mix(in srgb, var(--cyan) 88%, var(--emerald))",
    "color-mix(in srgb, var(--cyan) 84%, var(--violet))",
    "color-mix(in srgb, var(--cyan) 72%, var(--violet))",
    "color-mix(in srgb, var(--cyan) 62%, var(--violet))",
  ],
  far: [
    "var(--violet)",
    "color-mix(in srgb, var(--violet) 88%, var(--cyan))",
    "color-mix(in srgb, var(--violet) 76%, var(--cyan))",
    "color-mix(in srgb, var(--violet) 68%, var(--cyan))",
    "color-mix(in srgb, var(--violet) 78%, var(--emerald))",
  ],
  near: [
    "var(--emerald)",
    "color-mix(in srgb, var(--emerald) 88%, var(--cyan))",
    "color-mix(in srgb, var(--emerald) 76%, var(--cyan))",
    "color-mix(in srgb, var(--emerald) 68%, var(--cyan))",
    "color-mix(in srgb, var(--emerald) 76%, var(--violet))",
  ],
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
      style={{ ["--vp-live" as string]: String(clamp(live, 0, 1)) }}
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
              stroke={RAMP[p.group][p.tone]}
              style={{
                ["--vp-w" as string]: `${p.w}px`,
                ["--vp-o" as string]: String(p.o),
                animationDelay: `${Math.min(p.order * 1.4, 1500)}ms`,
              }}
            />
          ) : (
            <path
              key={`off-${i}`}
              className="vp-fp-off"
              d={p.d}
              style={{ ["--vp-w" as string]: `${p.w}px` }}
            />
          ),
        )}
      </svg>
    </div>
  );
}
