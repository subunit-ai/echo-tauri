import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { useMeeting } from "../store";

type Device = "multi" | "pod" | "single";

// Erfassungs-Kacheln: Titel, Kurzbeschreibung (unter der Kachel) + ausführliche Info (?-Overlay).
// Reihenfolge getauscht (TJ 2026-06-12): Ein Gerät ↔ Mehrere Geräte — ?-Infos wandern über den Key mit.
const DEVS: Device[] = ["single", "pod", "multi"];
const DEV_TT: Record<Device, string> = { multi: "Mehrere Geräte", pod: "Konferenzmikrofon", single: "Ein Gerät" };
const DEV_DS: Record<Device, string> = { multi: "Jeder auf seinem Gerät", pod: "Host + Gäste per QR", single: "Alle teilen 1 Gerät" };
const DEV_INFO: Record<Device, string> = {
  multi: "Jeder Teilnehmer nimmt auf seinem eigenen Gerät (Handy/Laptop) auf. Das gibt die sauberste Sprecher-Trennung — jede Stimme hat ihre eigene Tonspur.",
  pod: "Es gibt einen Host mit einem zentralen Konferenzmikrofon. Gäste loggen sich per QR-Code ein (nur zum Einchecken + Namen). Aufnahme und Transkription laufen komplett über das eine Mikrofon — die Sprecher werden danach automatisch getrennt.",
  single: "Alle sitzen an EINEM Gerät (ein Handy, Laptop oder PC) und teilen es. Es nimmt für alle gemeinsam auf — ideal, wenn ihr zusammen in einem Raum vor einem Gerät sitzt.",
};

/**
 * HOST LOGIN / SETUP — Reihenfolge: Erfassung zuerst → optionaler Name → Sprache → Details.
 * Tile-Auswahl (device) mit ?-Info je Kachel, Sprecher-Zahl/Namen (single), dann createMeeting.
 */
// Nächster freier 15-Min-Slot ab jetzt (16:45 → 17:00) als {date:"YYYY-MM-DD", time:"HH:MM"}.
function nextQuarterSlot(): { date: string; time: string } {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + (15 - (d.getMinutes() % 15))); // immer der nächste Slot
  const p = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
}

