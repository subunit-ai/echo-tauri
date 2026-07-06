import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Avatar } from "./Avatar";
import { useConfig } from "../state/ConfigContext";

export type Section =
  | "home"
  | "notes"
  | "history"
  | "meetings"
  | "vocabulary"
  | "settings"
  | "help";

/* Saubere Stroke-Icons statt Glyphen/Emojis (Enterprise-Look, TJ 2026-06-12).
   Einheitlich: 24er viewBox, stroke=currentColor, Breite 2 — erbt die nav-btn-Farbe. */
function Icon({ d, extra }: { d: string; extra?: ReactNode }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
      {extra}
    </svg>
  );
}

const ICONS: Record<Section, ReactNode> = {
  home: <Icon d="M3 11.2 12 3l9 8.2M5.3 9.8V21h13.4V9.8" />,
  // Notizen: Dokument mit Eselsohr + Textzeilen (voice-first Notiz-Ablage)
  notes: <Icon d="M7 3h7l4 4v12.5A1.5 1.5 0 0 1 16.5 21h-9A1.5 1.5 0 0 1 6 19.5V4.5A1.5 1.5 0 0 1 7.5 3ZM14 3v4h4M9 12.5h6M9 16h4" />,
  history: <Icon d="M12 7v5l3 2" extra={<circle cx="12" cy="12" r="9" />} />,
  // Meeting = Offline- + Live-Meeting unter einem Tab (Broadcast-Wellen um einen Punkt)
  meetings: (
    <Icon
      d="M8.4 8.4a5.1 5.1 0 0 0 0 7.2M15.6 8.4a5.1 5.1 0 0 1 0 7.2M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 5.5a9.2 9.2 0 0 1 0 13"
      extra={<circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />}
    />
  ),
  vocabulary: <Icon d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />,
  settings: <Icon d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4" />,
  help: (
    <Icon
      d="M9.2 9a3 3 0 0 1 5.8 1c0 2-3 2.6-3 4.4M12 17.6h.01"
      extra={<circle cx="12" cy="12" r="9" />}
    />
  ),
};

const ITEMS: { key: Section; labelKey: string; pro?: boolean }[] = [
  { key: "home", labelKey: "nav.home" },
  { key: "notes", labelKey: "nav.notes" },
  { key: "history", labelKey: "nav.history" },
  { key: "meetings", labelKey: "nav.meetings" },
  { key: "vocabulary", labelKey: "nav.vocabulary" },
  { key: "settings", labelKey: "nav.settings" },
  { key: "help", labelKey: "nav.help" },
];

// Horizontaler Zoom-Anker der Linse = Icon-Zentrum einer Zeile: nav-btn hat
// padding-left 12px + Glyph-Breite 18/2 = 9 → 21px vom Zeilenanfang.
const LENS_ORIGIN_X = "21px";

