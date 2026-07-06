/* eslint-disable @typescript-eslint/no-explicit-any */
// Cloud-Meeting — Ergebnis/Recap (nativer Echo-Port von meet-ui/screens/Ended.tsx).
// Presentation-only: die komplette Logik (Store-Bindings, useMemo bodyHtml, Clickable-
// Marking, changeLang, resultMd/copy/download/exportPdf, recap, intel, home) kommt
// VERBATIM aus dem geteilten Store (@meet/store) + den frozen Renderern (@meet/lib/*).
// Nur Markup/Klassen sind neu (mc-*). Kein Emoji (Enterprise-UI): jedes Symbol ist ein
// Stroke-SVG. Der frozen Renderer/Store backt Emojis ein → stripEmoji beim Rendern.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMeeting } from "@meet/store";
import { renderDeepDive, renderTranscript, ddInline, applySpeakerMap } from "@meet/lib/markdown";
import { escapeHtml, fmtDate, normKey, prettyName } from "@meet/lib/format";
import { StrokeIcon, LETTER_PATHS, SPARKLES_PATHS } from "../../components/icons";

/** Emoji/Glyph-Wäsche für Renderer- + Store-Strings, die wir nicht editieren dürfen. */
const stripEmoji = (s: string) =>
  s
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/**
 * ENDED / RESULTS — nativer Port von `#s-ended`: Processing (Wave + Stage-Ticker) →
 * segmentiert Zusammenfassung↔Transkript, Protokoll-Sprachwechsel, Sprecher-Zuordnung,
 * Drill-down, Recap, Intel, Copy/Download/PDF. Interaktivität auf dem gerenderten HTML
 * läuft über React-Event-Delegation (onClick/onChange am Container).
 */
