import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { useMeeting } from "../store";

type Mode = "dsgvo" | "blitz";
type Device = "multi" | "pod" | "single";

const CHECK = (
  <span className="ck">
    <svg viewBox="0 0 24 24">
      <path d="M5 12l5 5 9-9" />
    </svg>
  </span>
);

/**
 * HOST LOGIN / SETUP — 1:1 port of `#s-hostlogin`. Tile selection (mode/device), speaker
 * count + names, then `createMeeting` (store). Mirrors the vanilla setMode/setDevice/setSpk.
 */
export function HostLogin({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const m = useMeeting();
  const [mode, setMode] = useState<Mode>("dsgvo");
  const [device, setDevice] = useState<Device>("multi");
  const [spk, setSpk] = useState(2);
  const [title, setTitle] = useState("");
  const [lang, setLang] = useState("auto");
  const [names, setNames] = useState<string[]>([]);
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [micId, setMicId] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

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

  const submit = async () => {
    setBusy(true);
    setErr("");
    const r = await m.createMeeting({
      title: title.trim(),
      mode,
      device,
      spk,
      names: device === "single" ? names.map((n) => (n || "").trim()).filter(Boolean) : [],
      language: lang,
    });
    if (!r.ok) {
      if (r.error) setErr(r.error);
      setBusy(false);
    }
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

      <div className="sect">{t("Transkription")}</div>
      <div className="tiles" id="modeslider">
        <button type="button" className={`tile${mode === "dsgvo" ? " sel" : ""}`} id="mode-dsgvo" onClick={() => setMode("dsgvo")}>
          {CHECK}
          <span className="ic">
            <svg viewBox="0 0 24 24">
              <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />
            </svg>
          </span>
          <div className="tt">{t("DSGVO")}</div>
          <div className="ds">{t("DE-Server · sicher")}</div>
        </button>
        <button type="button" className={`tile${mode === "blitz" ? " sel" : ""}`} id="mode-blitz" onClick={() => setMode("blitz")}>
          {CHECK}
          <span className="ic">
            <svg viewBox="0 0 24 24">
              <path d="M13 2L4 14h7l-1 8 10-12h-9z" />
            </svg>
          </span>
          <div className="tt">{t("Superfast")}</div>
          <div className="ds">{t("schnellste")}</div>
        </button>
      </div>

      <div className="sect">{t("Erfassung")}</div>
      <div className="tiles" id="devslider">
        <button type="button" className={`tile${device === "multi" ? " sel" : ""}`} id="dev-multi" onClick={() => setDevice("multi")}>
          {CHECK}
          <span className="ic">
            <svg viewBox="0 0 24 24">
              <rect x="4" y="3" width="7" height="13" rx="1.6" />
              <rect x="14" y="8" width="6" height="13" rx="1.6" />
            </svg>
          </span>
          <div className="tt">{t("Mehrere Geräte")}</div>
          <div className="ds">{t("jeder sein Handy")}</div>
        </button>
        <button type="button" className={`tile${device === "pod" ? " sel" : ""}`} id="dev-pod" onClick={() => setDevice("pod")}>
          {CHECK}
          <span className="ic">
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
              <circle cx="12" cy="12" r="6" />
              <circle cx="12" cy="12" r="9.6" opacity=".5" />
            </svg>
          </span>
          <div className="tt">{t("Pod-Mikro")}</div>
          <div className="ds">{t("zentral + QR")}</div>
        </button>
        <button type="button" className={`tile${device === "single" ? " sel" : ""}`} id="dev-single" onClick={() => setDevice("single")}>
          {CHECK}
          <span className="ic">
            <svg viewBox="0 0 24 24">
              <rect x="9" y="2" width="6" height="11" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0" />
              <path d="M12 17v4" />
            </svg>
          </span>
          <div className="tt">{t("Ein Gerät")}</div>
          <div className="ds">{t("ein Mik für alle")}</div>
        </button>
      </div>

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

      {device === "pod" && (
        <div className="hint pod" id="pod-note">
          {t("Pod-Modus: Gäste scannen den QR nur zum Einchecken (Name) — nur das gewählte Mikro nimmt auf. Sprecher werden danach automatisch getrennt.")}
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

      <div className="cta">
        <button className="btn btn-primary" id="h-btn" disabled={busy} onClick={submit}>
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="3.2" fill="#fff" stroke="none" />
          </svg>
          {busy ? t("Meeting wird erstellt…") : t("Meeting starten")}
        </button>
      </div>
      <div className="err" id="h-err">
        {err}
      </div>
      <button className="btn btn-ghost" onClick={onBack}>
        {t("Zurück")}
      </button>
    </div>
  );
}
