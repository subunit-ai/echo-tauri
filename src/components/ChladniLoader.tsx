import { useEffect, useRef } from "react";

/**
 * Chladni-Loader — Sand auf einer schwingenden Platte, 1:1 simuliert
 * (TJ 2026-07-12: "wenn dieser Stimmabdruck ausgewertet wird, möchte ich, dass
 * das morphende Bild von diesen Spektralmustern durchswitcht und smooth
 * animiert wird").
 *
 * Physik: Körner wandern bergab auf |u|² (zu den Knotenlinien, wo die Platte
 * stillsteht) und werden geschüttelt, wo sie schwingt (Jitter ∝ |u|). Die
 * Moden-Mischung ist eine Gauß-Aktivierung über einer Moden-Leiter — der
 * "drive" wandert kontinuierlich, dadurch MORPHT das Muster (Sand fließt um),
 * nichts blendet oder springt.
 *
 * Modi:
 *  - "eval"  (Auswertung/uploading): drive läuft selbstständig durch die Leiter.
 *  - "speak" (Enrollment/record):    der Mikrofon-Pegel treibt drive + Schütteln —
 *                                    das Muster morpht mit der Stimme.
 *
 * Theme-sicher (inkl. black/zero-hue): Korn-Farbe = aufgelöste currentColor des
 * Containers; additiv gezeichnet nur, wenn die Farbe hell ist (= dunkles Theme).
 */

const BANK: [number, number][] = [
  [2, 3], [3, 4], [2, 5], [3, 5], [4, 5], [4, 6], [5, 6], [5, 7], [6, 7], [7, 8],
];
const N = 3200;
const EPS = 0.004;

function h1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

export function ChladniLoader({
  mode,
  level = 0,
  size = 224,
}: {
  mode: "eval" | "speak";
  /** Mikrofon-Pegel 0..1 (nur "speak"). */
  level?: number;
  size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modeRef = useRef(mode);
  const levelRef = useRef(level);
  modeRef.current = mode;
  levelRef.current = level;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = size * dpr;
    cv.height = size * dpr;

    // Korn-Farbe aus dem Theme auflösen; hell → dunkles Theme → additiv zeichnen
    const rgb = getComputedStyle(cv).color.match(/\d+(\.\d+)?/g)?.map(Number) ?? [128, 128, 128];
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    const darkTheme = lum > 0.5;
    const fill = darkTheme
      ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.75)`
      : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.62)`;

    // Startverteilung deterministisch gleichverteilt
    const px = new Float32Array(N);
    const py = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      px[i] = h1(i * 12.9898 + 78.233);
      py[i] = h1(i * 39.3468 + 11.135);
    }
    // Schneller LCG-Jitter (Kosmetik — der ABDRUCK bleibt deterministisch,
    // der Loader ist ein transienter Zustand)
    let js = 0x9e3779b9;
    const jr = () => {
      js = (Math.imul(js, 1664525) + 1013904223) >>> 0;
      return js / 4294967296;
    };
    const signs = BANK.map((_, i) => (h1(i * 7.3) < 0.5 ? -1 : 1));

    let drive = 2.2;
    let target = 2.2;
    let evalT = 0;

    type Mode = { n: number; m: number; w: number; s: number };
    function weights(): Mode[] {
      const g: number[] = [];
      let sum = 0;
      for (let i = 0; i < BANK.length; i++) {
        const v = Math.exp(-((i - drive) * (i - drive)) / (2 * 0.55 * 0.55));
        g.push(v);
        sum += v;
      }
      const act: Mode[] = [];
      for (let i = 0; i < BANK.length; i++) {
        const w = g[i] / sum;
        if (w > 0.03) act.push({ n: BANK[i][0], m: BANK[i][1], w, s: signs[i] });
      }
      return act;
    }
    function U(act: Mode[], x: number, y: number): number {
      let s = 0;
      for (const a of act)
        s +=
          a.w *
          (Math.cos(a.n * Math.PI * x) * Math.cos(a.m * Math.PI * y) +
            a.s * Math.cos(a.m * Math.PI * x) * Math.cos(a.n * Math.PI * y));
      return s;
    }

    function stepSim(dt: number) {
      let agit = 1;
      if (modeRef.current === "eval") {
        evalT += dt;
        if (evalT > 3.2) {
          evalT = 0;
          target = 0.5 + jr() * (BANK.length - 1.5);
        }
        drive += (target - drive) * Math.min(1, dt * 1.6);
      } else {
        const e = Math.max(0, Math.min(1, levelRef.current));
        target = 0.4 + e * (BANK.length - 1.6);
        drive += (target - drive) * Math.min(1, dt * 3.2);
        agit = 0.7 + 1.8 * e;
      }
      const act = weights();
      const lr = 0.0016;
      const jamp = 0.0017 * agit;
      const CAP = 0.016;
      for (let i = 0; i < N; i++) {
        const x = px[i];
        const y = py[i];
        const u = U(act, x, y);
        const gx = (U(act, x + EPS, y) - U(act, x - EPS, y)) / (2 * EPS);
        const gy = (U(act, x, y + EPS) - U(act, x, y - EPS)) / (2 * EPS);
        let sx = -lr * u * gx;
        let sy = -lr * u * gy;
        const sl = Math.hypot(sx, sy);
        if (sl > CAP) {
          sx *= CAP / sl;
          sy *= CAP / sl;
        }
        const j = jamp * Math.min(Math.abs(u), 1.2);
        let nx = x + sx + (jr() - 0.5) * j;
        let ny = y + sy + (jr() - 0.5) * j;
        if (nx < 0.004) nx = 0.008 - nx;
        else if (nx > 0.996) nx = 1.992 - nx;
        if (ny < 0.004) ny = 0.008 - ny;
        else if (ny > 0.996) ny = 1.992 - ny;
        px[i] = nx;
        py[i] = ny;
      }
    }

    function draw() {
      if (!ctx) return;
      const w = cv!.width;
      const h = cv!.height;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = darkTheme ? "lighter" : "source-over";
      ctx.fillStyle = fill;
      const s = 1.25 * dpr;
      for (let i = 0; i < N; i++) ctx.fillRect(px[i] * w, py[i] * h, s, s);
      ctx.globalCompositeOperation = "source-over";
    }

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = 0;
    if (reduced) {
      // statisch einschwingen — ein Frame, kein Dauerloop
      for (let i = 0; i < 240; i++) stepSim(0.016);
      draw();
    } else {
      const loop = (now: number) => {
        if (!last) last = now;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        stepSim(dt);
        draw();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <div className="vp-plate" aria-hidden="true">
      <canvas ref={canvasRef} style={{ width: size, height: size }} />
    </div>
  );
}
