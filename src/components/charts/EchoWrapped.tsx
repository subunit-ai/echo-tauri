// EchoWrapped — teilbarer Aktivitäts-Rückblick als Modal (Blueprint §6/§9).
// Rendert ein 9:16-SVG-Poster aus `ActivityOverview` + Top-Wörtern; „PNG
// speichern" rasterisiert das SVG client-seitig (SVG → Data-URL → <img> →
// <canvas> → toDataURL('image/png')) und übergibt das Base64 an
// `activity_export(kind:"png", …)` — kein Clipboard-Image (copy_text ist
// text-only), kein dialog/fs-Plugin. Self-contained, keine externe Lib.
//
// Farben: Das Poster ist bewusst IMMER dark (liest sich als „Echo",
// unabhängig vom aktiven Theme — s. Kommentar an `.wrapped-poster` in
// activity.css). Da CSS-Custom-Properties beim Serialisieren in eine
// standalone SVG-Data-URL nicht mitkommen, sind die Dark-Theme-Tokenwerte
// aus tokens.css hier als Konstanten gebacken (Quelle jeweils vermerkt).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { activityExport, type ActivityOverview, type WordFreq } from "../../lib/ipc";

// ---- Poster-Geometrie -------------------------------------------------
const POSTER_W = 360;
const POSTER_H = 640;
const EXPORT_SCALE = 3; // 1080×1920 — Story-Format
const MAX_TOP_WORDS = 6;
const MAX_WORD_CHARS = 16;

// ---- Gebackene Dark-Tokenwerte (tokens.css, :root dark) ---------------
const INK = "#eaf1fa"; // --ink
const INK2 = "#9fb2c9"; // --ink2
const INK3 = "#6b809b"; // --ink3
const CYAN = "#22d3ee"; // --cyan
const CYAN_INK = "#67e8f9"; // --cyan-ink
const MESH1 = "rgba(6, 182, 212, 0.3)"; // --mesh1
const MESH2 = "rgba(124, 92, 240, 0.26)"; // --mesh2
const MESH3 = "rgba(8, 145, 178, 0.26)"; // --mesh3
// --page-grad Stützpunkte:
const GRAD_TOP = "#071427";
const GRAD_MID = "#040c1a";
const GRAD_BOT = "#06121f";

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

type SavePhase = "idle" | "saving" | "done" | "error";

function truncateWord(word: string): string {
  return word.length > MAX_WORD_CHARS ? `${word.slice(0, MAX_WORD_CHARS - 1)}…` : word;
}

/** Große Zahlen schrumpfen, statt aus dem Poster zu laufen. */
function heroFontSize(text: string): number {
  const n = text.length;
  if (n <= 6) return 52;
  if (n <= 8) return 44;
  if (n <= 10) return 38;
  return 32;
}

function fmtTimeSaved(seconds: number, lang: string): string {
  const mins = Math.max(0, Math.round(seconds / 60));
  if (mins < 60) return `${mins.toLocaleString(lang)} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h.toLocaleString(lang)} h ${m} min` : `${h.toLocaleString(lang)} h`;
}

/**
 * Modal mit teilbarem SVG-Poster (Echo Wrapped). Overlay-Klick + Escape
 * schließen; das Poster selbst ist ein einziges inline-SVG, damit der
 * PNG-Export exakt das zeigt, was auf dem Schirm steht.
 */
