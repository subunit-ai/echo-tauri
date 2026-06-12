import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  BAN_PATHS,
  BRIEFCASE_PATHS,
  CLOUD_PATHS,
  GLOBE_PATHS,
  HASH_PATHS,
  MAIL_PATHS,
  SHIELD_CHECK_PATHS,
  SPARKLES_PATHS,
  STAR4_PATHS,
  TERMINAL_PATHS,
  WAND_PATHS,
  ZAP_PATHS,
  StrokeIcon,
} from "../components/icons";
import {
  onState,
  orbQuick,
  orbSet,
  setOrbPosition,
  type EngineState,
  type OrbQuick,
} from "../lib/ipc";

// Per-state orb colors are user-configurable in Settings (idle / working / done).
// `working` covers both recording AND transcribing (the "busy" states). The error
// state keeps a fixed warning amber — it signals a problem and shouldn't blend into
// the chosen palette. Defaults mirror the previous hardcoded look.
const DEFAULT_IDLE = "#22d3ee";
const DEFAULT_WORKING = "#ff5c5c";
const DEFAULT_DONE = "#50dc82";
const ERROR_COLOR = "#ffc450";

function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ---- Island layout --------------------------------------------------------
// The window is the orb square PLUS transparent gutters where the islands live
// (left / right / above / below) so they never cover the canvas drawing.
// KEEP IN SYNC with GUTTER_* in src-tauri/src/overlay.rs.
const GUTTER_X = 168;
const GUTTER_TOP = 168;
const GUTTER_BOTTOM = 64;
const GAP = 18; // clear air between the orb canvas and an island
const CHIP = 38; // collapsed island (icon chip) diameter
const PANEL_W = GUTTER_X - GAP; // expanded island width — fills its gutter

const MODE_COLOR: Record<string, string> = {
  local: "#22d3ee",
  cloud: "#5b9dff",
  superfast: "#ff9f43",
};

// Liquid-Glass (dark, floats over arbitrary screen content — no real backdrop
// to blur, so the glass is a high-opacity navy fill + hairline + top rim).
const glassSurface: CSSProperties = {
  background: "rgba(10,22,40,0.92)",
  border: "1px solid rgba(150,185,225,0.18)",
  boxShadow:
    "inset 0 1px 0 rgba(190,215,245,0.14), 0 18px 40px -18px rgba(0,0,0,0.65)",
};

const EASE = "cubic-bezier(.2,.8,.2,1)";

const rowStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 9,
  height: 34,
  padding: "0 10px",
  borderRadius: 12,
  border: `1px solid ${active ? "rgba(34,211,238,0.5)" : "transparent"}`,
  background: active ? "rgba(34,211,238,0.14)" : "transparent",
  color: active ? "#67e8f9" : "#cfe0f2",
  fontSize: 12.5,
  fontWeight: 600,
  letterSpacing: "0.01em",
  whiteSpace: "nowrap",
  cursor: "pointer",
  userSelect: "none",
  textAlign: "left",
  width: "100%",
});

/** One option inside an expanded island: icon + label, cyan when active. */
function Row({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string[];
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      style={rowStyle(active)}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "rgba(255,255,255,0.07)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <StrokeIcon paths={icon} size={15} strokeWidth={1.9} />
      {label}
    </button>
  );
}

/**
 * The floating orb. A transparent, click-through overlay window renders this;
 * the Rust hit-test loop reports engagement via `echo://orb-hover` (the webview
 * gets no mouse events while click-through, so it can't track hover itself).
 *
 * Engaged → three icon-only glass chips appear around the orb (mode left,
 * language above, cleanup right) plus the ✦ console chip below. Hovering ANY
 * chip blooms all three into full option panels — every value visible, one
 * click to set (`orb_set`). Returning to the orb collapses them back to chips;
 * leaving the window hides everything.
 */