export function HostLogin({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const m = useMeeting();
  const [device, setDevice] = useState<Device>("pod"); // Default: Konferenzmikrofon (TJ 2026-06-12)
  const [infoOpen, setInfoOpen] = useState<Device | "">("");
  const [spk, setSpk] = useState(2);
  const [title, setTitle] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [micId, setMicId] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(false); // "Meeting planen"-Modal offen
  const [sheet, setSheet] = useState(false); // Bottom-Sheet "Aufnahme anpassen" (Mikro/Sprecher/Namen)
  const [planDate, setPlanDate] = useState(() => nextQuarterSlot().date);
  const [planTime, setPlanTime] = useState(() => nextQuarterSlot().time);

  // ⌨️ Typewriter-Placeholder (TJ 2026-06-12): tippt Meeting-Namen-Ideen ein & wieder raus.
  // Bei Fokus im Feld: Animation aus (leerer Placeholder) — nicht ins Tippen reinquatschen.
  const [ph, setPh] = useState("");
  const [phFocus, setPhFocus] = useState(false);
  useEffect(() => {
    const IDEAS = ["Weekly Sync", "Sprint Review", "Strategie-Session", "Daily Standup", "1:1 Check-in"];
    let i = 0, pos = 0, del = false;
    let tm: number;
    const tick = () => {
      const word = IDEAS[i % IDEAS.length];
      if (!del) {
        pos++;
        setPh(word.slice(0, pos));
        if (pos === word.length) { del = true; tm = window.setTimeout(tick, 1800); return; }
        tm = window.setTimeout(tick, 75);
      } else {
        pos--;
        setPh(word.slice(0, pos));
        if (pos === 0) { del = false; i++; tm = window.setTimeout(tick, 400); return; }
        tm = window.setTimeout(tick, 35);
      }
    };
    tm = window.setTimeout(tick, 600);
    return () => window.clearTimeout(tm);
  }, []);

  // Enumerate microphones once a central-mic mode (pod/single) is picked — mirrors the
  // vanilla loadMics(): permission probe, then list audioinput devices.
  // ⚡ Performance (TJ 2026-06-11): beim Tile-Wechsel NUR billig enumerieren — getUserMedia
  // aktiviert die Mikro-Hardware (iOS-Audio-Session) und hat die Klick-Animation ruckeln lassen.
  useEffect(() => {
    if (device === "multi") return;
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    (async () => {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        const ins = devs.filter((d) => d.kind === "audioinput");
        // Labels gibt es nur mit bereits erteilter Permission — dann reicht das hier komplett.
        if (ins.some((d) => d.label)) {
          setMics(ins.map((d, i) => ({ id: d.deviceId, label: d.label || "Mikrofon " + (i + 1) })));
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device]);

  // Volle Probe (Permission + Labels) erst, wenn der User das Mikro-Dropdown wirklich oeffnet.
  const micProbed = useRef(false);
  const probeMics = async () => {
    if (micProbed.current || !navigator.mediaDevices?.getUserMedia) return;
    micProbed.current = true;
    try {
      const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
      ms.getTracks().forEach((tk) => tk.stop());
      const devs = await navigator.mediaDevices.enumerateDevices();
      setMics(devs.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, label: d.label || "Mikrofon " + (i + 1) })));
    } catch {
      /* no permission → just "Standard-Mikrofon" */
    }
  };

  const setName = (i: number, v: string) =>
    setNames((arr) => {
      const next = arr.slice();
      next[i] = v;
      return next;
    });

  const submit = async (scheduledAt?: string) => {
    setBusy(true);
    setErr("");
    const r = await m.createMeeting({
      title: title.trim(),
      mode: "dsgvo", // immer DSGVO/DE-Server — kein US-Cloud-Toggle mehr (TJ 2026-06-11)
      device,
      spk,
      names: device === "single" ? names.map((n) => (n || "").trim()).filter(Boolean) : [],
      language: "auto", // immer Auto-Erkennung (TJ 2026-06-12)
      scheduledAt: scheduledAt || null,
    });
    if (!r.ok) {
      if (r.error) setErr(r.error);
      setBusy(false);
    }
  };
  // "Meeting planen": Tag + Uhrzeit → ISO-Termin → Meeting wird terminiert erstellt (Verlauf "geplant für X").
  const confirmPlan = () => {
    if (!planDate || !planTime) {
      setErr("Bitte Tag und Uhrzeit wählen.");
      return;
    }
    setPlan(false);
    submit(`${planDate}T${planTime}:00`);
  };

  return (
    <div className="wrap" id="s-hostlogin">
      <div className="hd">
        <button className="back" onClick={onBack}>
          <svg viewBox="0 0 24 24">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <div>
          <h1>{t("Meeting einrichten")}</h1>
          <p>{t("Angemeldet über deinen subunit.ai-Account")}</p>
        </div>
      </div>

      {/* 1. Erfassung ZUERST — mit ?-Info je Kachel */}
      <div className="sect">{t("Erfassung")}</div>
      <div className="tiles" id="devslider">
        {DEVS.map((dv) => (
          <button key={dv} type="button" className={`tile${device === dv ? " sel" : ""}`} id={`dev-${dv}`} onClick={() => setDevice(dv)}>
            <span
              className="tile-help"
              role="button"
              tabIndex={0}
              aria-label={t("Mehr Infos")}
              onClick={(e) => {
                e.stopPropagation();
                setInfoOpen((o) => (o === dv ? "" : dv));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  setInfoOpen((o) => (o === dv ? "" : dv));
                }
              }}
            >
              ?
            </span>
            <span className="ic">
              <span className={`ic-img ${dv}`} aria-hidden="true" />
            </span>
            <div className="tt">{t(DEV_TT[dv])}</div>
            <div className="ds">{t(DEV_DS[dv])}</div>
          </button>
        ))}
      </div>
      {infoOpen && (
        <div className="tile-infobar" role="status">
          <b>{t(DEV_TT[infoOpen])}:</b> {t(DEV_INFO[infoOpen])}
        </div>
      )}

      {/* Sprache: IMMER automatische Erkennung — Auswahl entfernt (TJ 2026-06-12) */}

      {/* 4. Aufnahme-Details: Hauptseite bleibt STATISCH — nur eine Zusammenfassungszeile,
          die Optionen (Mikro/Sprecher/Namen) wohnen im Bottom-Sheet (Enterprise-Pattern,
          Progressive Disclosure — TJ 2026-06-12). */}
      {/* Die Zeile ist bei ALLEN Erfassungsarten da — feste Plätze, nichts verschiebt sich.
          multi = reine Info · pod = NATIVER Mikro-Picker (unsichtbares <select> über der
          Zeile → iOS öffnet sein eigenes Auswahlrad, kein Sheet — TJ 2026-06-12) ·
          single = Sheet (braucht zusätzlich Sprecher/Namen). */}
      <div className="sect">{t("Aufnahme")}</div>
      {device === "multi" ? (
        <div className="opt-row static">
          <span className="opt-row-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <path d="M12 19v3" />
            </svg>
          </span>
          <span className="opt-row-tx">{t("Jeder sein Mikro")}</span>
        </div>
      ) : device === "pod" ? (
        <div className="opt-row opt-row-native">
          <span className="opt-row-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <path d="M12 19v3" />
            </svg>
          </span>
          <span className="opt-row-tx">
            {mics.find((d) => d.id === micId)?.label || t("Standard-Mikro")}
          </span>
          <span className="opt-row-edit" aria-hidden="true">›</span>
          <select
            className="opt-row-select"
            aria-label={t("Mikrofon")}
            onPointerDown={probeMics}
            onFocus={probeMics}
            value={micId}
            onChange={(e) => {
              setMicId(e.target.value);
              m.setMicDevice(e.target.value || null);
            }}
          >
            <option value="">{t("Standard-Mikro")}</option>
            {mics.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <button type="button" className="opt-row" onClick={() => setSheet(true)}>
          <span className="opt-row-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <path d="M12 19v3" />
            </svg>
          </span>
          <span className="opt-row-tx">
            {mics.find((d) => d.id === micId)?.label || t("Standard-Mikro")}
            {" · " + t("Sprecher")}
          </span>
          <span className="opt-row-edit" aria-label={t("Anpassen")}>›</span>
        </button>
      )}

      {/* 3. Meeting-Name (optional) — NACH der Aufnahme (Tausch TJ 2026-06-12) */}
      <div className="sect">
        {t("Meeting-Name")} <span className="opt">{t("· optional")}</span>
      </div>
      <input
        id="h-title"
        className="fld"
        maxLength={80}
        placeholder={phFocus ? "" : ph + "\u258f"}
        onFocus={() => setPhFocus(true)}
        onBlur={() => setPhFocus(false)}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />


      <div className="cta">
        <button className="btn btn-primary" id="h-btn" disabled={busy} onClick={() => submit()}>
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="3.2" fill="#fff" stroke="none" />
          </svg>
          {busy ? t("Meeting wird gestartet…") : t("Meeting starten")}
        </button>
        <button className="btn btn-plan" id="h-plan" disabled={busy} onClick={() => { setErr(""); setPlan(true); }}>
          <svg viewBox="0 0 24 24">
            <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
            <path d="M3.5 9.5h17M8 3v4M16 3v4" />
          </svg>
          {t("Meeting planen")}
        </button>
      </div>
      <div className="err" id="h-err">
        {err}
      </div>
      <button className="btn btn-ghost" onClick={onBack}>
        {t("Zurück")}
      </button>

      {/* Bottom-Sheet: Aufnahme anpassen (Mikrofon, Sprecher, Namen) */}
      {sheet && (
        <div className="sheet-backdrop" onClick={() => setSheet(false)}>
          <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grip" aria-hidden="true"></div>
            <div className="sect" style={{ marginTop: 0 }}>{t("Mikrofon")}</div>
            <select
              id="h-mic"
              className="fld"
              onPointerDown={probeMics}
              onFocus={probeMics}
              value={micId}
              onChange={(e) => {
                setMicId(e.target.value);
                m.setMicDevice(e.target.value || null);
              }}
            >
              <option value="">{t("Standard-Mikrofon")}</option>
              {mics.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <div className="hint">{t("Für ein zentrales Mikro (z. B. Jabra) hier das Gerät wählen — dann nimmt nur dieses auf.")}</div>
            {device === "single" && (
              <>
                <div className="sect">{t("Wie viele sprechen?")}</div>
                <div className="numpick" id="numpick">
                  {[2, 3, 4, 5, 6].map((n) => (
                    <button key={n} type="button" data-n={n} className={spk === n ? "sel" : undefined} onClick={() => setSpk(n)}>
                      {n === 6 ? "6+" : n}
                    </button>
                  ))}
                </div>
                <div className="sect tight">
                  <span>{t("Namen")}</span> <span className="opt">{t("(optional — später im Transkript zuordenbar)")}</span>
                </div>
                <div id="namefields" className="sheet-names">
                  {Array.from({ length: spk }).map((_, i) => (
                    <input key={i} className="fld" maxLength={40} placeholder={"Name " + (i + 1) + " (optional)"} value={names[i] || ""} onChange={(e) => setName(i, e.target.value)} />
                  ))}
                </div>
              </>
            )}
            <button className="btn btn-primary" onClick={() => setSheet(false)}>
              {t("Fertig")}
            </button>
          </div>
        </div>
      )}

      {plan && (
        <div className="ddm center">
          <div className="ddm-bg" onClick={() => setPlan(false)}></div>
          <div className="ddm-card plan-card" role="dialog" aria-modal="true">
            <div className="ddm-title">{t("Meeting planen")}</div>
            <p className="plan-sub">{t("Wähle Tag und Uhrzeit — das Meeting landet als Termin in deinem Verlauf, Link gibt's sofort.")}</p>
            <label className="plan-lbl">{t("Tag")}</label>
            <input className="fld" type="date" value={planDate} min={nextQuarterSlot().date} onChange={(e) => setPlanDate(e.target.value)} />
            <label className="plan-lbl">{t("Uhrzeit")}</label>
            <input className="fld" type="time" step={900} value={planTime} onChange={(e) => setPlanTime(e.target.value)} />
            <div className="plan-actions">
              <button className="btn btn-ghost" onClick={() => setPlan(false)}>{t("Abbrechen")}</button>
              <button className="btn btn-primary" disabled={busy} onClick={confirmPlan}>{t("Termin festlegen")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