export function CloudEnded() {
  const { t } = useTranslation();
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
    const html =
      tab === "sum"
        ? renderDeepDive(displayedMinutes)
        : renderTranscript(r.transcriptMd, { spkMap, spkPool: r.spkPool, deviceMode: r.deviceMode });
    return stripEmoji(html);
  }, [r, tab, displayedMinutes, spkMap]);

  // Deep-dive-Items mit Erklärung als klickbar markieren (vanilla _markClickable).
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
    const md =
      (displayedMinutes ? "# Zusammenfassung\n\n" + displayedMinutes + "\n\n" : "") + "# Transkript\n\n" + r.transcriptMd;
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
    const body =
      displayedMinutes && displayedMinutes.trim()
        ? renderDeepDive(displayedMinutes)
        : '<p class="dd-empty">Keine Zusammenfassung verfügbar.</p>';
    const area = document.getElementById("print-area");
    if (area) {
      area.innerHTML =
        head + '<div class="pdf-body">' + body + "</div>" + '<div class="pdf-foot">Erstellt mit Subunit Meet · meet.subunit.ai</div>';
      setTimeout(() => window.print(), 60);
    }
  };
  const openRecap = async () => {
    setRecapParts(await m.recapParticipants());
    setRecapOpen(true);
  };
  const intel = async (action: string) => {
    const res = await m.runIntel(action);
    if (res.ok)
      setIntelStatus(
        action === "notion"
          ? "Notion-Seite wird angelegt — gleich in Notion sichtbar."
          : "Transkript wird ins u1-Gedächtnis aufgenommen.",
      );
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
    <div className="mc-wrap" id="s-ended">
      <button className="sub-tab" onClick={home} style={{ alignSelf: "flex-start", marginBottom: 6 }}>
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ verticalAlign: "-2px", marginRight: 6 }}
        >
          <path d="M15 6l-6 6 6 6" />
        </svg>
        {t("meet.cloudended.back", "Zurück")}
      </button>

      <h1 className="section-title">{m.endTitle}</h1>
      <p className="section-sub">{m.endSub}</p>

      {m.endSpin && (
        <div className="mc-proc" role="status" aria-label="Verarbeitung läuft">
          <div className="mc-wave">
            <span></span>
            <span></span>
            <span></span>
            <span></span>
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      )}
      {m.stageText && <div className="mc-stage">{stripEmoji(m.stageText)}</div>}

      {r && (
        <div id="end-result">
          <div className="mc-seg">
            <button className={"sub-tab" + (tab === "sum" ? " active" : "")} onClick={() => setTab("sum")}>
              {t("meet.cloudended.tabSummary", "Zusammenfassung")}
            </button>
            <button className={"sub-tab" + (tab === "tr" ? " active" : "")} onClick={() => setTab("tr")}>
              {t("meet.cloudended.tabTranscript", "Transkript")}
            </button>
          </div>

          <div className="mc-protolang">
            <span className="mc-protolang-lb">
              <StrokeIcon paths={LETTER_PATHS} size={15} />
              {t("meet.cloudended.protoLang", "Protokoll-Sprache")}
            </span>
            <select value={protoLang} onChange={(e) => changeLang(e.target.value)}>
              <option value="orig">{t("meet.cloudended.langOrig", "Original-Sprache")}</option>
              <option value="de">{t("meet.cloudended.langDe", "Deutsch")}</option>
              <option value="en">{t("meet.cloudended.langEn", "Englisch")}</option>
              <option value="es">{t("meet.cloudended.langEs", "Spanisch")}</option>
              <option value="fr">{t("meet.cloudended.langFr", "Französisch")}</option>
              <option value="it">{t("meet.cloudended.langIt", "Italienisch")}</option>
            </select>
            {protoSpin && <span className="mc-protolang-spin">{protoSpin}</span>}
          </div>

          <div
            ref={resBodyRef}
            className="mc-prose"
            onClick={onBodyClick}
            onChange={onBodyChange}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />

          {r.bezugMd && (
            <div className="bezug">
              <div className="bezug-h">
                <StrokeIcon paths={SPARKLES_PATHS} size={15} />
                {t("meet.cloudended.bezugHeader", "Bezug zu Früherem · nur intern")}
              </div>
              <div dangerouslySetInnerHTML={{ __html: stripEmoji(renderDeepDive(r.bezugMd)) }} />
            </div>
          )}

          <div className="mc-actionbar">
            <IconBtn label={t("meet.cloudended.copy", "Kopieren")} flash={t("meet.cloudended.copied", "Kopiert")} onClick={copy} title={t("meet.cloudended.copy", "Kopieren")}>
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </IconBtn>
            <IconBtn
              label={t("meet.cloudended.download", "Download")}
              flash={t("meet.cloudended.downloaded", "Geladen")}
              onClick={() => download(resultMd(), "")}
              title={t("meet.cloudended.download", "Download")}
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" x2="12" y1="15" y2="3" />
            </IconBtn>
            <IconBtn
              label={t("meet.cloudended.transcript", "Transkript")}
              flash={t("meet.cloudended.transcriptDone", "Transkript")}
              onClick={() => download(applySpeakerMap(r.transcriptMd, spkMap), "-transkript")}
              title={t("meet.cloudended.transcriptTitle", "Roh-Transkript herunterladen")}
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" x2="16" y1="13" y2="13" />
              <line x1="8" x2="16" y1="17" y2="17" />
              <line x1="10" x2="11" y1="9" y2="9" />
            </IconBtn>
            <IconBtn
              label={t("meet.cloudended.pdf", "PDF")}
              flash={t("meet.cloudended.pdfFlash", "PDF…")}
              onClick={exportPdf}
              title={t("meet.cloudended.pdfTitle", "Als PDF drucken")}
            >
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" rx="1" />
            </IconBtn>
            {m.canRecap && (
              <IconBtn
                label={t("meet.cloudended.toParticipants", "An Teilnehmer")}
                onClick={openRecap}
                title={t("meet.cloudended.toParticipantsTitle", "Protokoll an Teilnehmer senden")}
              >
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22l-4-9-9-4Z" />
              </IconBtn>
            )}
            {m.canIntel && (
              <>
                <IconBtn
                  label={t("meet.cloudended.memory", "Gedächtnis")}
                  flash={t("meet.cloudended.memorySaved", "Gespeichert")}
                  onClick={() => intel("chroma")}
                  title={t("meet.cloudended.memoryTitle", "In u1-Gedächtnis")}
                >
                  <path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z" />
                </IconBtn>
                <IconBtn
                  label={t("meet.cloudended.notion", "Notion")}
                  flash={t("meet.cloudended.notionFlash", "Notion")}
                  onClick={() => intel("notion")}
                  title="Notion"
                  icon={<img src="/notion.svg" alt="" />}
                />
              </>
            )}
          </div>
          <div className="mc-hint">{intelStatus}</div>
        </div>
      )}

      <button className="sub-tab" onClick={home}>
        {t("meet.cloudended.home", "Zur Startseite")}
      </button>

      {drill && <DrillDownModal item={drill} onClose={() => setDrill(null)} />}
      {recapOpen && <RecapModal participants={recapParts} onClose={() => setRecapOpen(false)} onSend={m.sendRecapTo} />}
    </div>
  );
}

