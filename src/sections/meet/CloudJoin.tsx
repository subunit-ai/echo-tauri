// CLOUD-MEETING — Join (nativer Echo-Port von meet-ui/screens/Join.tsx).
// Rein die Präsentation ist neu (Liquid-Glass, mc-*); die Logik kommt verbatim
// aus dem geteilten Store: 6-stelliger Code + Name + optional E-Mail → guestJoin,
// währenddessen peekMeeting für Titel/Host. Kein Emoji (Enterprise-UI).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMeeting } from "@meet/store";

/** JOIN — Code + Name + optionale E-Mail → guestJoin. onBack → Landing. */
export function CloudJoin({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const m = useMeeting();
  const fromLink = !!m.pendingJoinCode;
  const [codeV, setCodeV] = useState(m.pendingJoinCode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Deep-link: den vorausgefüllten Code sofort peeken, damit Titel/Host stehen.
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
    <div className="meetc">
      <div className="mc-wrap" id="s-join">
        <div className="mc-head">
          <button className="mc-back" onClick={onBack} aria-label={t("meet.cloudjoin.back", "Zurück")}>
            <svg viewBox="0 0 24 24">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <div className="mc-head-tx">
            <h1 className="section-title">{m.title || t("meet.cloudjoin.title", "Meeting beitreten")}</h1>
            <p className="section-sub">
              {m.peekHost
                ? t("meet.cloudjoin.subHost", "Host: {{host}} · gib deinen Namen ein, um beizutreten.", { host: m.peekHost })
                : t("meet.cloudjoin.sub", "Gib den 6-stelligen Code ein, den der Host teilt.")}
            </p>
          </div>
        </div>

        <div className="mc-sect">{t("meet.cloudjoin.codeLabel", "Meeting-Code")}</div>
        <input
          id="j-code"
          inputMode="numeric"
          maxLength={6}
          placeholder="000000"
          value={codeV}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "");
            setCodeV(v);
            m.peekMeeting(v);
          }}
          style={{
            textAlign: "center",
            fontSize: 34,
            letterSpacing: "0.32em",
            fontWeight: 700,
            color: "var(--cyan-ink)",
          }}
        />

        <div className="mc-sect">{t("meet.cloudjoin.nameLabel", "Dein Name")}</div>
        <input
          id="j-name"
          placeholder={t("meet.cloudjoin.namePlaceholder", "Vor- und Nachname")}
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div className="mc-sect">
          <span>{t("meet.cloudjoin.emailLabel", "E-Mail")}</span>{" "}
          <span className="mc-opt">{t("meet.cloudjoin.emailOpt", "· optional")}</span>
        </div>
        <input
          id="j-email"
          type="email"
          placeholder={t("meet.cloudjoin.emailPlaceholder", "name@firma.de — optional")}
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <div className="mc-cta">
          <button
            className="sub-tab onb-primary"
            id="j-btn"
            style={{ padding: "10px 18px", fontSize: 14, display: "inline-flex", alignItems: "center", gap: 8 }}
            disabled={busy}
            onClick={submit}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <path d="M10 17l5-5-5-5" />
              <path d="M15 12H3" />
            </svg>
            {busy ? t("meet.cloudjoin.joining", "Trete bei…") : t("meet.cloudjoin.join", "Beitreten")}
          </button>
        </div>

        <div className="mc-err" id="j-err">
          {err}
        </div>

        <button className="sub-tab" onClick={onBack}>
          {t("meet.cloudjoin.back", "Zurück")}
        </button>
      </div>
    </div>
  );
}
