// Cloud-Meeting SETUP (nativ) — Port von meet-ui/screens/HostLogin.tsx.
// NUR die Präsentation ist neu (Echo Liquid-Glass / .mc-* Klassen); die Logik
// (Device-Kacheln, Mikro-Enumerierung/-Probe, Sprecher/Namen, Typewriter-
// Placeholder, createMeeting/planen) ist 1:1 aus der Quelle übernommen.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMeeting } from "@meet/store";
import { MIC_PATHS, RecDot } from "../../components/icons";

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

// Nächster freier 15-Min-Slot ab jetzt (16:45 → 17:00) als {date:"YYYY-MM-DD", time:"HH:MM"}.
function nextQuarterSlot(): { date: string; time: string } {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + (15 - (d.getMinutes() % 15))); // immer der nächste Slot
  const p = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
}

/** Leichtes Stroke-Mikro für die Aufnahme-Zeile (nutzt das zentrale MIC_PATHS). */
function OptMic() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {MIC_PATHS.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

/**
 * CLOUD SETUP — Reihenfolge: Erfassung zuerst → Aufnahme → optionaler Name.
 * Tile-Auswahl (device) mit ?-Info je Kachel, Sprecher-Zahl/Namen (single), dann createMeeting.
 */
export function CloudSetup({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
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
  const [sheet, setSheet] = useState(false); // Sheet "Aufnahme anpassen" (Mikro/Sprecher/Namen)
  const [planDate, setPlanDate] = useState(() => nextQuarterSlot().date);
  const [planTime, setPlanTime] = useState(() => nextQuarterSlot().time);

  // Typewriter-Placeholder (TJ 2026-06-12): tippt Meeting-Namen-Ideen ein & wieder raus.
  // Bei Fokus im Feld: Animation aus (leerer Placeholder) — nicht ins Tippen reinquatschen.
  const [ph, setPh] = useState("");
  const [phFocus, setPhFocus] = useState(false);
  useEffect(() => {
    const IDEAS = ["Weekly Sync", "Sprint Review", "Strategie-Session", "Daily Standup", "1:1 Check-in"];
    let i = 0,
      pos = 0,
      del = false;
    let tm: number;
    const tick = () => {
      const word = IDEAS[i % IDEAS.length];
      if (!del) {
        pos++;
        setPh(word.slice(0, pos));
        if (pos === word.length) {
          del = true;
          tm = window.setTimeout(tick, 1800);
          return;
        }
        tm = window.setTimeout(tick, 75);
      } else {
        pos--;
        setPh(word.slice(0, pos));
        if (pos === 0) {
          del = false;
          i++;
          tm = window.setTimeout(tick, 400);
          return;
        }
        tm = window.setTimeout(tick, 35);
      }
    };
    tm = window.setTimeout(tick, 600);
    return () => window.clearTimeout(tm);
  }, []);

  // Enumerate microphones once a central-mic mode (pod/single) is picked — mirrors the
  // vanilla loadMics(): permission probe, then list audioinput devices.
  // Performance (TJ 2026-06-11): beim Tile-Wechsel NUR billig enumerieren — getUserMedia
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
      setErr(t("meet.cloudsetup.planMissing", "Bitte Tag und Uhrzeit wählen."));
      return;
    }
    setPlan(false);
    submit(`${planDate}T${planTime}:00`);
  };

  const micLabel = mics.find((d) => d.id === micId)?.label || t("meet.cloudsetup.micDefault", "Standard-Mikro");

  return (
    <div className="meetc">
      <div className="mc-wrap">
        <div className="mc-head">
          <button className="mc-back" onClick={onBack} aria-label={t("meet.cloudsetup.back", "Zurück")}>
            <svg viewBox="0 0 24 24">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <div className="mc-head-tx">
            <h1 className="section-title">{t("meet.cloudsetup.title", "Meeting einrichten")}</h1>
            <p className="section-sub">{t("meet.cloudsetup.sub", "Angemeldet über deinen subunit.ai-Account")}</p>
          </div>
        </div>

        {/* 1. Erfassung ZUERST — mit ?-Info je Kachel */}
        <div className="mc-sect">{t("meet.cloudsetup.capture", "Erfassung")}</div>
        <div className="mc-tiles">
          {DEVS.map((dv) => (
            <button key={dv} type="button" className={`mc-tile${device === dv ? " sel" : ""}`} onClick={() => setDevice(dv)}>
              <span
                className="mc-thelp"
                role="button"
                tabIndex={0}
                aria-label={t("meet.cloudsetup.moreInfo", "Mehr Infos")}
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
              <span className="mc-tico-wrap">
                <span className={`mc-tico ${dv}`} aria-hidden="true" />
              </span>
              <div className="mc-tt">{t(`meet.cloudsetup.dev.${dv}.tt`, DEV_TT[dv])}</div>
              <div className="mc-ds">{t(`meet.cloudsetup.dev.${dv}.ds`, DEV_DS[dv])}</div>
            </button>
          ))}
        </div>
        {infoOpen && (
          <div className="mc-infobar" role="status">
            <b>{t(`meet.cloudsetup.dev.${infoOpen}.tt`, DEV_TT[infoOpen])}:</b>{" "}
            {t(`meet.cloudsetup.dev.${infoOpen}.info`, DEV_INFO[infoOpen])}
          </div>
        )}

        {/* Sprache: IMMER automatische Erkennung — Auswahl entfernt (TJ 2026-06-12) */}

        {/* 2. Aufnahme: statische Zusammenfassungszeile, Optionen wohnen im Sheet
            (Progressive Disclosure). multi = reine Info · pod = nativer Mikro-Picker
            (unsichtbares <select> über der Zeile) · single = Sheet (Sprecher/Namen). */}
        <div className="mc-sect">{t("meet.cloudsetup.recording", "Aufnahme")}</div>
        {device === "multi" ? (
          <div className="mc-optrow mc-static">
            <span className="mc-optrow-ic" aria-hidden="true">
              <OptMic />
            </span>
            <span className="mc-optrow-tx">{t("meet.cloudsetup.ownMic", "Jeder sein Mikro")}</span>
          </div>
        ) : device === "pod" ? (
          <div className="mc-optrow mc-optrow-native">
            <span className="mc-optrow-ic" aria-hidden="true">
              <OptMic />
            </span>
            <span className="mc-optrow-tx">{micLabel}</span>
            <span className="mc-optrow-chev" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </span>
            <select
              className="mc-optrow-select"
              aria-label={t("meet.cloudsetup.microphone", "Mikrofon")}
              onPointerDown={probeMics}
              onFocus={probeMics}
              value={micId}
              onChange={(e) => {
                setMicId(e.target.value);
                m.setMicDevice(e.target.value || null);
              }}
            >
              <option value="">{t("meet.cloudsetup.micDefault", "Standard-Mikro")}</option>
              {mics.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <button type="button" className="mc-optrow" onClick={() => setSheet(true)}>
            <span className="mc-optrow-ic" aria-hidden="true">
              <OptMic />
            </span>
            <span className="mc-optrow-tx">
              {micLabel}
              {" · " + t("meet.cloudsetup.speakers", "Sprecher")}
            </span>
            <span className="mc-optrow-chev" aria-label={t("meet.cloudsetup.adjust", "Anpassen")}>
              <svg viewBox="0 0 24 24">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </span>
          </button>
        )}

        {/* 3. Meeting-Name (optional) — NACH der Aufnahme (Tausch TJ 2026-06-12) */}
        <div className="mc-sect">
          {t("meet.cloudsetup.meetingName", "Meeting-Name")} <span className="mc-opt">{t("meet.cloudsetup.optional", "· optional")}</span>
        </div>
        <input
          maxLength={80}
          placeholder={phFocus ? "" : ph + "▏"}
          onFocus={() => setPhFocus(true)}
          onBlur={() => setPhFocus(false)}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />

        <div className="mc-cta">
          <button
            className="sub-tab onb-primary"
            style={{ padding: "10px 18px", fontSize: 14, display: "inline-flex", alignItems: "center" }}
            disabled={busy}
            onClick={() => submit()}
          >
            <RecDot />
            {busy ? t("meet.cloudsetup.starting", "Meeting wird gestartet…") : t("meet.cloudsetup.start", "Meeting starten")}
          </button>
          <button
            className="sub-tab"
            style={{ padding: "10px 18px", fontSize: 14, display: "inline-flex", alignItems: "center", gap: 8 }}
            disabled={busy}
            onClick={() => {
              setErr("");
              setPlan(true);
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
              <path d="M3.5 9.5h17M8 3v4M16 3v4" />
            </svg>
            {t("meet.cloudsetup.plan", "Meeting planen")}
          </button>
        </div>
        <div className="mc-err">{err}</div>
        <button className="sub-tab" style={{ padding: "10px 18px" }} onClick={onBack}>
          {t("meet.cloudsetup.back", "Zurück")}
        </button>
      </div>

      {/* Sheet: Aufnahme anpassen (Mikrofon, Sprecher, Namen) */}
      {sheet && (
        <div className="mc-sheet-backdrop" onClick={() => setSheet(false)}>
          <div className="mc-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="mc-sheet-grip" aria-hidden="true" />
            <div className="mc-sect">{t("meet.cloudsetup.microphone", "Mikrofon")}</div>
            <select
              onPointerDown={probeMics}
              onFocus={probeMics}
              value={micId}
              onChange={(e) => {
                setMicId(e.target.value);
                m.setMicDevice(e.target.value || null);
              }}
            >
              <option value="">{t("meet.cloudsetup.micDefaultFull", "Standard-Mikrofon")}</option>
              {mics.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <div className="mc-hint">
              {t("meet.cloudsetup.micHint", "Für ein zentrales Mikro (z. B. Jabra) hier das Gerät wählen — dann nimmt nur dieses auf.")}
            </div>
            {device === "single" && (
              <>
                <div className="mc-sect">{t("meet.cloudsetup.howManySpeak", "Wie viele sprechen?")}</div>
                <div className="mc-numpick">
                  {[2, 3, 4, 5, 6].map((n) => (
                    <button key={n} type="button" className={spk === n ? "sel" : undefined} onClick={() => setSpk(n)}>
                      {n === 6 ? "6+" : n}
                    </button>
                  ))}
                </div>
                <div className="mc-sect mc-tight">
                  <span>{t("meet.cloudsetup.names", "Namen")}</span>{" "}
                  <span className="mc-opt">{t("meet.cloudsetup.namesHint", "(optional — später im Transkript zuordenbar)")}</span>
                </div>
                <div>
                  {Array.from({ length: spk }).map((_, i) => (
                    <input
                      key={i}
                      maxLength={40}
                      style={{ marginTop: i === 0 ? 0 : 8 }}
                      placeholder={t("meet.cloudsetup.namePlaceholder", "Name {{n}} (optional)", { n: i + 1 })}
                      value={names[i] || ""}
                      onChange={(e) => setName(i, e.target.value)}
                    />
                  ))}
                </div>
              </>
            )}
            <button
              className="sub-tab onb-primary"
              style={{ padding: "10px 18px", fontSize: 14, marginTop: 16 }}
              onClick={() => setSheet(false)}
            >
              {t("meet.cloudsetup.done", "Fertig")}
            </button>
          </div>
        </div>
      )}

      {plan && (
        <div className="mc-sheet-backdrop" onClick={() => setPlan(false)}>
          <div className="mc-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="mc-sect">{t("meet.cloudsetup.plan", "Meeting planen")}</div>
            <p className="mc-hint">
              {t("meet.cloudsetup.planSub", "Wähle Tag und Uhrzeit — das Meeting landet als Termin in deinem Verlauf, Link gibt's sofort.")}
            </p>
            <div className="mc-sect">{t("meet.cloudsetup.day", "Tag")}</div>
            <input type="date" value={planDate} min={nextQuarterSlot().date} onChange={(e) => setPlanDate(e.target.value)} />
            <div className="mc-sect">{t("meet.cloudsetup.time", "Uhrzeit")}</div>
            <input type="time" step={900} value={planTime} onChange={(e) => setPlanTime(e.target.value)} />
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
              <button className="sub-tab" style={{ padding: "10px 18px" }} onClick={() => setPlan(false)}>
                {t("meet.cloudsetup.cancel", "Abbrechen")}
              </button>
              <button
                className="sub-tab onb-primary"
                style={{ padding: "10px 18px", fontSize: 14 }}
                disabled={busy}
                onClick={confirmPlan}
              >
                {t("meet.cloudsetup.confirmPlan", "Termin festlegen")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