/**
 * Action-bar-Icon-Button mit dem vanilla `flashIcon`-Feedback: nach dem Klick wechselt
 * die Caption für 1,7 s auf `flash` und die `.done`-Klasse leuchtet. `icon` lässt den
 * Notion-Button sein echtes <img>-Logo statt eines inline-SVG nutzen.
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
    <button className={flashed ? "done" : undefined} onClick={click} title={title}>
      <span className="mc-ab-ic">{icon || <svg viewBox="0 0 24 24">{children}</svg>}</span>
      <span className="mc-ab-cap">{flashed || label}</span>
    </button>
  );
}

/** Drill-down-Erklärungs-Modal — nativer Port von `#dd-modal` + openDD. */
function DrillDownModal({ item, onClose }: { item: any; onClose: () => void }) {
  const { t } = useTranslation();
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
  const explanation =
    String(item.explanation == null ? "" : item.explanation).trim() ||
    t("meet.cloudended.ddNoExpl", "Keine weitere Erklärung verfügbar.");
  return (
    <div className="mc-ddm-ov">
      <div className="mc-ddm-bg" onClick={onClose} style={{ position: "absolute", inset: 0 }}></div>
      <div className="mc-ddm" role="dialog" aria-modal="true">
        <button className="mc-ddm-x" onClick={onClose} aria-label={t("meet.cloudended.close", "Schließen")}>
          <svg viewBox="0 0 24 24">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <div className="mc-ddm-title" dangerouslySetInnerHTML={{ __html: ddInline(stripEmoji(String(item.text == null ? "" : item.text))) }} />
        {excerpt && (
          <div className="mc-ddm-sec">
            <div className="mc-ddm-h">{t("meet.cloudended.ddSaid", "Im Meeting gesagt")}</div>
            <blockquote className="mc-ddm-excerpt">{excerpt}</blockquote>
          </div>
        )}
        <div className="mc-ddm-sec">
          <div className="mc-ddm-h">{t("meet.cloudended.ddExplanation", "Erklärung")}</div>
          <div className="mc-ddm-explanation" dangerouslySetInnerHTML={{ __html: ddInline(explanation) }} />
        </div>
      </div>
    </div>
  );
}

interface RecapRow {
  token: string;
  name: string;
  isHost: boolean;
  checked: boolean;
  mail: string;
  lang: string;
}

/**
 * Recap-Empfänger-Panel — nativer Port von openRecapPanel/doSendRecap (`#recap-ov`).
 * Empfänger + Protokoll-Sprache je Person wählen, dann via Store-`sendRecapTo` senden
 * (das die nötigen Sprachen zuerst übersetzt). Row-Reducer + send() sind verbatim.
 */
