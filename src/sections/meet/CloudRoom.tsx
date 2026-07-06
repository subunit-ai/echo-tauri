/* eslint-disable @typescript-eslint/no-explicit-any */
// Cloud-Meeting HOST-Raum — native Echo-Portierung von meet-ui/screens/Host.tsx.
// Reine Präsentation: die Logik kommt verbatim aus dem geteilten Store
// (@meet/store) + Helfern (@meet/lib/format). Nur Markup/Klassen sind neu
// (mc-* Liquid-Glass), Emojis → Stroke-SVG/RecDot, i18n → react-i18next.
import { useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { useMeeting } from "@meet/store";
import { fmtDur } from "@meet/lib/format";
import { MicIcon, RecDot } from "../../components/icons";

/** Cyan/OK-Haken (Stroke) — nativer Ersatz fuer das fruehere Haken-Glyph. Farbe erbt via currentColor,
 *  die mc-* Klassen (codelbl.ok / enr-done / mini.ok) setzen den Kontext. */
function Check({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flex: "none", verticalAlign: "-2px" }}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** Native Mute-Pille (.mc-mute) — ersetzt die meet-ui MuteButton. Mic-on/off als
 *  Stroke-SVG-Swap; die Klasse `on` färbt den stummen Zustand rot (via meet.css). */
function MuteButton({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button className={"mc-mute" + (muted ? " on" : "")} onClick={onToggle}>
      {muted ? (
        <svg viewBox="0 0 24 24">
          <path d="M2 2l20 20" />
          <path d="M18.9 13.2A7.1 7.1 0 0 0 19 12v-2" />
          <path d="M5 10v2a7 7 0 0 0 12 5" />
          <path d="M15 9.3V5a3 3 0 0 0-5.7-1.3" />
          <path d="M9 9v3a3 3 0 0 0 5.1 2.1" />
          <path d="M12 19v3" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" x2="12" y1="19" y2="22" />
        </svg>
      )}
      <span>{muted ? t("meet.cloudroom.muted", "Stummgeschaltet") : t("meet.cloudroom.micOn", "Mikro an")}</span>
    </button>
  );
}

/** HOST-Raum — Portierung von `#s-host`: Code/QR/Teilen/Teilnehmer, Timer, Mute, Start/Ende. */
export function CloudRoom() {
  const { t } = useTranslation();
  const m = useMeeting();
  const [err, setErr] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);
  const [starting, setStarting] = useState(false);

  const single = m.deviceMode === "single";
  const shareUrl = "https://meet.subunit.ai/" + m.code;
  const recText = m.recOn
    ? t("meet.cloudroom.recOn", "Aufnahme läuft") + (m.muted ? t("meet.cloudroom.recMuted", " · stumm") : "")
    : m.resumeRecording
      ? t("meet.cloudroom.recPaused", "Aufnahme war unterbrochen — hier fortsetzen")
      : t("meet.cloudroom.recReady", "Bereit — Aufnahme noch nicht gestartet");

  const copyCode = () => {
    const c = (m.code || "").replace(/\D/g, "");
    if (!c) return;
    navigator.clipboard?.writeText(c).catch(() => {});
    setCodeCopied(true);
    window.setTimeout(() => setCodeCopied(false), 1300);
  };
  const copyLink = () => {
    navigator.clipboard?.writeText(shareUrl).catch(() => {});
  };
  const start = async () => {
    setErr("");
    setStarting(true);
    const r = await m.hostStartRec();
    if (!r.ok) {
      setErr(r.error || "");
      setStarting(false);
    }
  };

  return (
    <div className="mc-wrap">
      <h1 className="section-title">{m.title || t("meet.cloudroom.title", "Dein Meeting")}</h1>

      <div className="mc-rec">
        <span className={"mc-recdot " + (m.recOn ? "live" : "off")} />
        <span>{m.recMsg || recText}</span>
        {m.timer && <span className="mc-timer">{m.timer}</span>}
      </div>

      {m.recOn && <MuteButton muted={m.muted} onToggle={m.toggleMute} />}

      {m.recOn && !m.recMsg && (
        <div className="mc-lockwarn">
          <svg viewBox="0 0 24 24">
            <path d="M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <span>
            {t(
              "meet.cloudroom.lockWarn",
              "Gerät NICHT sperren & in dieser App bleiben — sonst pausiert die Aufnahme.",
            )}
          </span>
        </div>
      )}

      {!single && (
        <div>
          <div className="mc-codebox">
            <div className={"mc-codelbl" + (codeCopied ? " ok" : "")}>
              {codeCopied ? (
                <>
                  <Check /> {t("meet.cloudroom.codeCopied", "Code kopiert")}
                </>
              ) : (
                t("meet.cloudroom.joinCode", "Beitritts-Code")
              )}
            </div>
            <div
              className="mc-codebig"
              role="button"
              tabIndex={0}
              title={t("meet.cloudroom.copyCode", "Code kopieren")}
              onClick={copyCode}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  copyCode();
                }
              }}
            >
              {m.code || "––––––"}
            </div>
          </div>

          <div className="mc-qr">
            <QRCodeCanvas value={shareUrl} size={180} fgColor="#0b1b30" bgColor="#ffffff" />
          </div>

          <div className="mc-codelbl mc-center">{t("meet.cloudroom.orShareLink", "Oder Link teilen")}</div>
          <div className="mc-share">
            <input readOnly value={shareUrl} />
            <button className="sub-tab" onClick={copyLink}>
              {t("meet.cloudroom.copy", "Kopieren")}
            </button>
          </div>

          <div className="mc-sect">{t("meet.cloudroom.participants", "Teilnehmer")}</div>
          <ul className="mc-plist">
            <Participants />
          </ul>
        </div>
      )}

      {single && (
        <div className="mc-onehint">
          <svg viewBox="0 0 24 24">
            <rect x="9" y="2" width="6" height="11" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <path d="M12 17v4" />
          </svg>
          <div>
            <b>{t("meet.cloudroom.singleTitle", "Ein-Geräte-Meeting")}</b>
            <span>
              {m.singleHint ||
                t(
                  "meet.cloudroom.singleHint",
                  "Alle sprechen über dieses Mikro. Starte die Aufnahme, wenn ihr bereit seid.",
                )}
            </span>
          </div>
        </div>
      )}

      {m.deviceMode === "pod" && <HostEnroll />}

      {!m.recOn && !m.enrolling && (
        <button
          className="sub-tab onb-primary"
          style={{ padding: "10px 18px", fontSize: 14, display: "inline-flex", alignItems: "center", gap: 8 }}
          disabled={starting}
          onClick={start}
        >
          {starting ? (
            t("meet.cloudroom.starting", "Starte…")
          ) : (
            <>
              <RecDot />
              {m.resumeRecording
                ? t("meet.cloudroom.resumeRec", "Aufnahme fortsetzen")
                : t("meet.cloudroom.startRec", "Aufnahme starten")}
            </>
          )}
        </button>
      )}

      {m.recOn && (
        <button className="mc-danger" onClick={m.hostEnd}>
          {t("meet.cloudroom.endMeeting", "Meeting beenden & auswerten")}
        </button>
      )}

      <div className="mc-err">{err}</div>
    </div>
  );
}