export function Orb() {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const state = useRef<EngineState>("idle");
  const level = useRef(0);
  const style = useRef("ping");
  const colorIdle = useRef(DEFAULT_IDLE);
  const colorWorking = useRef(DEFAULT_WORKING);
  const colorDone = useRef(DEFAULT_DONE);
  const idlePulse = useRef(true);
  const idleMode = useRef<"normal" | "dim" | "hide">("normal");
  const speed = useRef(0.6);
  const [quick, setQuick] = useState<OrbQuick | null>(null);
  const [hover, setHover] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    invoke<Record<string, unknown>>("get_config")
      .then((c) => {
        style.current = (c.orb_overlay_style as string) || "ping";
        if (typeof c.orb_color_idle === "string" && c.orb_color_idle) colorIdle.current = c.orb_color_idle;
        if (typeof c.orb_color_working === "string" && c.orb_color_working) colorWorking.current = c.orb_color_working;
        if (typeof c.orb_color_done === "string" && c.orb_color_done) colorDone.current = c.orb_color_done;
        idlePulse.current = c.orb_idle_pulse !== false;
        if (c.orb_idle_mode === "dim" || c.orb_idle_mode === "hide") idleMode.current = c.orb_idle_mode;
        else idleMode.current = "normal";
        if (typeof c.orb_speed === "number") speed.current = c.orb_speed;
      })
      .catch(() => {});
    orbQuick().then(setQuick).catch(() => {});
    const un = onState((p) => {
      state.current = p.state;
    });
    // Live config updates from Settings (set_config emits this) — restyle without
    // reload, and refresh the satellite quick-state so a mode/language/cleanup
    // change made in the main window shows on the orb too.
    const unCfg = listen<{
      style?: string;
      colorIdle?: string;
      colorWorking?: string;
      colorDone?: string;
      idlePulse?: boolean;
      idleMode?: "normal" | "dim" | "hide";
      speed?: number;
      quick?: OrbQuick;
    }>("echo://orb-config", (e) => {
      const p = e.payload;
      if (typeof p.style === "string") style.current = p.style;
      if (p.colorIdle) colorIdle.current = p.colorIdle;
      if (p.colorWorking) colorWorking.current = p.colorWorking;
      if (p.colorDone) colorDone.current = p.colorDone;
      idlePulse.current = p.idlePulse !== false;
      if (p.idleMode) idleMode.current = p.idleMode;
      if (typeof p.speed === "number") speed.current = p.speed;
      if (p.quick) setQuick(p.quick);
    });
    // Engagement from the Rust hit-test loop: shows/hides the islands. On
    // disengage the panels also fold back so the next hover starts calm.
    const unHover = listen<{ hover: boolean }>("echo://orb-hover", (e) => {
      setHover(e.payload.hover);
      if (!e.payload.hover) setExpanded(false);
    });
    return () => {
      un.then((f) => f());
      unCfg.then((f) => f());
      unHover.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // The canvas covers ONLY the orb square (the gutters belong to the islands),
    // so it sizes against its box, not the window.
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = Math.floor(box.clientWidth * dpr);
      canvas.height = Math.floor(box.clientHeight * dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    // Mic level: poll while recording, decay otherwise. VU-style smoothing — jump UP
    // instantly on a louder sample (so bars pop the moment you speak) but ease DOWN
    // gently, so the orb tracks the voice instead of just shimmering on its own.
    const poll = window.setInterval(async () => {
      if (state.current === "recording") {
        try {
          const raw = await invoke<number>("mic_level");
          level.current = raw > level.current ? raw : level.current * 0.82 + raw * 0.18;
        } catch {
          /* ignore */
        }
      } else {
        level.current *= 0.85;
      }
    }, 50);

    let t = 0;
    let frame = 0;
    let raf = 0;
    const rings: { r: number; a0: number }[] = [];

    const loop = () => {
      // Animation speed (TJ: the default cadence felt too fast — now adjustable).
      // `t` (scaled) drives every continuous frequency below; `frame` (real frames)
      // drives the discrete ping-ring spawn cadence so its modulo stays integer.
      const sp = Math.max(0.2, Math.min(2, speed.current));
      frame += 1;
      t += sp;
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const size = Math.min(w, h);
      const lvl = Math.min(1, level.current);
      const st = state.current;
      // idle → colorIdle · recording/transcribing → colorWorking · done → colorDone
      // · error → fixed warning amber.
      const base =
        st === "recording" || st === "transcribing"
          ? colorWorking.current
          : st === "done"
            ? colorDone.current
            : st === "error"
              ? ERROR_COLOR
              : colorIdle.current;
      const dotR = size * 0.1;
      // When idle animation is OFF, freeze every style's time-based motion so the
      // orb truly rests — the audio-track styles (bars/wave) then react ONLY to
      // real speech while recording, not to a constant idle shimmer. `ph` is the
      // frozen phase fed to the per-style oscillators.
      const idleStill = st === "idle" && !idlePulse.current;
      const ph = idleStill ? 0 : t;

      ctx.clearRect(0, 0, w, h);

      // Idle behaviour: "hide" → render nothing (canvas already cleared); "dim" →
      // draw at reduced opacity (a calm, semi-transparent resting orb instead of
      // vanishing); "normal" → full strength.
      if (st === "idle" && idleMode.current === "hide") {
        raf = requestAnimationFrame(loop);
        return;
      }
      ctx.globalAlpha = st === "idle" && idleMode.current === "dim" ? 0.32 : 1;

      // breathing factor for idle / transcribing
      const breathe =
        st === "transcribing"
          ? 0.5 + 0.5 * Math.sin(t * 0.18)
          : st === "idle"
            ? idlePulse.current
              ? 0.55 + 0.45 * Math.sin(t * 0.05)
              : 0.7
            : 1;
      // While recording, energy is voice-dominated with only a small floor, so every
      // style visibly reacts to how loud you speak (not a constant idle shimmer).
      const energy = st === "recording" ? 0.12 + lvl * 0.88 : breathe * 0.6;
      const speaking = st === "recording";

      switch (style.current) {
        case "sphere": {
          const r = dotR * (1 + energy * 1.4);
          const grad = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.6);
          grad.addColorStop(0, hexA(base, 0.95));
          grad.addColorStop(0.6, hexA(base, 0.35));
          grad.addColorStop(1, hexA(base, 0));
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(cx, cy, r * 1.6, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case "bars": {
          const n = 5;
          const bw = size * 0.06;
          const gap = bw * 0.8;
          const total = n * bw + (n - 1) * gap;
          for (let i = 0; i < n; i++) {
            const k = Math.abs(i - (n - 1) / 2);
            const center = 1 - k * 0.22; // center-weighted profile (tallest in the middle)
            // While recording, the bar HEIGHT is the real mic level (center-weighted) —
            // small dots when silent, springing up as you speak — with only a tiny per-bar
            // shimmer so it reads as a live VU meter, not a self-running animation.
            // Otherwise (idle/transcribing) keep the gentle breathing.
            const amp = speaking
              ? Math.min(1, 0.05 + lvl * center * 1.2)
              : energy * center + 0.08;
            const shimmer = speaking
              ? 0.9 + 0.1 * Math.sin(ph * 0.5 + i)
              : 0.6 + 0.4 * Math.abs(Math.sin(ph * 0.2 + i));
            // At rest with idle animation OFF (and silent while recording), collapse each
            // bar to a small DOT (height == width → the roundRect's bw/2 radius makes it a
            // circle) instead of a standing bar or a frozen mid-animation frame.
            const bh = idleStill ? bw : Math.max(bw, size * 0.5 * amp * shimmer);
            const x = cx - total / 2 + i * (bw + gap);
            ctx.fillStyle = hexA(base, 0.9);
            const y = cy - bh / 2;
            ctx.beginPath();
            ctx.roundRect(x, y, bw, bh, bw / 2);
            ctx.fill();
          }
          break;
        }
        case "wave": {
          // Flat, calm line at rest (idle animation off). While recording the wave
          // HEIGHT tracks the real mic level (near-flat when silent, swelling as you
          // speak); otherwise it breathes gently.
          const amp = idleStill
            ? size * 0.015
            : speaking
              ? size * (0.02 + lvl * 0.3)
              : size * 0.18 * (0.15 + energy);
          ctx.lineWidth = Math.max(2, size * 0.02);
          ctx.strokeStyle = hexA(base, 0.9);
          ctx.beginPath();
          for (let x = -size * 0.4; x <= size * 0.4; x += 2) {
            const y = Math.sin(x * 0.05 + ph * 0.2) * amp * Math.cos(x * 0.012);
            const px = cx + x;
            const py = cy + y;
            x === -size * 0.4 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          }
          ctx.stroke();
          break;
        }
        case "sonar": {
          for (let i = 0; i < 3; i++) {
            const phase = (ph * 0.03 + i / 3) % 1;
            const r = dotR + phase * size * 0.42;
            ctx.strokeStyle = hexA(base, (1 - phase) * 0.6 * (0.4 + energy));
            ctx.lineWidth = Math.max(1.5, size * 0.012);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = hexA(base, 0.95);
          ctx.beginPath();
          ctx.arc(cx, cy, dotR * 0.7, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case "classic": {
          ctx.shadowBlur = size * 0.15 * energy;
          ctx.shadowColor = base;
          ctx.fillStyle = hexA(base, 0.9);
          ctx.beginPath();
          ctx.arc(cx, cy, dotR * (0.9 + energy * 0.4), 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          break;
        }
        default: {
          // "ping" — slow echo rings that expand WIDE and fade out softly, + center dot.
          // Emit far less often than before (TJ: old frequency was way too high) and let
          // each ring travel almost to the edge while easing its alpha down to nothing.
          const maxR = size * 0.47;
          const grow = size * 0.0026 * (1 + energy * 0.6) * sp;
          const spawnEvery = (st === "recording" ? Math.max(30, 64 - lvl * 34) : 96) / sp;
          // No new echo rings while resting with idle animation off — let the
          // in-flight ones fade out, leaving just the calm centre dot.
          if (!idleStill && frame % Math.max(1, Math.round(spawnEvery)) === 0) {
            rings.push({ r: dotR, a0: 0.5 + energy * 0.35 });
          }
          for (let i = rings.length - 1; i >= 0; i--) {
            const ring = rings[i];
            ring.r += grow;
            const p = (ring.r - dotR) / (maxR - dotR); // 0 at birth → 1 at the edge
            if (p >= 1) {
              rings.splice(i, 1);
              continue;
            }
            // ease-out fade: bright near the dot, gone by the time it's big + thinning line
            const a = ring.a0 * (1 - p) * (1 - p);
            ctx.strokeStyle = hexA(base, a);
            ctx.lineWidth = Math.max(1.2, size * 0.012 * (1 - p * 0.5));
            ctx.beginPath();
            ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = hexA(base, 0.85 + 0.15 * energy);
          ctx.beginPath();
          ctx.arc(cx, cy, dotR * (0.85 + energy * 0.3), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.globalAlpha = 1; // reset after a dimmed idle frame
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(poll);
      window.removeEventListener("resize", resize);
    };
  }, []);

  // Persist the position after the user drags the orb (the canvas is a
  // data-tauri-drag-region, so dragging it moves this window). The saved value
  // is the ORB square's top-left (window + gutters) — the same coordinate the
  // pre-gutter builds saved, so old positions keep working. Debounced so we
  // save once the drag settles, not on every intermediate move event.
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: number | undefined;
    const un = win.onMoved(() => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const pos = await win.outerPosition();
          const sf = await win.scaleFactor();
          await setOrbPosition(pos.x / sf + GUTTER_X, pos.y / sf + GUTTER_TOP);
        } catch {
          /* ignore */
        }
      }, 450);
    });
    return () => {
      if (timer) window.clearTimeout(timer);
      un.then((f) => f());
    };
  }, []);

  const pick = (which: "mode" | "language" | "cleanup", value: string) => () => {
    orbSet(which, value).then(setQuick).catch(() => {});
  };

  // Vertical center of the orb square, as a CSS calc (the orb sits between the
  // top and bottom gutters; its box height is only known to CSS).
  const orbMidY = `calc(${GUTTER_TOP}px + (100% - ${GUTTER_TOP + GUTTER_BOTTOM}px) / 2)`;

  const chipBase: CSSProperties = {
    ...glassSurface,
    position: "absolute",
    width: CHIP,
    height: CHIP,
    borderRadius: 999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#cfe0f2",
    cursor: "pointer",
    userSelect: "none",
    padding: 0,
    transition: `opacity 0.18s ease, transform 0.22s ${EASE}`,
  };
  // Chips show while engaged-but-collapsed; panels replace them when expanded.
  const chipVis = (vis: boolean): CSSProperties => ({
    opacity: vis ? 1 : 0,
    transform: vis ? "scale(1)" : "scale(0.7)",
    pointerEvents: vis ? "auto" : "none",
  });
  const chipsVisible = hover && !expanded;

  const panelBase: CSSProperties = {
    ...glassSurface,
    position: "absolute",
    width: PANEL_W,
    borderRadius: 18,
    padding: 6,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    transition: `opacity 0.22s ${EASE}, transform 0.22s ${EASE}`,
  };
  const panelVis = (origin: string): CSSProperties => ({
    opacity: expanded && hover ? 1 : 0,
    transform: expanded && hover ? "scale(1)" : "scale(0.72)",
    transformOrigin: origin,
    pointerEvents: expanded && hover ? "auto" : "none",
  });

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Orb square between the gutters. Returning here folds the panels back. */}
      <div
        ref={boxRef}
        onMouseEnter={() => setExpanded(false)}
        style={{
          position: "absolute",
          left: GUTTER_X,
          right: GUTTER_X,
          top: GUTTER_TOP,
          bottom: GUTTER_BOTTOM,
        }}
      >
        <canvas
          ref={canvasRef}
          data-tauri-drag-region
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />
      </div>

      {quick && (
        <>
          {/* ---- Collapsed chips: icon-only, floating clear of the orb.
               Hovering ANY of them blooms all three option panels. ---- */}
          {/* W — transcription mode */}
          <button
            title={t("overlay.tooltipMode", { value: quick.mode })}
            onMouseEnter={() => setExpanded(true)}
            style={{
              ...chipBase,
              ...chipVis(chipsVisible),
              left: GUTTER_X - GAP - CHIP,
              top: orbMidY,
              marginTop: -CHIP / 2,
              color: MODE_COLOR[quick.mode] ?? "#cfe0f2",
            }}
          >
            <StrokeIcon
              paths={
                quick.mode === "local"
                  ? SHIELD_CHECK_PATHS
                  : quick.mode === "superfast"
                    ? ZAP_PATHS
                    : CLOUD_PATHS
              }
              size={17}
              strokeWidth={1.9}
            />
          </button>
          {/* N — language */}
          <button
            title={t("overlay.tooltipLanguage", { value: quick.language })}
            onMouseEnter={() => setExpanded(true)}
            style={{
              ...chipBase,
              ...chipVis(chipsVisible),
              left: `calc(50% - ${CHIP / 2}px)`,
              top: GUTTER_TOP - GAP - CHIP,
            }}
          >
            <StrokeIcon paths={GLOBE_PATHS} size={17} strokeWidth={1.9} />
          </button>
          {/* E — cleanup style */}
          <button
            title={t("overlay.tooltipCleanup", { value: quick.cleanup })}
            onMouseEnter={() => setExpanded(true)}
            style={{
              ...chipBase,
              ...chipVis(chipsVisible),
              left: `calc(100% - ${GUTTER_X - GAP}px)`,
              top: orbMidY,
              marginTop: -CHIP / 2,
              color: quick.cleanup === "off" ? "#7d8da3" : "#22d3ee",
            }}
          >
            <StrokeIcon paths={SPARKLES_PATHS} size={17} strokeWidth={1.9} />
          </button>

          {/* ---- Expanded islands: all three bloom together on chip hover ---- */}
          {/* Mode — left of the orb */}
          <div
            style={{
              ...panelBase,
              ...panelVis("right center"),
              left: 0,
              top: orbMidY,
              translate: "0 -50%",
            }}
          >
            <Row
              icon={SHIELD_CHECK_PATHS}
              label={t("mode.localTitle")}
              active={quick.mode === "local"}
              onClick={pick("mode", "local")}
            />
            <Row
              icon={CLOUD_PATHS}
              label={t("mode.cloudTitle")}
              active={quick.mode === "cloud"}
              onClick={pick("mode", "cloud")}
            />
            <Row
              icon={ZAP_PATHS}
              label={t("mode.superfastTitle")}
              active={quick.mode === "superfast"}
              onClick={pick("mode", "superfast")}
            />
          </div>
          {/* Language — above the orb */}
          <div
            style={{
              ...panelBase,
              ...panelVis("center bottom"),
              left: `calc(50% - ${PANEL_W / 2}px)`,
              bottom: `calc(100% - ${GUTTER_TOP - GAP}px)`,
            }}
          >
            <Row
              icon={GLOBE_PATHS}
              label="Deutsch"
              active={quick.language === "de"}
              onClick={pick("language", "de")}
            />
            <Row
              icon={GLOBE_PATHS}
              label="English"
              active={quick.language === "en"}
              onClick={pick("language", "en")}
            />
            <Row
              icon={GLOBE_PATHS}
              label={t("overlay.langAuto")}
              active={quick.language === "auto"}
              onClick={pick("language", "auto")}
            />
          </div>
          {/* Cleanup — right of the orb */}
          <div
            style={{
              ...panelBase,
              ...panelVis("left center"),
              left: `calc(100% - ${PANEL_W}px)`,
              top: orbMidY,
              translate: "0 -50%",
            }}
          >
            <Row
              icon={BAN_PATHS}
              label={t("common.off")}
              active={quick.cleanup === "off"}
              onClick={pick("cleanup", "off")}
            />
            {/* Auto — style follows the focused app (Auto-Mode) */}
            <Row
              icon={WAND_PATHS}
              label={t("settings.autoMode")}
              active={quick.cleanup === "auto"}
              onClick={pick("cleanup", "auto")}
            />
            <Row
              icon={TERMINAL_PATHS}
              label={t("settings.cleanupStylePrompt")}
              active={quick.cleanup === "prompt"}
              onClick={pick("cleanup", "prompt")}
            />
            <Row
              icon={MAIL_PATHS}
              label={t("settings.cleanupStyleEmail")}
              active={quick.cleanup === "email"}
              onClick={pick("cleanup", "email")}
            />
            <Row
              icon={HASH_PATHS}
              label={t("settings.cleanupStyleSlack")}
              active={quick.cleanup === "slack"}
              onClick={pick("cleanup", "slack")}
            />
            <Row
              icon={BRIEFCASE_PATHS}
              label={t("settings.cleanupStyleFormal")}
              active={quick.cleanup === "formal"}
              onClick={pick("cleanup", "formal")}
            />
          </div>
        </>
      )}

      {/* S — Prompt Console (action chip, stays a chip in both stages) */}
      <button
        title={t("overlay.tooltipPrompt")}
        onClick={() => {
          invoke("prompt_console_toggle").catch(() => {});
        }}
        style={{
          ...chipBase,
          ...chipVis(hover),
          left: `calc(50% - ${CHIP / 2}px)`,
          top: `calc(100% - ${GUTTER_BOTTOM - 14}px)`,
          color: "#a78bfa",
        }}
      >
        <StrokeIcon paths={STAR4_PATHS} size={16} strokeWidth={1.9} />
      </button>
    </div>
  );
}
