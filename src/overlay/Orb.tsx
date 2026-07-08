import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  BAN_PATHS,
  BRIEFCASE_PATHS,
  BROOM_PATHS,
  CLOUD_PATHS,
  HASH_PATHS,
  LETTER_PATHS,
  LIST_PATHS,
  MAIL_PATHS,
  MEGAPHONE_PATHS,
  SHIELD_CHECK_PATHS,
  SPARKLES_PATHS,
  STAR4_PATHS,
  TERMINAL_PATHS,
  WAND_PATHS,
  StrokeIcon,
} from "../components/icons";
import {
  onState,
  orbQuick,
  orbSet,
  overlaySetHotRects,
  setOrbPosition,
  type EngineState,
  type OrbQuick,
} from "../lib/ipc";
import { drawOrb, newOrbAnim } from "./orbRender";

// Per-state orb colors are user-configurable in Settings (idle / working / done /
// error). `working` covers both recording AND transcribing (the "busy" states).
// `error` defaults to a warning amber but is now themable like the rest.
// Defaults mirror the previous hardcoded look.
const DEFAULT_IDLE = "#22d3ee";
const DEFAULT_WORKING = "#ff5c5c";
const DEFAULT_DONE = "#50dc82";
const DEFAULT_ERROR = "#ffc450";

// ---- Island layout --------------------------------------------------------
// The window is the orb square PLUS transparent gutters where the chips and
// their panels live (left / right / above / below). A chip sits one GAP from the
// orb; its panel blooms BEYOND the chip (one PANEL_GAP further out) so it never
// covers the chip you're pointing at, and the chip stays put. Only GUTTER_* must
// match the Rust side (src-tauri/src/overlay.rs — it sizes the window from them);
// everything else is the webview's own layout, reported to Rust as hit-rects
// (overlaySetHotRects) so the window catches the mouse ONLY over real elements.
const GUTTER_X = 224;
const GUTTER_TOP = 190;
const GUTTER_BOTTOM = 64;
const GAP = 18; // clear air between the orb canvas and a chip
const CHIP = 38; // collapsed chip (icon) diameter
const PANEL_W = 150; // expanded panel width
const PANEL_GAP = 10; // clear air between a chip and ITS panel
const ROW_H = 34; // one option row (keep in sync with rowStyle height)
const ROW_GAP = 2; // panelBase gap
const PANEL_PAD = 6; // panelBase padding
const panelH = (rows: number) => rows * ROW_H + (rows - 1) * ROW_GAP + 2 * PANEL_PAD;

type Rect = { x: number; y: number; w: number; h: number };

// All chip + panel boxes as plain numbers, derived from the live window size and
// the constants above. Used for BOTH rendering AND the hit-rects we report to
// Rust, so the click-catch region hugs exactly what's drawn — no
// getBoundingClientRect, no transform-scale ambiguity during the bloom.
function computeLayout(): {
  w: number;
  h: number;
  dim: number;
  orb: Rect;
  chips: Record<"mode" | "cleanup" | "console", Rect>;
  panels: Record<"mode" | "cleanup", Rect>;
} {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dim = Math.max(1, w - 2 * GUTTER_X);
  const midY = GUTTER_TOP + dim / 2; // vertical centre of the orb square
  const cx = w / 2;
  // Keep a tall panel fully on-window (small orbs): clamp its top edge.
  const clampTop = (top: number, ph: number) =>
    Math.min(Math.max(top, 6), Math.max(6, h - ph - 6));
  const chips = {
    mode: { x: GUTTER_X - GAP - CHIP, y: midY - CHIP / 2, w: CHIP, h: CHIP },
    cleanup: { x: GUTTER_X + dim + GAP, y: midY - CHIP / 2, w: CHIP, h: CHIP },
    // Prompt-Terminal moved from the bottom to the TOP-centre — the old language
    // island is retired (TJ 2026-07-03). It's an action chip (no panel).
    console: { x: cx - CHIP / 2, y: GUTTER_TOP - GAP - CHIP, w: CHIP, h: CHIP },
  };
  const panels = {
    mode: {
      x: chips.mode.x - PANEL_GAP - PANEL_W,
      y: clampTop(midY - panelH(2) / 2, panelH(2)),
      w: PANEL_W,
      h: panelH(2),
    },
    cleanup: {
      // 10 rows: off · auto · prompt · email · slack · formal · tidy · notes · letter · social
      x: chips.cleanup.x + CHIP + PANEL_GAP,
      y: clampTop(midY - panelH(10) / 2, panelH(10)),
      w: PANEL_W,
      h: panelH(10),
    },
  };
  return {
    w,
    h,
    dim,
    orb: { x: GUTTER_X, y: GUTTER_TOP, w: dim, h: dim },
    chips,
    panels,
  };
}

