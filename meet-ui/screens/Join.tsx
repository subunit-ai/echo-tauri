import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { useMeeting } from "../store";

/** JOIN — 1:1 port of `#s-join`. Code + name + optional email → guestJoin. */
export function Join({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const m = useMeeting();
  const fromLink = !!m.pendingJoinCode;
  const [codeV, setCodeV] = useState(m.pendingJoinCode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Deep-link: peek the prefilled code so the title/host show immediately.
  useEffect(() => {
    if (m.pendingJoinCode) m.peekMeeting(m.pendingJoinCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setBusy(true);
    setErr("");
    const r = await m.guestJoin(codeV, name.trim(), email.trim(), fromLink);
    if (!r.ok) {
      setErr(r.error || "");
      setBusy(false);
    }
  };

  return (
    <div className="wrap" id="s-join">
      <div className="hd">
        <button className="back" onClick={onBack}>
          <svg viewBox="0 0 24 24">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <div>
          <h1 id="join-title">{m.title || t("Meeting beitreten")}</h1>
          <p id="join-sub">
            {m.peekHost
              ? `Host: ${m.peekHost} · gib deinen Namen ein, um beizutreten.`
              : t("Gib den 6-stelligen Code ein, den der Host teilt.")}
          </p>
        </div>
      </div>
      <div className="sect">{t("Meeting-Code")}</div>
      <input
        id="j-code"
        className="fld code"
        inputMode="numeric"
        maxLength={6}
        placeholder="000000"
        value={codeV}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "");
          setCodeV(v);
          m.peekMeeting(v);
        }}
      />
      <div className="sect">{t("Dein Name")}</div>
      <input id="j-name" className="fld" placeholder="Vor- und Nachname" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="sect">
        <span>{t("E-Mail")}</span> <span className="opt">{t("· optional")}</span>
      </div>
      <input id="j-email" className="fld" type="email" placeholder={t("name@firma.de — optional")} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <div className="cta">
        <button className="btn btn-primary" id="j-btn" disabled={busy} onClick={submit}>
          <svg viewBox="0 0 24 24">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <path d="M10 17l5-5-5-5" />
            <path d="M15 12H3" />
          </svg>
          {busy ? t("Trete bei…") : t("Beitreten")}
        </button>
      </div>
      <div className="err" id="j-err">
        {err}
      </div>
      <button className="btn btn-ghost" onClick={onBack}>
        {t("Zurück")}
      </button>
    </div>
  );
}
