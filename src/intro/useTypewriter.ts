import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./useReducedMotion";

/** RAF-driven typewriter. Iterates code points (i18n-safe), pauses briefly on
 *  sentence punctuation. Under reduced motion the full text appears at once. */
export function useTypewriter(
  text: string,
  { cps = 36, startDelay = 0 }: { cps?: number; startDelay?: number } = {},
): { shown: string; done: boolean } {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? text : "");
  const [done, setDone] = useState(reduced);
  const raf = useRef(0);

  useEffect(() => {
    if (reduced) {
      setShown(text);
      setDone(true);
      return;
    }
    setShown("");
    setDone(false);
    const chars = Array.from(text);
    // Punctuation gets a beat: weight 4 ≈ a 4-char pause at the given cps.
    const weights = chars.map((c) => (".,—!?".includes(c) ? 4 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now + startDelay;
      const budget = ((now - start) * cps) / 1000;
      if (budget <= 0) {
        raf.current = requestAnimationFrame(tick);
        return;
      }
      let used = 0;
      let n = 0;
      while (n < chars.length && used + weights[n] <= budget) {
        used += weights[n];
        n += 1;
      }
      setShown(chars.slice(0, n).join(""));
      if (used >= total || n >= chars.length) {
        setShown(text);
        setDone(true);
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [text, cps, startDelay, reduced]);

  return { shown, done };
}