export function Sidebar({
  active,
  onSelect,
  onAccount,
}: {
  active: Section;
  onSelect: (s: Section) => void;
  /** Open the account area (Settings → Account tab). */
  onAccount: () => void;
}) {
  const { t } = useTranslation();
  const { config } = useConfig();

  // --- Gleitender Liquid-Glass-Slider (Apple-Prinzip, aus SCAI portiert): EINE
  // Glas-Pille liegt auf dem aktiven Eintrag und FÄHRT beim Wechsel smooth zur
  // neuen Position. Gemessen wird der echte Button (offsetTop/Height relativ zum
  // .nav-list-Wrapper) statt Zeilengeometrie zu raten; useLayoutEffect
  // positioniert vor dem Paint (kein First-Frame-Flash).
  const btnRefs = useRef<Partial<Record<Section, HTMLButtonElement | null>>>({});
  const [ind, setInd] = useState<{ top: number; h: number; on: boolean }>({ top: 0, h: 0, on: false });
  const measure = () => {
    const btn = btnRefs.current[active];
    setInd((p) => (btn ? { top: btn.offsetTop, h: btn.offsetHeight, on: true } : { ...p, on: false }));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(measure, [active, t]);

  // --- Drag (Apple-Liquid-Glass-Verhalten): die Pille lässt sich greifen und
  // ziehen; sie folgt dem Zeiger 1:1 (Rubber-Band jenseits der Liste, Magnet
  // nahe Zeilenmitten) und rastet beim Loslassen auf dem nächstgelegenen Eintrag
  // ein. Während des Drags KEIN React-Re-Render: Pille + Linsen-Kopien werden
  // direkt per style mutiert (dragRef), erst der Drop committet via setInd/onSelect.
  const indRef = useRef<HTMLSpanElement | null>(null);
  const dragRef = useRef<{ startY: number; startTop: number; lastTop: number; moved: boolean } | null>(null);
  // Beim Ziehen verliert die URSPRUNGSZEILE ihr Aktiv-Styling (active bleibt bis
  // zum Drop unverändert — ohne das bliebe sie akzentfarben, obwohl das Glas
  // längst woanders ist). Aktiv-Look lebt im Drag NUR in der Linse. Genau EIN
  // Re-Render bei Drag-Start/-Ende, keins pro Frame.
  const [dragging, setDragging] = useState(false);

  const rows = () => Object.values(btnRefs.current).filter(Boolean) as HTMLButtonElement[];

  // Pille und Linsen-Kopien fahren IMMER gegenläufig synchron — nur so bleibt der
  // Glas-Ausschnitt deckungsgleich mit dem echten Inhalt darunter (alle 3 Dome-Bänder).
  const setPillY = (top: number) => {
    if (!indRef.current) return;
    indRef.current.style.transform = `translateY(${top}px)`;
    indRef.current.querySelectorAll<HTMLElement>(".snav-lens-copy").forEach((el) => {
      el.style.transform = `translateY(${-top}px)`;
    });
  };
  const onPillDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!ind.on || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startTop: ind.top, lastTop: ind.top, moved: false };
  };
  const onPillMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dy) < 3) return; // Klick-Toleranz
    if (!d.moved) {
      d.moved = true;
      indRef.current?.classList.add("is-drag");
      setDragging(true); // ind unverändert → React lässt den gedraggten Inline-Style stehen
    }
    let top = d.startTop + dy;
    const btns = rows();
    if (btns.length > 0) {
      const min = Math.min(...btns.map((b) => b.offsetTop));
      const max = Math.max(...btns.map((b) => b.offsetTop + b.offsetHeight)) - ind.h;
      if (top < min) top = min - (min - top) / 3; // Rubber-Band oben
      if (top > max) top = max + (top - max) / 3; // Rubber-Band unten
      // Magnet: nahe einer Zeilenmitte zieht die Pille sanft dorthin.
      const center = top + ind.h / 2;
      for (const b of btns) {
        const c = b.offsetTop + b.offsetHeight / 2;
        if (Math.abs(c - center) < 6) {
          top = top + (b.offsetTop - top) * 0.5;
          break;
        }
      }
    }
    d.lastTop = top;
    setPillY(top);
  };
  const onPillUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    indRef.current?.classList.remove("is-drag");
    setDragging(false);
    if (!d?.moved) return;
    // Nächstgelegene Zeile (Mitte zu Mitte) — dorthin springen und committen.
    const center = d.lastTop + ind.h / 2;
    let best: { key: Section; top: number; h: number; dist: number } | null = null;
    for (const [key, el] of Object.entries(btnRefs.current) as [Section, HTMLButtonElement | null][]) {
      if (!el) continue;
      const dist = Math.abs(el.offsetTop + el.offsetHeight / 2 - center);
      if (!best || dist < best.dist) best = { key, top: el.offsetTop, h: el.offsetHeight, dist };
    }
    if (!best) return setPillY(ind.top);
    // Direkt-Style setzen (nicht nur State): landet der Drag auf derselben Zeile,
    // ändert sich das VDOM nicht und React würde den gedraggten Style nie zurücksetzen.
    setPillY(best.top);
    setInd({ top: best.top, h: best.h, on: true });
    if (best.key !== active) onSelect(best.key);
  };
  const onPillCancel = () => {
    dragRef.current = null;
    indRef.current?.classList.remove("is-drag");
    setDragging(false);
    setPillY(ind.top); // zurück zum aktiven Eintrag
  };

  // lens=true rendert die identische Zeile als NICHT-interaktive Kopie für die
  // Glas-Linse: immer im Aktiv-Look, keine Refs (btnRefs darf nur echte Buttons
  // halten), kein onClick, aus dem Tab-Fluss. Als plain-Funktion (kein
  // React-Komponenten-Boundary) → die echten Buttons remounten nicht pro Render,
  // Refs bleiben stabil.
  const renderRow = (it: (typeof ITEMS)[number], lens: boolean) => {
    // Im Drag ist KEINE echte Zeile aktiv gestylt — der Aktiv-Look scheint nur
    // durch die Linse (nur was hinterm Glas liegt, trägt Akzent).
    const isActive = lens || (!dragging && it.key === active);
    return (
      <button
        key={it.key}
        ref={lens ? undefined : (el) => { btnRefs.current[it.key] = el; }}
        className={`nav-btn ${isActive ? "active" : ""}`}
        onClick={lens ? undefined : () => onSelect(it.key)}
        tabIndex={lens ? -1 : undefined}
      >
        <span className="glyph" aria-hidden>
          {ICONS[it.key]}
        </span>
        {t(it.labelKey)}
        {it.pro && <span className="tier-badge nav-pro">Pro</span>}
      </button>
    );
  };

  return (
    <nav className="sidebar">
      {/* relativer Wrapper: Mess-Bezug für die Pille; der Konto-Fuß bleibt direktes
          .sidebar-Kind (unten fixiert) und liegt außerhalb. */}
      <div className="nav-list">
        {ITEMS.map((it) => renderRow(it, false))}

        {/* Liquid-Glass-Pille: liegt ÜBER den Zeilen (z-index), ist greif- und
            ziehbar; innen die Linse = geclippte, leicht vergrößerte Kopie der
            Nav, die gegenläufig mitfährt → Inhalt „zoomt durchs Glas". WICHTIG:
            im DOM NACH den echten Buttons — Text-Queries treffen so zuerst die
            echten Zeilen. */}
        <span
          ref={indRef}
          className="snav-ind"
          aria-hidden
          style={{
            transform: `translateY(${ind.top}px)`,
            height: ind.h,
            opacity: ind.on ? 1 : 0,
            pointerEvents: ind.on ? undefined : "none",
          }}
          onPointerDown={onPillDown}
          onPointerMove={onPillMove}
          onPointerUp={onPillUp}
          onPointerCancel={onPillCancel}
        >
          <span className="snav-lens">
            {/* Dome-Linse: 3 stetig ineinander übergehende Bänder — Mitte
                vergrößert am stärksten, Randbänder komprimieren zur Glaskante
                (Schrift „biegt" sich beim Durchgleiten). Zoom-Anker horizontal
                am Icon (Zeilen-Fluchtpunkt). */}
            {(["top", "mid", "bot"] as const).map((band) => (
              <span key={band} className={`snav-lens-clip snav-lens-clip--${band}`}>
                <span className={`snav-lens-band snav-lens-band--${band}`} style={{ transformOrigin: `${LENS_ORIGIN_X} 0` }}>
                  <div className="snav-lens-copy" style={{ transform: `translateY(${-ind.top}px)` }}>
                    <div className="nav-list">
                      {ITEMS.map((it) => renderRow(it, true))}
                    </div>
                  </div>
                </span>
              </span>
            ))}
          </span>
        </span>
      </div>

      <AccountCard config={config} onClick={onAccount} />
    </nav>
  );
}