/** Pod-Stimm-Check-In (Host) — geführtes Auto-Enrollment: der Host-„Aufnahme
 *  starten"-Knopf treibt es; Clips kommen automatisch übers Jabra, der
 *  „erkannt"-Button bleibt als Fallback, falls eine Zahl nicht gehört wird. */
function HostEnroll() {
  const { t } = useTranslation();
  const m = useMeeting();
  const st = m.hostEnroll;
  const you = (st && st.you) || {};
  return (
    <div className="mc-enr">
      <div className="mc-sect">{t("meet.cloudroom.enrollTitle", "Stimm-Check-In")}</div>
      <div className="mc-hint" style={{ marginBottom: 2 }}>
        {t(
          "meet.cloudroom.enrollHint",
          "Jeder liest seine Zahl vor — der Pod erkennt die Stimme und ordnet den Namen automatisch zu.",
        )}
      </div>

      {you.status === "active" && (
        <div className="mc-enr-me mc-active" style={{ margin: "8px 0" }}>
          <div className="mc-enr-prompt" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <MicIcon /> {t("meet.cloudroom.enrollYourTurn", "Du bist dran")} —{" "}
            {t("meet.cloudroom.enrollReadNumber", "Lies deine Zahl laut vor:")}
          </div>
          <div className="mc-enr-code">
            {String(you.code || "")
              .split("")
              .map((d: string, i: number) => (
                <span className="mc-enr-digit" key={i}>
                  {d}
                </span>
              ))}
          </div>
        </div>
      )}

      {you.status === "done" && (
        <div className="mc-enr-done" style={{ margin: "8px 0" }}>
          <Check /> {t("meet.cloudroom.enrollYouDone", "Deine Stimme ist erfasst.")}
        </div>
      )}

      {st ? (
        <ul className="mc-enr-list">
          {(st.roster || []).map((p: any, i: number) => (
            <li key={p.token || i} className={"mc-enr-row" + (p.status === "active" ? " cur" : "")}>
              <span className="mc-enr-name">
                {p.self ? p.name + " (" + t("meet.cloudroom.you", "du") + ")" : p.name}
              </span>
              {(p.status === "active" || p.status === "waiting") && <span className="mc-enr-num">{p.code}</span>}
              {p.status === "done" && (
                <span className="mc-enr-done">
                  <Check />
                </span>
              )}
              {p.status === "active" && (
                <>
                  <span className="mc-enr-listen" style={{ marginRight: 6 }}>
                    <span className="mc-dot" />
                    {t("meet.cloudroom.podListening", "Der Pod hört zu…")}
                  </span>
                  <button
                    className="mc-mini ok"
                    title={t("meet.cloudroom.testTrigger", "Test-Trigger (bis das echte Jabra die Zahl hört)")}
                    onClick={() => m.hostEnrollMark(p.token, "done")}
                  >
                    <Check /> {t("meet.cloudroom.recognized", "erkannt")}
                  </button>
                  <button
                    className="mc-mini rej"
                    title={t("meet.cloudroom.skip", "Überspringen")}
                    onClick={() => m.hostEnrollMark(p.token, "skipped")}
                  >
                    <svg viewBox="0 0 24 24">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </button>
                </>
              )}
              {p.status === "skipped" && (
                <span className="mc-enr-wait">{t("meet.cloudroom.skipped", "übersprungen")}</span>
              )}
              {p.status !== "active" && p.status !== "done" && p.status !== "skipped" && (
                <span className="mc-enr-wait">{t("meet.cloudroom.waiting", "wartet")}</span>
              )}
            </li>
          ))}
          {st.finished && (
            <li className="mc-enr-fin">
              <Check /> {t("meet.cloudroom.allCheckedIn", "Alle eingecheckt — Aufnahme starten")}
            </li>
          )}
        </ul>
      ) : (
        <div className="mc-hint" style={{ marginTop: 4, display: "inline-flex", alignItems: "center", gap: 6 }}>
          {t(
            "meet.cloudroom.enrollFallback",
            "Sobald du unten auf „Aufnahme starten“ tippst, läuft der Stimm-Check-In automatisch — danach startet die Aufnahme von selbst.",
          )}
        </div>
      )}
    </div>
  );
}

