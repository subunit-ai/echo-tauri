import { useMemo } from "react";

/**
 * Der Stimmabdruck als echter FINGERABDRUCK, der sich wie ein Puzzle zusammensetzt
 * (TJ 2026-07-10 — ein gleichmäßiger Ring log: er suggeriert uniformes Wachstum,
 * dabei steuern DREI unabhängige Quellen Stücke bei).
 *
 * Muster: Sherlock-Monro-Orientierungsfeld einer Loop-Singularität —
 *   θ(z) = ½·(arg(z − delta) − arg(z − core))
 * Die Ridges sind Streamlines dieses Felds, gleichmäßig verteilt getract (nur säen,
 * wo noch kein Ridge in d_sep-Nähe liegt). Kern-Schleife und Delta entstehen dadurch
 * von selbst — kein Zielscheiben-Ring.
 *
 * Puzzle: Jede Ridge zerfällt in Fragmente. Die Fragmente werden ridge-kohärent
 * verstreut (Stücke derselben Linie gehören meist zur selben Quelle — sonst wirkt
 * es wie Konfetti) und nach dem SERVER-Gewicht auf die Quellen verteilt:
 *   45 % Kern (geführtes Enrollment) · 30 % Meeting-Anker · 25 % Diktat-Anker.
 * Jede Quelle füllt ihre Stücke nach ihrem EIGENEN Fortschritt → gefüllte Stücke /
 * alle Stücke entspricht exakt der `completeness` vom Server. Man sieht also nicht
 * nur WIE VOLL das Profil ist, sondern WOHER jedes Stück kam.
 */

type Progress = { core: number; far: number; near: number };

type Piece = { d: string; ri: number };
type Placed = Piece & { on: boolean; group: "core" | "far" | "near"; order: number };

/** Deterministisch — der Abdruck einer Person darf sich nie zufällig ändern. */
function h1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
function fbm2(x: number, y: number): number {
  return (
    Math.sin(x * 0.055 + 1.3) * Math.cos(y * 0.048 - 0.7) * 0.55 +
    Math.sin(x * 0.021 - 2.1) * 0.3 +
    Math.cos(y * 0.031 + 0.4) * 0.25
  );
}