/** Bottom-left account card: initials avatar + nickname (falls back to name, then
 *  the email local part). The secondary line shows the PLAN (Free/Test/Pro) when
 *  signed in — the email lived here before but was usually truncated and noisy
 *  (it's still in Settings → Account). The whole card is one button that jumps
 *  into Settings → Account. Pinned to the sidebar's bottom (see .side-account). */
function AccountCard({
  config,
  onClick,
}: {
  config: ReturnType<typeof useConfig>["config"];
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const nickname = config?.nickname?.trim() || "";
  const name = config?.display_name?.trim() || "";
  const email = config?.account_email?.trim() || "";
  const emailLocal = email ? email.split("@")[0] : "";
  const loggedIn = !!email;
  const plan = config?.plan ?? "free";

  const primary = nickname || name || emailLocal || t("account.guest");

  return (
    <button className="side-account" onClick={onClick} title={t("account.openSettings")}>
      <Avatar name={nickname || name || email} size={40} />
      <span className="sa-meta">
        <span className="sa-name">{primary}</span>
        <span className="sa-sub">
          {loggedIn ? (
            <span className={`sa-plan sa-plan--${plan}`}>{t(`header.plan.${plan}`)}</span>
          ) : (
            t("account.notSignedIn")
          )}
        </span>
      </span>
      <svg className="sa-gear" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9 18l6-6-6-6" />
      </svg>
    </button>
  );
}