function RecapModal({
  participants,
  onClose,
  onSend,
}: {
  participants: any[];
  onClose: () => void;
  onSend: (recipients: { token: string; email: string; lang: string }[]) => Promise<{ ok: boolean; sent?: number; error?: string }>;
}) {
  const { t } = useTranslation();
  const LANGOPTS: [string, string][] = [
    ["orig", t("meet.cloudended.langOrig", "Original-Sprache")],
    ["de", t("meet.cloudended.langDe", "Deutsch")],
    ["en", t("meet.cloudended.langEn", "Englisch")],
    ["es", t("meet.cloudended.langEs", "Spanisch")],
    ["fr", t("meet.cloudended.langFr", "Französisch")],
    ["it", t("meet.cloudended.langIt", "Italienisch")],
  ];
  const [rows, setRows] = useState<RecapRow[]>(() =>
    participants.map((p) => {
      const isHost = p.source === "host";
      const ul = (p.ui_lang || "").toLowerCase();
      const lang = LANGOPTS.some((o) => o[0] === ul) ? ul : "orig";
      return { token: p.token || "", name: p.name || "—", isHost, checked: !!(p.email || isHost), mail: p.email || "", lang };
    }),
  );
  const [err, setErr] = useState("");
  const [sending, setSending] = useState("");

  const patch = (i: number, p: Partial<RecapRow>) => setRows((rs) => rs.map((row, j) => (j === i ? { ...row, ...p } : row)));

  const send = async () => {
    const recipients: { token: string; email: string; lang: string }[] = [];
    let bad = "";
    for (const row of rows) {
      if (!row.checked) continue;
      const mail = (row.mail || "").trim();
      if (!mail || !mail.includes("@")) {
        bad = bad || row.name;
        continue;
      }
      recipients.push({ token: row.token, email: mail, lang: row.lang });
    }
    if (bad) {
      setErr('Für „' + bad + '" fehlt eine gültige E-Mail (oder Häkchen entfernen).');
      return;
    }
    if (!recipients.length) {
      setErr("Mindestens einen Empfänger mit E-Mail auswählen.");
      return;
    }
    setErr("");
    setSending(t("meet.cloudended.recapSending", "Sende…"));
    const res = await onSend(recipients);
    if (res.ok) onClose();
    else {
      setSending("");
      setErr(res.error || "Senden fehlgeschlagen.");
    }
  };

  return (
    <div className="mc-recap-ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mc-recap">
        <h3 className="mc-recap-h">{t("meet.cloudended.recapTitle", "Protokoll senden an…")}</h3>
        <p className="mc-recap-sub">{t("meet.cloudended.recapSub", "Wähle die Empfänger. Fehlt eine E-Mail, kannst du sie hier eintragen.")}</p>
        <div className="mc-recap-list">
          {!rows.length && <div className="mc-recap-empty">{t("meet.cloudended.recapEmpty", "Keine freigegebenen Teilnehmer zum Senden.")}</div>}
          {rows.map((row, i) => (
            <div className="mc-recap-row" key={row.token || i}>
              <label className="mc-recap-tog">
                <input type="checkbox" checked={row.checked} onChange={(e) => patch(i, { checked: e.target.checked })} />
                <span className="mc-recap-slider"></span>
              </label>
              <div className="mc-recap-who">
                <div className="mc-recap-nm">
                  {row.name}
                  {row.isHost && <span className="mc-recap-badge">{t("meet.cloudended.recapHost", "Host")}</span>}
                </div>
                <input
                  type="email"
                  placeholder={t("meet.cloudended.recapMailPh", "E-Mail eintragen…")}
                  value={row.mail}
                  onChange={(e) => patch(i, { mail: e.target.value })}
                />
                <select value={row.lang} onChange={(e) => patch(i, { lang: e.target.value })}>
                  {LANGOPTS.map(([v, tx]) => (
                    <option key={v} value={v}>
                      {t("meet.cloudended.recapProtoPrefix", "Protokoll: ") + tx}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
        <div className="mc-recap-err">{err}</div>
        <div className="mc-recap-actions">
          <button className="sub-tab onb-primary" style={{ padding: "10px 18px", fontSize: 14 }} disabled={!!sending} onClick={send}>
            {sending || t("meet.cloudended.recapSend", "Senden")}
          </button>
          <button className="sub-tab" onClick={onClose}>
            {t("meet.cloudended.recapCancel", "Abbrechen")}
          </button>
        </div>
      </div>
    </div>
  );
}
