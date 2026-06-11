/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import { useMeeting } from "../store";
import { renderDeepDive, renderTranscript, ddInline, applySpeakerMap } from "../lib/markdown";
import { escapeHtml, fmtDate, normKey, prettyName } from "../lib/format";
import { RecapModal } from "../components/RecapModal";

/**
 * ENDED / RESULTS — 1:1 port of `#s-ended`: processing (wave + stage ticker) → segmented
 * Zusammenfassung↔Transkript, protocol-language switch, speaker assignment, drill-down,
 * recap, intel, copy/download/PDF. Interactivity on the rendered HTML uses React event
 * delegation (onClick/onChange on the container) instead of the vanilla DOM listeners.
 */
export function Ended() {
  const { t } = useI18n();
  const m = useMeeting();
  const r = m.result;

  const [tab, setTab] = useState<"sum" | "tr">("sum");
  const [spkMap, setSpkMap] = useState<Record<string, string>>({});
  const [protoLang, setProtoLang] = useState("orig");
  const [protoMinutes, setProtoMinutes] = useState<string | null>(null);
  const [protoSpin, setProtoSpin] = useState("");
  const [recapOpen, setRecapOpen] = useState(false);
  const [recapParts, setRecapParts] = useState<any[]>([]);
  const [intelStatus, setIntelStatus] = useState("");
  const [drill, setDrill] = useState<any | null>(null);
  const resBodyRef = useRef<HTMLDivElement>(null);

  const explainMap = useMemo(() => {
    const map: Record<string, any> = {};
    (r?.explain || []).forEach((it: any) => {
      if (it && typeof it === "object" && it.text != null) map[normKey(it.text)] = it;
    });
    return map;
  }, [r]);

  const displayedMinutes = protoMinutes ?? r?.minutesMd ?? "";

  const bodyHtml = useMemo(() => {
    if (!r) return "";
    return tab === "sum"
      ? renderDeepDive(displayedMinutes)
      : renderTranscript(r.transcriptMd, { spkMap, spkPool: r.spkPool, deviceMode: r.deviceMode });
  }, [r, tab, displayedMinutes, spkMap]);

  // Mark deep-dive items that have an explanation as clickable (vanilla _markClickable).
  useEffect(() => {
    if (tab !== "sum") return;
    const el = resBodyRef.current;
    if (!el) return;
    el.querySelectorAll("[data-k]").forEach((n) => {
      const k = n.getAttribute("data-k");
      if (k && explainMap[k]) n.classList.add("dd-click");
    });
  }, [bodyHtml, explainMap, tab]);

  const onBodyClick = (e: React.MouseEvent) => {
    if (tab !== "sum") return;
    const el = (e.target as HTMLElement).closest(".dd-click") as HTMLElement | null;
    const k = el?.dataset.k;
    if (k && explainMap[k]) setDrill(explainMap[k]);
  };
  const onBodyChange = (e: React.ChangeEvent) => {
    const tgt = e.target as HTMLElement;
    if (tgt instanceof HTMLSelectElement && tgt.dataset.orig != null) {
      const orig = tgt.dataset.orig;
      const val = tgt.value;
      setSpkMap((prev) => {
        const next = { ...prev };
        if (val) next[orig] = val;
        else delete next[orig];
        return next;
      });
    }
  };

  const changeLang = async (lang: string) => {
    setProtoLang(lang);
    if (lang === "orig") {
      setProtoMinutes(null);
      return;
    }
    setProtoSpin("übersetze…");
    try {
      const md = await m.translateProtocol(lang);
      setProtoMinutes(md);
      setProtoSpin("");
    } catch {
      setProtoSpin("Übersetzung fehlgeschlagen");
      setProtoLang("orig");
      setProtoMinutes(null);
      setTimeout(() => setProtoSpin(""), 3500);
    }
  };

  const resultMd = () => {
    if (!r) return "";
    const md = (displayedMinutes ? "# Zusammenfassung\n\n" + displayedMinutes + "\n\n" : "") + "# Transkript\n\n" + r.transcriptMd;
    return applySpeakerMap(md, spkMap);
  };
  const copy = () => navigator.clipboard?.writeText(resultMd()).catch(() => {});
  const download = (text: string, suffix: string) => {
    const b = new Blob([text], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = "meeting-" + (m.code || "protokoll") + suffix + ".md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const exportPdf = () => {
    if (!r) return;
    const meta = r.meta || {};
    const head =
      '<div class="pdf-head"><div class="pdf-brand">Subunit <b>Meet</b></div>' +
      "<h1>" + escapeHtml(meta.title || "Meeting-Protokoll") + "</h1>" +
      '<div class="pdf-meta"><span>' + fmtDate(Math.floor(Date.now() / 1000)) + "</span>" +
      (meta.host_name ? "<span>· Host: " + escapeHtml(prettyName(meta.host_name)) + "</span>" : "") +
      "</div></div>";
    const body = displayedMinutes && displayedMinutes.trim() ? renderDeepDive(displayedMinutes) : '<p class="dd-empty">Keine Zusammenfassung verfügbar.</p>';
    const area = document.getElementById("print-area");
    if (area) {
      area.innerHTML = head + '<div class="pdf-body">' + body + "</div>" + '<div class="pdf-foot">Erstellt mit Subunit Meet · meet.subunit.ai</div>';
      setTimeout(() => window.print(), 60);
    }
  };
  const openRecap = async () => {
    setRecapParts(await m.recapParticipants());
    setRecapOpen(true);
  };
  const intel = async (action: string) => {
    const res = await m.runIntel(action);
    if (res.ok) setIntelStatus(action === "notion" ? "Notion-Seite wird angelegt — gleich in Notion sichtbar." : "Transkript wird ins u1-Gedächtnis aufgenommen.");
    else setIntelStatus(res.status === 403 ? "Nur für Operator-Accounts." : "Fehler " + res.status);
  };

  const home = () => {
    try {
      sessionStorage.removeItem("meetS");
    } catch {
      /* ignore */
    }
    m.leave();
  };

  return (
    <div className="wrap" id="s-ended">
      <button className="ended-back" onClick={home}>← {t("Zurück")}</button>
      <h1 className="ptitle" id="end-title">
        {m.endTitle}
      </h1>
      <p className="psub" id="end-sub">
        {m.endSub}
      </p>
      {m.endSpin && (
        <div className="wave" id="end-spin" role="status" aria-label="Verarbeitung läuft">
          <span></span><span></span><span></span><span></span><span></span><span></span><span></span>
        </div>
      )}
      {m.stageText && (
        <div className="stage" id="end-stage">
          {m.stageText}
        </div>
      )}

      {r && (
        <div id="end-result">
          <div className={"seg" + (tab === "tr" ? " tr" : "")} id="res-seg">
            <button className={"seg-btn" + (tab === "sum" ? " active" : "")} onClick={() => setTab("sum")}>
              {t("Zusammenfassung")}
            </button>
            <button className={"seg-btn" + (tab === "tr" ? " active" : "")} onClick={() => setTab("tr")}>
              {t("Transkript")}
            </button>
            <span className="seg-ind"></span>
          </div>

          <div className="protolang">
            <span className="protolang-lb">📄 {t("Protokoll-Sprache")}</span>
            <select className="protolang-sel" value={protoLang} onChange={(e) => changeLang(e.target.value)}>
              <option value="orig">{t("Original-Sprache")}</option>
              <option value="de">{t("Deutsch")}</option>
              <option value="en">{t("Englisch")}</option>
              <option value="es">{t("Spanisch")}</option>
              <option value="fr">{t("Französisch")}</option>
              <option value="it">{t("Italienisch")}</option>
            </select>
            {protoSpin && <span className="protolang-spin">{protoSpin}</span>}
          </div>

          <div ref={resBodyRef} id="res-body" className="dd" onClick={onBodyClick} onChange={onBodyChange} dangerouslySetInnerHTML={{ __html: bodyHtml }} />

          {r.bezugMd && (
            <div className="bezug">
              <div className="bezug-h">🧠 Bezug zu Früherem · nur intern</div>
              <div dangerouslySetInnerHTML={{ __html: renderDeepDive(r.bezugMd) }} />
            </div>
          )}

          <div className="actbar">
            <IconBtn label={t("Kopieren")} flash="Kopiert ✓" onClick={copy} title="Kopieren">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </IconBtn>
            <IconBtn label={t("Download")} flash="Geladen ✓" onClick={() => download(resultMd(), "")} title="Download">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" x2="12" y1="15" y2="3" />
            </IconBtn>
            <IconBtn label={t("Transkript")} flash="Transkript ✓" onClick={() => download(applySpeakerMap(r.transcriptMd, spkMap), "-transkript")} title="Roh-Transkript herunterladen">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" x2="16" y1="13" y2="13" />
              <line x1="8" x2="16" y1="17" y2="17" />
              <line x1="10" x2="11" y1="9" y2="9" />
            </IconBtn>
            <IconBtn label={t("PDF")} flash="PDF…" onClick={exportPdf} title="Als PDF drucken">
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" rx="1" />
            </IconBtn>
            {m.canRecap && (
              <IconBtn label={t("An Teilnehmer")} onClick={openRecap} title="Protokoll an Teilnehmer senden">
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22l-4-9-9-4Z" />
              </IconBtn>
            )}
            {m.canIntel && (
              <>
                <IconBtn label={t("Gedächtnis")} flash="Gespeichert ✓" onClick={() => intel("chroma")} title="In u1-Gedächtnis">
                  <path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z" />
                </IconBtn>
                <IconBtn
                  label={t("Notion")}
                  flash="Notion ✓"
                  onClick={() => intel("notion")}
                  title="Notion"
                  icon={<img src="/notion.svg" alt="" style={{ height: 22, display: "block" }} />}
                />
              </>
            )}
          </div>
          <div className="hint" id="intel-status">
            {intelStatus}
          </div>
        </div>
      )}

      <button className="btn btn-ghost" onClick={home}>
        {t("Zur Startseite")}
      </button>

      {drill && <DrillDownModal item={drill} onClose={() => setDrill(null)} />}
      {recapOpen && <RecapModal participants={recapParts} onClose={() => setRecapOpen(false)} onSend={m.sendRecapTo} />}
    </div>
  );
}

/**
 * Action-bar icon button with the vanilla `flashIcon` feedback: after click the caption
 * swaps to `flash` for 1.7s and the `.done` class lights up. `icon` lets the Notion button
 * use its real <img> logo instead of an inline SVG.
 */
function IconBtn({
  label,
  flash,
  onClick,
  title,
  children,
  icon,
}: {
  label: string;
  flash?: string;
  onClick: () => void;
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  const [flashed, setFlashed] = useState<string | null>(null);
  const click = () => {
    onClick();
    if (flash) {
      setFlashed(flash);
      window.setTimeout(() => setFlashed(null), 1700);
    }
  };
  return (
    <button className={"iconbtn" + (flashed ? " done" : "")} onClick={click} title={title}>
      <span className="ic">{icon || <svg viewBox="0 0 24 24">{children}</svg>}</span>
      <span className="cap">{flashed || label}</span>
    </button>
  );
}

/** Drill-down explanation modal — 1:1 port of `#dd-modal` + openDD. */
function DrillDownModal({ item, onClose }: { item: any; onClose: () => void }) {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const excerpt = String(item.excerpt == null ? "" : item.excerpt).trim();
  const explanation = String(item.explanation == null ? "" : item.explanation).trim() || "Keine weitere Erklärung verfügbar.";
  return (
    <div id="dd-modal" className="ddm">
      <div className="ddm-bg" onClick={onClose}></div>
      <div className="ddm-card" role="dialog" aria-modal="true">
        <button className="ddm-x" onClick={onClose} aria-label="Schließen">
          ✕
        </button>
        <div className="ddm-title" dangerouslySetInnerHTML={{ __html: ddInline(String(item.text == null ? "" : item.text)) }} />
        {excerpt && (
          <div className="ddm-sec">
            <div className="ddm-h">Im Meeting gesagt</div>
            <blockquote className="ddm-excerpt">{excerpt}</blockquote>
          </div>
        )}
        <div className="ddm-sec">
          <div className="ddm-h">Erklärung</div>
          <div className="ddm-explanation" dangerouslySetInnerHTML={{ __html: ddInline(explanation) }} />
        </div>
      </div>
    </div>
  );
}