export function EchoWrapped(props: {
  overview: ActivityOverview;
  topWords: WordFreq[];
  onClose: () => void;
}) {
  const { overview, topWords, onClose } = props;
  const { t, i18n } = useTranslation();
  const lang = i18n.language || "en";
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [phase, setPhase] = useState<SavePhase>("idle");

  // Escape schließt (wie Overlay-Klick).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // "Gespeichert"-Feedback nach kurzer Zeit zurücksetzen.
  useEffect(() => {
    if (phase !== "done" && phase !== "error") return;
    const timer = window.setTimeout(() => setPhase("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const words = useMemo(() => {
    const clean = (topWords ?? []).filter(
      (w): w is WordFreq =>
        !!w &&
        typeof w.word === "string" &&
        w.word.trim().length > 0 &&
        Number.isFinite(w.count) &&
        w.count > 0,
    );
    return [...clean].sort((a, b) => b.count - a.count).slice(0, MAX_TOP_WORDS);
  }, [topWords]);
  const maxCount = words.length > 0 ? words[0].count : 0;

  const heroText = overview.total.words.toLocaleString(lang);
  const statCols = [
    {
      value: overview.total.transcriptions.toLocaleString(lang),
      label: t("activity.statTranscriptions"),
    },
    {
      value: fmtTimeSaved(overview.total.time_saved_seconds, lang),
      label: t("activity.statTimeSaved"),
    },
    {
      value: t("activity.streakDays", { count: overview.streak.longest }),
      label: t("activity.statStreak"),
    },
  ];

  const dateLine = useMemo(() => {
    try {
      return new Date().toLocaleDateString(lang, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }, [lang]);

  const savePng = useCallback(async () => {
    const svg = svgRef.current;
    if (!svg || phase === "saving") return;
    setPhase("saving");
    try {
      // SVG → Data-URL. Width/height-Attribute stehen am Element (die CSS-
      // 100%-Regel überstimmt sie nur fürs Display), damit WebKit die
      // standalone SVG in nativer Postergröße rasterisiert.
      const source = new XMLSerializer().serializeToString(svg);
      const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("svg rasterization failed"));
        img.src = svgUrl;
      });

      const canvas = document.createElement("canvas");
      canvas.width = POSTER_W * EXPORT_SCALE;
      canvas.height = POSTER_H * EXPORT_SCALE;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const dataUrl = canvas.toDataURL("image/png");
      const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (!b64) throw new Error("png encoding failed");

      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      await activityExport("png", `echo-wrapped-${stamp}.png`, b64);
      setPhase("done");
    } catch (e) {
      console.error("echo-wrapped png export failed", e);
      setPhase("error");
    }
  }, [phase]);

  // ---- Poster-Layout (viewBox 0 0 360 640) -----------------------------
  const wordsTop = 322;
  const wordRowH = 44;
  const saveLabel =
    phase === "done"
      ? t("activity.exportDone")
      : phase === "error"
        ? t("activity.wrappedSaveError", "Export failed")
        : t("activity.wrappedSavePng", "Save PNG");

  return (
    <div className="wrapped-overlay" onClick={onClose}>
      <div
        className="wrapped-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Echo Wrapped"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="wrapped-close" onClick={onClose} aria-label={t("common.close", "Close")}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <div className="wrapped-eyebrow">Echo Wrapped</div>

        <div className="wrapped-poster">
          <svg
            ref={svgRef}
            xmlns="http://www.w3.org/2000/svg"
            width={POSTER_W}
            height={POSTER_H}
            viewBox={`0 0 ${POSTER_W} ${POSTER_H}`}
            role="img"
            aria-label="Echo Wrapped poster"
          >
            <defs>
              <linearGradient id="wrapped-bg" x1="0" y1="0" x2="0.12" y2="1">
                <stop offset="0" stopColor={GRAD_TOP} />
                <stop offset="0.52" stopColor={GRAD_MID} />
                <stop offset="1" stopColor={GRAD_BOT} />
              </linearGradient>
              <radialGradient id="wrapped-mesh1" cx="0.16" cy="0.08" r="0.6">
                <stop offset="0" stopColor={MESH1} />
                <stop offset="1" stopColor={MESH1} stopOpacity="0" />
              </radialGradient>
              <radialGradient id="wrapped-mesh2" cx="0.9" cy="0.14" r="0.55">
                <stop offset="0" stopColor={MESH2} />
                <stop offset="1" stopColor={MESH2} stopOpacity="0" />
              </radialGradient>
              <radialGradient id="wrapped-mesh3" cx="0.5" cy="1.04" r="0.7">
                <stop offset="0" stopColor={MESH3} />
                <stop offset="1" stopColor={MESH3} stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* Hintergrund: page-grad + Aurora-Mesh, damit der PNG-Export
                selbstständig „Echo" liest (CSS-::before wird nicht mit
                exportiert). */}
            <rect width={POSTER_W} height={POSTER_H} fill="url(#wrapped-bg)" />
            <rect width={POSTER_W} height={POSTER_H} fill="url(#wrapped-mesh1)" />
            <rect width={POSTER_W} height={POSTER_H} fill="url(#wrapped-mesh2)" />
            <rect width={POSTER_W} height={POSTER_H} fill="url(#wrapped-mesh3)" />

            <g fontFamily={FONT_STACK}>
              {/* Kopf */}
              <text
                x={POSTER_W / 2}
                y={58}
                textAnchor="middle"
                fill={CYAN_INK}
                fontSize={11}
                fontWeight={700}
                letterSpacing="0.18em"
              >
                {"ECHO WRAPPED"}
              </text>
              <text
                x={POSTER_W / 2}
                y={78}
                textAnchor="middle"
                fill={INK3}
                fontSize={10}
                fontWeight={500}
              >
                {dateLine}
              </text>

              {/* Hero: Wörter gesamt */}
              <text
                x={POSTER_W / 2}
                y={158}
                textAnchor="middle"
                fill={INK}
                fontSize={heroFontSize(heroText)}
                fontWeight={800}
              >
                {heroText}
              </text>
              <text
                x={POSTER_W / 2}
                y={182}
                textAnchor="middle"
                fill={INK2}
                fontSize={10.5}
                fontWeight={600}
                letterSpacing="0.1em"
              >
                {t("activity.statWords").toLocaleUpperCase(lang)}
              </text>

              {/* Stat-Reihe: Diktate · Zeit gespart · Streak */}
              {statCols.map((s, i) => {
                const cx = 60 + i * 120;
                return (
                  <g key={s.label}>
                    <text
                      x={cx}
                      y={238}
                      textAnchor="middle"
                      fill={INK}
                      fontSize={17}
                      fontWeight={700}
                    >
                      {s.value}
                    </text>
                    <text
                      x={cx}
                      y={256}
                      textAnchor="middle"
                      fill={INK2}
                      fontSize={8.5}
                      fontWeight={600}
                      letterSpacing="0.08em"
                    >
                      {s.label.toLocaleUpperCase(lang)}
                    </text>
                  </g>
                );
              })}

              <line x1={24} y1={282} x2={POSTER_W - 24} y2={282} stroke={CYAN} strokeOpacity={0.22} />

              {/* Top-Wörter */}
              <text
                x={24}
                y={308}
                fill={CYAN_INK}
                fontSize={11}
                fontWeight={700}
                letterSpacing="0.14em"
              >
                {t("activity.topWords").toLocaleUpperCase(lang)}
              </text>

              {words.length === 0 ? (
                <text x={24} y={wordsTop + 18} fill={INK3} fontSize={12} fontWeight={500}>
                  {t("activity.wordCloudEmpty")}
                </text>
              ) : (
                words.map((w, i) => {
                  const rowTop = wordsTop + i * wordRowH;
                  const barMax = POSTER_W - 48;
                  const barW = Math.max(6, (w.count / maxCount) * barMax);
                  return (
                    <g key={`${w.word}-${i}`}>
                      <text x={24} y={rowTop + 16} fill={INK3} fontSize={11} fontWeight={600}>
                        {String(i + 1).padStart(2, "0")}
                      </text>
                      <text x={48} y={rowTop + 17} fill={INK} fontSize={15} fontWeight={600}>
                        {truncateWord(w.word)}
                      </text>
                      <text
                        x={POSTER_W - 24}
                        y={rowTop + 16}
                        textAnchor="end"
                        fill={INK2}
                        fontSize={11}
                        fontWeight={600}
                      >
                        {w.count.toLocaleString(lang)}
                      </text>
                      <rect
                        x={24}
                        y={rowTop + 26}
                        width={barW}
                        height={3}
                        rx={1.5}
                        fill={CYAN}
                        opacity={0.85 - i * 0.1}
                      />
                    </g>
                  );
                })
              )}

              {/* Fußzeile */}
              <line
                x1={24}
                y1={POSTER_H - 44}
                x2={POSTER_W - 24}
                y2={POSTER_H - 44}
                stroke={INK3}
                strokeOpacity={0.25}
              />
              <text
                x={24}
                y={POSTER_H - 22}
                fill={INK}
                fontSize={12}
                fontWeight={700}
                letterSpacing="0.06em"
              >
                {"Echo"}
              </text>
              <text
                x={POSTER_W - 24}
                y={POSTER_H - 22}
                textAnchor="end"
                fill={INK3}
                fontSize={9.5}
                fontWeight={500}
                letterSpacing="0.08em"
              >
                {"echo.subunit.ai"}
              </text>
            </g>
          </svg>
        </div>

        <div className="wrapped-actions">
          <button
            className="act-btn primary"
            onClick={savePng}
            disabled={phase === "saving"}
            aria-busy={phase === "saving"}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="m7 10 5 5 5-5" />
              <path d="M12 15V3" />
            </svg>
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
