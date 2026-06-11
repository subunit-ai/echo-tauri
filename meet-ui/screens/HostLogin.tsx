import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { useMeeting } from "../store";

type Device = "multi" | "pod" | "single";

// Erfassungs-Kacheln: Titel, Kurzbeschreibung (unter der Kachel) + ausführliche Info (?-Overlay).
const DEVS: Device[] = ["multi", "pod", "single"];
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
  const [device, setDevice] = useState<Device>("multi");
  const [infoOpen, setInfoOpen] = useState<Device | "">("");
  const [spk, setSpk] = useState(2);
  const [title, setTitle] = useState("");
  const [lang, setLang] = useState("auto");
  const [names, setNames] = useState<string[]>([]);
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [micId, setMicId] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(false); // "Meeting planen"-Modal offen
  const [planDate, setPlanDate] = useState(() => nextQuarterSlot().date);
  const [planTime, setPlanTime] = useState(() => nextQuarterSlot().time);

  // Enumerate microphones once a central-mic mode (pod/single) is picked — mirrors the
  // vanilla loadMics(): permission probe, then list audioinput devices.
  useEffect(() => {
    if (device === "multi") return;
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    (async () => {
      try {
        const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
        ms.getTracks().forEach((tk) => tk.stop());
        const devs = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setMics(devs.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, label: d.label || "Mikrofon " + (i + 1) })));
      } catch {
        /* no permission → just "Standard-Mikrofon" */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device]);

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
      language: lang,
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

      {/* 2. Meeting-Name (optional) — nach der Erfassung */}
      <div className="sect">
        {t("Meeting-Name")} <span className="opt">{t("· optional")}</span>
      </div>
      <input
        id="h-title"
        className="fld"
        maxLength={80}
        placeholder="z. B. Kickoff mit Kunde X"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />

      {/* 3. Sprache */}
      <div className="sect">{t("Sprache")}</div>
      <select id="h-lang" className="fld" value={lang} onChange={(e) => setLang(e.target.value)}>
        <option value="auto">{t("🌐 Automatisch erkennen")}</option>
        <option value="de">{t("🇩🇪 Deutsch")}</option>
        <option value="en">{t("🇬🇧 Englisch")}</option>
        <option value="es">{t("🇪🇸 Spanisch")}</option>
        <option value="fr">{t("🇫🇷 Französisch")}</option>
        <option value="it">{t("🇮🇹 Italienisch")}</option>
      </select>

      {device !== "multi" && (
        <div id="microw">
          <div className="sect">{t("Mikrofon")}</div>
          <select
            id="h-mic"
            className="fld"
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
        </div>
      )}

      {device === "single" && (
        <div id="single-setup">
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
          <div id="namefields">
            {Array.from({ length: spk }).map((_, i) => (
              <input key={i} className="fld" maxLength={40} placeholder={"Name " + (i + 1) + " (optional)"} value={names[i] || ""} onChange={(e) => setName(i, e.target.value)} />
            ))}
          </div>
        </div>
      )}

      {/* DSGVO-Trust-Zeile (kein Kasten) — überall präsent */}
      <div className="dsgvo-trust">
        <span className="dsgvo-trust-ic" aria-hidden="true" />
        <span className="dsgvo-trust-txt">100&nbsp;% DSGVO-konform</span>
        <span className="dsgvo-help" tabIndex={0} role="button" aria-label="Was bedeutet DSGVO-konform?">
          ?
          <span className="dsgvo-tip" role="tooltip">
            Dein Meeting wird ausschließlich auf unseren Servern in Deutschland verarbeitet — DSGVO-konform.
            Keine Weitergabe an Dritte, keine US-Cloud. Audio und Transkript werden nach der Auswertung
            automatisch gelöscht. Höchste Datensicherheit ist unser Standard.
          </span>
        </span>
      </div>

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