/** Teilnehmer-Zeilen — Portierung von renderParticipants (Gäste, ohne Host). */
function Participants() {
  const { t } = useTranslation();
  const m = useMeeting();
  const guests = (m.participants || []).filter((p: any) => p.source !== "host");
  if (!guests.length) {
    return (
      <li className="mc-prow mc-empty">
        <span className="mc-name" style={{ textAlign: "center", color: "var(--ink3)" }}>
          {t("meet.cloudroom.noneJoined", "Noch niemand beigetreten…")}
        </span>
      </li>
    );
  }
  return (
    <>
      {guests.map((p: any, i: number) => (
        <li key={p.token || i} className="mc-prow">
          <span className="mc-name">{p.name}</span>
          {p.email ? (
            <span className="mc-pmail">{p.email}</span>
          ) : (
            <span className="mc-pmail none">{t("meet.cloudroom.noEmail", "keine E-Mail")}</span>
          )}
          {p.pending ? (
            <>
              <button className="mc-mini ok" onClick={() => m.approve(p.token, true)}>
                {t("meet.cloudroom.approve", "Freigeben")}
              </button>
              <button className="mc-mini rej" onClick={() => m.approve(p.token, false)}>
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </>
          ) : p.connected ? (
            <span className="mc-pill live">{t("meet.cloudroom.live", "live")}</span>
          ) : p.left_at_relative ? (
            <span className="mc-pill gone">
              {t("meet.cloudroom.leftAt", "verlassen bei")}{" "}
              {p.left_at_elapsed != null ? fmtDur(p.left_at_elapsed) : p.left_at_relative || "—"}
            </span>
          ) : (
            <span className="mc-pill wait">{t("meet.cloudroom.joined", "beigetreten")}</span>
          )}
        </li>
      ))}
    </>
  );
}