const MODE_COLOR: Record<string, string> = {
  local: "#22d3ee",
  cloud: "#5b9dff",
};

// Liquid-Glass (dark, floats over arbitrary screen content). The overlay window
// is transparent, so `backdrop-filter` blurs the real desktop/app content BEHIND
// it — a thin translucent navy tint over that blur reads as proper frosted glass
// (TJ: "noch transparenter, mehr Liquid Glass"). Hairline + top rim keep the edge.
const glassSurface: CSSProperties = {
  background: "rgba(12,24,46,0.52)",
  backdropFilter: "blur(22px) saturate(1.6)",
  WebkitBackdropFilter: "blur(22px) saturate(1.6)",
  border: "1px solid rgba(165,200,240,0.16)",
  boxShadow:
    "inset 0 1px 0 rgba(205,228,255,0.16), 0 16px 38px -18px rgba(0,0,0,0.55)",
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
 * Engaged → two icon-only glass chips appear beside the orb (mode left,
 * cleanup right) plus the ✦ Prompt-Terminal chip above. Each option chip
 * springs on hover and blooms ONLY its own option panel — every value visible,
 * one click to set (`orb_set`). The other chips stay put so you can switch.
 * Returning to the orb collapses the panel back to a chip; leaving the window
 * hides everything.
 */
export function Orb() {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const state = useRef<EngineState>("idle");
  const level = useRef(0);
  const bandsData = useRef<number[]>([]);
  const style = useRef("ping");
  const colorIdle = useRef(DEFAULT_IDLE);
  const colorWorking = useRef(DEFAULT_WORKING);
  const colorDone = useRef(DEFAULT_DONE);
  const colorError = useRef(DEFAULT_ERROR);
  const idlePulse = useRef(true);
  const idleMode = useRef<"normal" | "dim" | "hide">("normal");
  const speed = useRef(0.6);
  const appear = useRef("bloom");
  const pillColorMode = useRef("color");
  const [quick, setQuick] = useState<OrbQuick | null>(null);
  const [hover, setHover] = useState(false);
  // Which single satellite is expanded (null = just the icon chips). Hovering a
  // chip opens ONLY its own panel — not all three at once (TJ).
  const [openPanel, setOpenPanel] = useState<"mode" | "cleanup" | null>(null);
  // Chip/panel geometry as numbers — recomputed when the window (orb size) changes.
  const [layout, setLayout] = useState(computeLayout);

  useEffect(() => {
    invoke<Record<string, unknown>>("get_config")
      .then((c) => {
        style.current = (c.orb_overlay_style as string) || "ping";
        if (typeof c.orb_color_idle === "string" && c.orb_color_idle) colorIdle.current = c.orb_color_idle;
        if (typeof c.orb_color_working === "string" && c.orb_color_working) colorWorking.current = c.orb_color_working;
        if (typeof c.orb_color_done === "string" && c.orb_color_done) colorDone.current = c.orb_color_done;
        if (typeof c.orb_color_error === "string" && c.orb_color_error) colorError.current = c.orb_color_error;
        idlePulse.current = c.orb_idle_pulse !== false;
        if (c.orb_idle_mode === "dim" || c.orb_idle_mode === "hide") idleMode.current = c.orb_idle_mode;
        else idleMode.current = "normal";
        if (typeof c.orb_speed === "number") speed.current = c.orb_speed;
        if (typeof c.orb_appear_anim === "string" && c.orb_appear_anim) appear.current = c.orb_appear_anim;
        if (typeof c.orb_pill_color_mode === "string" && c.orb_pill_color_mode)
          pillColorMode.current = c.orb_pill_color_mode;
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
      colorError?: string;
      idlePulse?: boolean;
      idleMode?: "normal" | "dim" | "hide";
      speed?: number;
      appear?: string;
      pillColorMode?: string;
      quick?: OrbQuick;
    }>("echo://orb-config", (e) => {
      const p = e.payload;
      if (typeof p.style === "string") style.current = p.style;
      if (p.colorIdle) colorIdle.current = p.colorIdle;
      if (p.colorWorking) colorWorking.current = p.colorWorking;
      if (p.colorDone) colorDone.current = p.colorDone;
      if (p.colorError) colorError.current = p.colorError;
      idlePulse.current = p.idlePulse !== false;
      if (p.idleMode) idleMode.current = p.idleMode;
      if (typeof p.speed === "number") speed.current = p.speed;
      if (typeof p.appear === "string" && p.appear) appear.current = p.appear;
      if (typeof p.pillColorMode === "string" && p.pillColorMode)
        pillColorMode.current = p.pillColorMode;
      if (p.quick) setQuick(p.quick);
    });
    // Engagement from the Rust hit-test loop: shows/hides the islands AND drives
    // which panel is open. Rust derives `over` from the global cursor poll, so the
    // islands react even when the overlay window isn't focused — a non-key macOS
    // window gets no DOM mouseMoved, so hover-to-open used to need a click first.
    const unHover = listen<{ hover: boolean; over?: "mode" | "cleanup" | null }>(
      "echo://orb-hover",
      (e) => {
        setHover(e.payload.hover);
        setOpenPanel(e.payload.hover ? e.payload.over ?? null : null);
      },
    );
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

    // Mic features: poll while recording, decay otherwise. One IPC call carries
    // the scalar level AND the real 16-band spectrum. VU-style smoothing on the
    // level — jump UP instantly on a louder sample (so bars pop the moment you
    // speak) but ease DOWN gently; the bands get their own attack/release
    // envelope inside drawOrb. 33 ms ≈ 30 Hz keeps the orb glued to the voice
    // (the old 50 ms poll was the visible lag in fast speech).
    const poll = window.setInterval(async () => {
      if (state.current === "recording") {
        try {
          const f = await invoke<{ level: number; bands: number[] }>("mic_features");
          level.current =
            f.level > level.current ? f.level : level.current * 0.82 + f.level * 0.18;
          bandsData.current = f.bands;
        } catch {
          /* ignore */
        }
      } else {
        level.current *= 0.85;
      }
    }, 33);

    let raf = 0;
    const anim = newOrbAnim();

    const loop = () => {
      drawOrb(
        ctx,
        canvas.width,
        canvas.height,
        {
          style: style.current,
          colors: {
            idle: colorIdle.current,
            working: colorWorking.current,
            done: colorDone.current,
            error: colorError.current,
          },
          idlePulse: idlePulse.current,
          idleMode: idleMode.current,
          speed: speed.current,
          appear: appear.current,
          pillColorMode: pillColorMode.current,
        },
        state.current,
        level.current,
        anim,
        bandsData.current,
      );
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
  //
  // Programmatic anchor placements (Rust position_window) announce themselves
  // via `echo://orb-anchored` BEFORE moving — those moves must NOT be saved,
  // or picking "bottom-center" in Settings would instantly be overwritten with
  // a "custom-…" position and the named anchor would never stick.
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: number | undefined;
    let suppressUntil = 0;
    const unAnchored = listen("echo://orb-anchored", () => {
      suppressUntil = Date.now() + 800;
      if (timer) window.clearTimeout(timer); // drop a pending drag-save too
    });
    const un = win.onMoved(() => {
      if (Date.now() < suppressUntil) return;
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
      unAnchored.then((f) => f());
    };
  }, []);

  // Recompute the chip/panel geometry whenever the overlay window resizes (the
  // only time it changes is an orb-size change in Settings → Rust set_size).
  useEffect(() => {
    const onResize = () => setLayout(computeLayout());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Report our interactive rectangles to Rust so the window catches the mouse
  // ONLY over the orb + the currently-visible chips / open panel — the
  // transparent gaps stay click-through (clicks reach the app behind). The orb
  // is always reported; chips while engaged; the open panel while it's open.
  useEffect(() => {
    const merge = (a: Rect, b: Rect): Rect => {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
    };
    const rects: (Rect & { panel?: string })[] = [layout.orb];
    if (hover) {
      rects.push(layout.chips.console);
      if (quick) {
        (["mode", "cleanup"] as const).forEach((key) => {
          // While a panel is open, report ONE merged chip+panel zone (labelled) so
          // the 10px gap between them still counts as "over" that panel (no
          // open/close flicker as the cursor crosses it) and the whole zone catches
          // the mouse. Closed → just the chip carries the label.
          const zone = openPanel === key ? merge(layout.chips[key], layout.panels[key]) : layout.chips[key];
          rects.push({ ...zone, panel: key });
        });
      }
    }
    overlaySetHotRects(rects).catch(() => {});
  }, [layout, hover, openPanel, quick]);

  const pick = (which: "mode" | "cleanup", value: string) => () => {
    orbSet(which, value).then(setQuick).catch(() => {});
  };

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
  // All chips show while engaged and STAY put when their panel opens (the panel
  // blooms beyond the chip, it doesn't replace it) — so the icon you pointed at
  // never disappears and you can hop straight to another chip.
  const chipVis = (vis: boolean): CSSProperties => ({
    opacity: vis ? 1 : 0,
    transform: vis ? "scale(1)" : "scale(0.7)",
    pointerEvents: vis ? "auto" : "none",
  });

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
  // Only the open panel is visible — keep it mounted so it stays put while the
  // pointer travels from its chip onto it (leaving sets openPanel back to null).
  const panelVis = (key: "mode" | "cleanup", origin: string): CSSProperties => {
    const on = openPanel === key;
    return {
      opacity: on ? 1 : 0,
      transform: on ? "scale(1)" : "scale(0.72)",
      transformOrigin: origin,
      pointerEvents: on ? "auto" : "none",
    };
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Orb square between the gutters. Returning here folds the panels back
          (Rust emits over=null over the orb). */}
      <div
        ref={boxRef}
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
          {/* ---- Collapsed chips: icon-only, one GAP from the orb. Hovering a
               chip blooms its own panel BEYOND it (the chip stays put). ---- */}
          {/* W — transcription mode (left of the orb) */}
          <button
            className="orb-chip"
            title={t("overlay.tooltipMode", { value: quick.mode })}
            style={{
              ...chipBase,
              ...chipVis(hover),
              left: layout.chips.mode.x,
              top: layout.chips.mode.y,
              color: MODE_COLOR[quick.mode] ?? "#cfe0f2",
            }}
          >
            <StrokeIcon
              paths={quick.mode === "local" ? SHIELD_CHECK_PATHS : CLOUD_PATHS}
              size={17}
              strokeWidth={1.9}
            />
          </button>
          {/* E — cleanup style (right of the orb) */}
          <button
            className="orb-chip"
            title={t("overlay.tooltipCleanup", { value: quick.cleanup })}
            style={{
              ...chipBase,
              ...chipVis(hover),
              left: layout.chips.cleanup.x,
              top: layout.chips.cleanup.y,
              color: quick.cleanup === "off" ? "#7d8da3" : "#22d3ee",
            }}
          >
            <StrokeIcon paths={SPARKLES_PATHS} size={17} strokeWidth={1.9} />
          </button>

          {/* ---- Expanded panel: blooms BEYOND the hovered chip, never on it ---- */}
          {/* Mode — beyond the mode chip (further left) */}
          <div
            style={{
              ...panelBase,
              ...panelVis("mode", "right center"),
              left: layout.panels.mode.x,
              top: layout.panels.mode.y,
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
          </div>
          {/* Cleanup — beyond the cleanup chip (further right). 10 rows can
              exceed a small orb window, so cap to the viewport and scroll
              rather than clip (clampTop already keeps the top edge on-window). */}
          <div
            style={{
              ...panelBase,
              ...panelVis("cleanup", "left center"),
              left: layout.panels.cleanup.x,
              top: layout.panels.cleanup.y,
              maxHeight: "calc(100vh - 12px)",
              overflowY: "auto",
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
            <Row
              icon={BROOM_PATHS}
              label={t("settings.cleanupStyleTidy")}
              active={quick.cleanup === "tidy"}
              onClick={pick("cleanup", "tidy")}
            />
            <Row
              icon={LIST_PATHS}
              label={t("settings.cleanupStyleNotes")}
              active={quick.cleanup === "notes"}
              onClick={pick("cleanup", "notes")}
            />
            <Row
              icon={LETTER_PATHS}
              label={t("settings.cleanupStyleLetter")}
              active={quick.cleanup === "letter"}
              onClick={pick("cleanup", "letter")}
            />
            <Row
              icon={MEGAPHONE_PATHS}
              label={t("settings.cleanupStyleSocial")}
              active={quick.cleanup === "social"}
              onClick={pick("cleanup", "social")}
            />
          </div>
        </>
      )}

      {/* Prompt Terminal (action chip, above the orb; no panel). Moved up from the
          bottom now that the language island is retired. */}
      <button
        className="orb-chip"
        title={t("overlay.tooltipPrompt")}
        onClick={() => {
          invoke("prompt_console_toggle").catch(() => {});
        }}
        style={{
          ...chipBase,
          ...chipVis(hover),
          left: layout.chips.console.x,
          top: layout.chips.console.y,
          color: "#a78bfa",
        }}
      >
        <StrokeIcon paths={STAR4_PATHS} size={16} strokeWidth={1.9} />
      </button>
    </div>
  );
}