function buildFingerprint(size: number): Piece[] {
  const R = size * 0.46;
  const cx = size / 2;
  const cy = size * 0.5;
  const core: [number, number] = [cx + R * 0.02, cy - R * 0.22];
  const delta: [number, number] = [cx - R * 0.34, cy + R * 0.46];
  const D_SEP = size * 0.0295;
  const D_TEST = D_SEP * 0.62;
  const STEP = size * 0.008;

  // Fingerkuppe: Superellipse, unten etwas breiter — bewusst kein Kreis
  const inMask = (x: number, y: number) => {
    const u = (x - cx) / (R * 0.86);
    const v = (y - cy) / (R * 1.02);
    const vv = v > 0 ? v * 0.94 : v * 1.03;
    return Math.pow(Math.abs(u), 2.3) + Math.pow(Math.abs(vv), 2.0) < 1;
  };
  const theta = (x: number, y: number) =>
    0.5 * (Math.atan2(y - delta[1], x - delta[0]) - Math.atan2(y - core[1], x - core[0])) +
    0.1 * fbm2(x - cx, y - cy);

  // Belegungsraster für den Ridge-Abstand
  const cs = D_TEST;
  const gw = Math.ceil(size / cs) + 2;
  const grid = new Map<number, [number, number][]>();
  const key = (gx: number, gy: number) => gy * gw + gx;
  const put = (x: number, y: number) => {
    const k = key(Math.floor(x / cs) + 1, Math.floor(y / cs) + 1);
    const arr = grid.get(k);
    if (arr) arr.push([x, y]);
    else grid.set(k, [[x, y]]);
  };
  const tooClose = (x: number, y: number, d: number) => {
    const gx = Math.floor(x / cs) + 1;
    const gy = Math.floor(y / cs) + 1;
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++) {
        const arr = grid.get(key(gx + a, gy + b));
        if (!arr) continue;
        for (const [px, py] of arr) {
          const dx = px - x;
          const dy = py - y;
          if (dx * dx + dy * dy < d * d) return true;
        }
      }
    return false;
  };

  const trace = (sx: number, sy: number): [number, number][] => {
    const fwd: [number, number][] = [];
    const bwd: [number, number][] = [];
    for (const dir of [1, -1]) {
      let x = sx;
      let y = sy;
      let lastX = 0;
      let lastY = 0;
      const out = dir === 1 ? fwd : bwd;
      for (let i = 0; i < 900; i++) {
        const t = theta(x, y);
        // Richtungsfeld (kein Vektorfeld): Vorzeichen am vorigen Schritt ausrichten
        let vx = Math.cos(t) * dir;
        let vy = Math.sin(t) * dir;
        if (i > 0 && vx * lastX + vy * lastY < 0) {
          vx = -vx;
          vy = -vy;
        }
        const t2 = theta(x + vx * STEP * 0.5, y + vy * STEP * 0.5); // RK2
        let wx = Math.cos(t2);
        let wy = Math.sin(t2);
        if (wx * vx + wy * vy < 0) {
          wx = -wx;
          wy = -wy;
        }
        x += wx * STEP;
        y += wy * STEP;
        lastX = wx;
        lastY = wy;
        if (!inMask(x, y)) break;
        if (tooClose(x, y, D_TEST * (i < 4 ? 0.25 : 1))) break;
        out.push([x, y]);
      }
    }
    return bwd.reverse().concat([[sx, sy]], fwd);
  };

  // Von innen nach außen säen → die Loop-Struktur um den Kern bleibt sauber
  const seeds: [number, number][] = [];
  const N = 46;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const x = ((i + 0.5) / N) * size;
      const y = ((j + 0.5) / N) * size;
      if (inMask(x, y)) seeds.push([x, y]);
    }
  seeds.sort(
    (a, b) =>
      Math.hypot(a[0] - core[0], a[1] - core[1]) - Math.hypot(b[0] - core[0], b[1] - core[1]),
  );

  const ridges: [number, number][][] = [];
  for (const [sx, sy] of seeds) {
    if (tooClose(sx, sy, D_SEP)) continue;
    const line = trace(sx, sy);
    if (line.length < 8) continue;
    for (const [x, y] of line) put(x, y);
    ridges.push(line);
  }

  // Ridges in Fragmente brechen — variable Länge (Puzzleteile, keine Dashes)
  const pieces: Piece[] = [];
  ridges.forEach((line, ri) => {
    let i = 0;
    let k = 0;
    while (i < line.length - 3) {
      const len = Math.round(7 + h1(ri * 9.7 + k * 3.3) * 16);
      const seg = line.slice(i, Math.min(line.length, i + len));
      if (seg.length >= 4) {
        pieces.push({
          d: "M " + seg.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L "),
          ri,
        });
      }
      i += seg.length + 2 + Math.round(h1(ri * 4.1 + k * 8.9) * 3);
      k++;
    }
  });
  return pieces;
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
}: {
  progress: Progress;
  size?: number;
  /** Mikrofon-Pegel 0..1 — lässt die gesetzten Stücke während der Aufnahme atmen. */
  live?: number;
  recording?: boolean;
}) {
  // Das Tracen ist der teure Teil und hängt NUR an der Größe → einmal pro Größe.
  const geom = useMemo(() => buildFingerprint(size), [size]);
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
            // key trägt den Zustand: ein Stück, das NEU dazukommt, wird neu gemountet
            // und zeichnet sich dadurch sichtbar ein (das Puzzle setzt sich zusammen).
            <path
              key={`on-${i}`}
              className="vp-fp-on"
              d={p.d}
              pathLength={1}
              stroke={COLOR[p.group]}
              style={{ animationDelay: `${Math.min(p.order * 6, 1400)}ms` }}
            />
          ) : (
            <path key={`off-${i}`} className="vp-fp-off" d={p.d} />
          ),
        )}
      </svg>
    </div>
  );
}
