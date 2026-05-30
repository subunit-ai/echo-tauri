import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyText, processMeeting } from "../lib/ipc";
import { useConfig } from "../state/ConfigContext";

// Re-process styles available on a stored meeting transcript (server /v1/cleanup).
// `labelKey` resolves through i18n at render time.
const ACTIONS: { style: string; labelKey: string }[] = [
  { style: "summary", labelKey: "meetings.actionSummary" },
  { style: "action_items", labelKey: "meetings.actionTasks" },
  { style: "decisions", labelKey: "meetings.actionDecisions" },
  { style: "minutes", labelKey: "meetings.actionMinutes" },
  { style: "recap_email", labelKey: "meetings.actionRecapEmail" },
];

export function Meetings() {
  const { t } = useTranslation();
  const { config, reload } = useConfig();
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // `${i}:${style}`
  const [result, setResult] = useState<Record<number, { label: string; text: string }>>({});
  const [copied, setCopied] = useState(false);

  // Diarization finishes on a background thread → reload when it tags a meeting.
  useEffect(() => {
    const un = listen("echo://meetings-updated", () => {
      reload().catch(() => {});
    });
    return () => {
      un.then((f) => f());
    };
  }, [reload]);

  if (!config) return null;

  const list = config.meetings;
  const thresholdMin = Math.round(config.long_form_threshold_seconds / 60);

  const run = async (i: number, style: string, label: string) => {
    setBusy(`${i}:${style}`);
    try {
      const text = await processMeeting(i, style);
      setResult((r) => ({ ...r, [i]: { label, text } }));
    } catch (e) {
      setResult((r) => ({
        ...r,
        [i]: { label, text: t("meetings.processError", { error: String(e) }) },
      }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h1 className="section-title">{t("meetings.title")}</h1>
      <p className="section-sub">{t("meetings.subtitle", { minutes: thresholdMin })}</p>

      {list.length === 0 ? (
        <div className="empty">{t("meetings.empty")}</div>
      ) : (
        list.map((m, i) => {
          const text = String(m.text ?? "");
          const speakerText = m.speaker_text ? String(m.speaker_text) : "";
          const dur = Number(m.duration_s ?? 0);
          const isOpen = open === i;
          const res = result[i];
          return (
            <div key={i} className="history-item">
              <div
                style={{ cursor: "pointer" }}
                onClick={() => setOpen(isOpen ? null : i)}
              >
                <div className="meta" style={{ marginTop: 0, marginBottom: 6 }}>
                  <span className="tier-badge">{String(m.quality_mode ?? "") || "local"}</span>
                  <span>{t("meetings.minutesShort", { minutes: Math.max(1, Math.round(dur / 60)) })}</span>
                  {m.ts != null && (
                    <span>{new Date(Number(m.ts) * 1000).toLocaleString("de-DE")}</span>
                  )}
                </div>
                <div
                  className="text"
                  style={
                    isOpen
                      ? {}
                      : {
                          maxHeight: 38,
                          overflow: "hidden",
                          maskImage: "linear-gradient(#000 60%, transparent)",
                        }
                  }
                >
                  {text}
                </div>
              </div>

              {isOpen && speakerText && (
                <div
                  style={{
                    marginTop: 10,
                    padding: 12,
                    borderRadius: 10,
                    background: "rgba(91,157,255,0.07)",
                    border: "1px solid rgba(91,157,255,0.25)",
                  }}
                >
                  <b style={{ color: "#5b9dff", fontSize: "0.8rem" }}>{t("meetings.bySpeaker")}</b>
                  <div className="text" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>
                    {speakerText}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                {ACTIONS.map((a) => {
                  const label = t(a.labelKey);
                  return (
                    <button
                      key={a.style}
                      className="sub-tab"
                      disabled={busy !== null}
                      onClick={() => run(i, a.style, label)}
                    >
                      {busy === `${i}:${a.style}` ? "…" : label}
                    </button>
                  );
                })}
              </div>

              {res && (
                <div
                  style={{
                    marginTop: 10,
                    padding: 12,
                    borderRadius: 10,
                    background: "rgba(34,211,238,0.06)",
                    border: "1px solid rgba(34,211,238,0.25)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 6,
                    }}
                  >
                    <b style={{ color: "#22d3ee", fontSize: "0.85rem" }}>{res.label}</b>
                    <button
                      className="sub-tab"
                      onClick={async () => {
                        await copyText(res.text).catch(() => {});
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1200);
                      }}
                    >
                      {copied ? t("common.copied") : t("common.copy")}
                    </button>
                  </div>
                  <div className="text" style={{ whiteSpace: "pre-wrap" }}>
                    {res.text}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
