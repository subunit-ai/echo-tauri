import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Measures an element's rendered width and keeps it current across resizes.
 *
 *  This is what lets a chart's viewBox match its container 1:1. An SVG whose
 *  viewBox is a FIXED width but which is rendered at `width="100%"` gets scaled
 *  by (containerWidth / viewBoxWidth) on the x-axis while the y-axis — whose
 *  viewBox height already equals the real pixel height — stays at 1. With
 *  `preserveAspectRatio="none"` that scaling is non-uniform, so every glyph,
 *  circle and corner radius inside is squeezed or stretched sideways. Text you
 *  are meant to READ must never live in a viewBox that doesn't match its box.
 *
 *  Measuring in a LAYOUT effect (not a passive one) matters: it runs before the
 *  browser paints, so the initial width-0 state never reaches the screen.
 *
 *  Returns `[ref, width]`; width is 0 until the first measurement lands.
 */
export function useMeasuredWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width || 0);
    if (typeof ResizeObserver === "undefined") return; // jsdom/headless fallback: the one-shot measure above stands
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}
