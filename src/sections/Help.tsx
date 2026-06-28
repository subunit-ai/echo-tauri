import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import {
  FAQ_CATEGORIES,
  faqKnowledge,
  localizedFaq,
  type FaqCategory,
} from "../lib/faq";
import {
  appVersion,
  copyText,
  helpAsk,
  openConfigDir,
  openExternal,
} from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";
import { useToast } from "../state/ToastContext";

const SUPPORT_EMAIL = "support@subunit.ai";

/* "Echo fragen" — the grounded help assistant. Answers strictly from the FAQ
   knowledge base over the Abo backend; on any failure it points to the FAQ +
   support so the user is never stuck. */
function AskEcho() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const suggestions = [
    t("help.suggest.paste"),
    t("help.suggest.hotkey"),
    t("help.suggest.meeting"),
  ];

  const ask = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    setQ(trimmed);
    setBusy(true);
    setAnswer(null);
    try {
      const knowledge = faqKnowledge(i18n.language);
      const a = await helpAsk(trimmed, knowledge, i18n.language);
      setAnswer(a);
    } catch {
      setAnswer(t("help.askError", { email: SUPPORT_EMAIL }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card help-ask">
      <div className="name help-ask-title">{t("help.askTitle")}</div>
      <p className="section-sub" style={{ marginTop: 0 }}>{t("help.askSub")}</p>
      <div className="help-ask-row">
        <input
          value={q}
          placeholder={t("help.askPlaceholder")}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") ask(q);
          }}
        />
        <button
          className="sub-tab"
          style={{ borderColor: "var(--accent)", color: "var(--accent-bright)" }}
          onClick={() => ask(q)}
          disabled={busy || !q.trim()}
        >
          {busy ? t("help.asking") : t("help.askButton")}
        </button>
      </div>
      {!answer && !busy && (
        <div className="help-chips">
          {suggestions.map((s) => (
            <button key={s} className="help-chip" onClick={() => ask(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {answer && <div className="help-answer">{answer}</div>}
    </div>
  );
}

/* Searchable FAQ, grouped by category, accordion-style. */
function Faq() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const entries = useMemo(() => localizedFaq(i18n.language), []);
  const filtered = useMemo(() => {
    const ql = query.trim().toLowerCase();
    if (!ql) return entries;
    return entries.filter(
      (e) => e.q.toLowerCase().includes(ql) || e.a.toLowerCase().includes(ql),
    );
  }, [entries, query]);

  return (
    <div className="card">
      <div className="name" style={{ opacity: 0.7, marginBottom: 8 }}>{t("help.faqTitle")}</div>
      <input
        className="help-search"
        value={query}
        placeholder={t("common.search")}
        onChange={(e) => setQuery(e.target.value)}
      />
      {FAQ_CATEGORIES.map((cat: FaqCategory) => {
        const items = filtered.filter((e) => e.category === cat);
        if (items.length === 0) return null;
        return (
          <div key={cat} className="help-cat">
            <div className="help-cat-title">{t(`help.cat.${cat}`)}</div>
            {items.map((e) => (
              <div key={e.id} className={`help-qa ${open === e.id ? "open" : ""}`}>
                <button
                  className="help-q"
                  onClick={() => setOpen(open === e.id ? null : e.id)}
                >
                  <span>{e.q}</span>
                  <span className="help-q-chevron" aria-hidden>›</span>
                </button>
                {open === e.id && <div className="help-a">{e.a}</div>}
              </div>
            ))}
          </div>
        );
      })}
      {filtered.length === 0 && <div className="empty">{t("help.noResults")}</div>}
    </div>
  );
}

/* Diagnostics + actions: version, copy-diagnostics (the Finn-class support aid),
   open log folder, replay the intro tour, contact support. */
function Diagnostics() {
  const { t } = useTranslation();
  const { config, patch } = useConfig();
  const toast = useToast();

  const copyDiagnostics = async () => {
    const v = await appVersion().catch(() => "?");
    const lines = [
      `Echo ${v}`,
      `Platform: ${navigator.platform}`,
      `UA: ${navigator.userAgent}`,
      `UI language: ${i18n.language}`,
      `Mode: ${config?.mode ?? "?"}`,
      `Dictation language: ${config?.language ?? "?"}`,
      `Cleanup: ${config?.cleanup_enabled ? "on" : "off"} (auto=${config?.cleanup_auto_mode ? "on" : "off"})`,
      `Streaming: ${config?.streaming_mode ?? "?"}`,
    ];
    try {
      await copyText(lines.join("\n"));
      toast(t("help.diagCopied"), "success");
    } catch {
      toast(t("common.error"), "error");
    }
  };

  return (
    <div className="card">
      <div className="name" style={{ opacity: 0.7, marginBottom: 8 }}>{t("help.diagTitle")}</div>
      <p className="section-sub" style={{ marginTop: 0 }}>{t("help.diagSub")}</p>
      <div className="help-actions">
        <button className="sub-tab" onClick={copyDiagnostics}>{t("help.copyDiag")}</button>
        <button className="sub-tab" onClick={() => openConfigDir().catch(() => {})}>
          {t("help.openLogs")}
        </button>
        <button className="sub-tab" onClick={() => patch({ has_seen_onboarding: false })}>
          {t("help.replayIntro")}
        </button>
        <button
          className="sub-tab"
          onClick={() => openExternal(`mailto:${SUPPORT_EMAIL}`).catch(() => {})}
        >
          {t("help.contact")}
        </button>
      </div>
    </div>
  );
}

export function Help() {
  const { t } = useTranslation();
  return (
    <div>
      <h1 className="section-title">{t("nav.help")}</h1>
      <p className="section-sub">{t("help.subtitle")}</p>
      <AskEcho />
      <Faq />
      <Diagnostics />
    </div>
  );
}
