/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { useI18n } from "../lib/i18n";
import { useMeeting } from "../store";
import { fmtDur } from "../lib/format";
import { MuteButton } from "../components/MuteButton";

/** HOST ROOM — 1:1 port of `#s-host`: code/QR/share/participants, timer, mute, start/end. */
export function Host() {
  const { t } = useI18n();
  const m = useMeeting();
  const [err, setErr] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);
  const [starting, setStarting] = useState(false);

  const single = m.deviceMode === "single";
  const shareUrl = "https://meet.subunit.ai/" + m.code;
  const recText = m.recOn
    ? "Aufnahme läuft" + (m.muted ? " · stumm" : "")
    : m.resumeRecording
      ? "Aufnahme war unterbrochen — hier fortsetzen"
      : "Bereit — Aufnahme noch nicht gestartet";

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
    <div className="wrap" id="s-host">
      <h1 className="ptitle" id="host-title">
        {m.title || t("Dein Meeting")}
      </h1>
      <div className="rec">
        <span className={"recdot " + (m.recOn ? "live" : "off")} id="host-recdot"></span>
        <span id="host-rectxt">{m.recMsg || recText}</span>
        {m.timer && (
          <span id="host-timer" className="rectimer">
            {m.timer}
          </span>
        )}
      </div>
      {m.recOn && <MuteButton muted={m.muted} onToggle={m.toggleMute} />}
      {m.recOn && !m.recMsg && (
        <div className="lockwarn" id="host-lockwarn">
          📵 Gerät NICHT sperren &amp; in dieser App bleiben — sonst pausiert die Aufnahme.
        </div>
      )}

      {!single && (
        <div id="host-multionly">
          <div className="codebox">
            <div className="codelbl" style={codeCopied ? { color: "var(--ok)" } : undefined}>
              {codeCopied ? "✓ Code kopiert" : t("Beitritts-Code")}
            </div>
            <div
              className="codebig"
              id="host-code"
              role="button"
              tabIndex={0}
              title="Code kopieren"
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
          <div id="qr">
            <QRCodeCanvas value={shareUrl} size={180} fgColor="#0b1b30" bgColor="#ffffff" />
          </div>
          <div className="codelbl center">{t("Oder Link teilen")}</div>
          <div className="share">
            <input id="host-link" className="fld" readOnly value={shareUrl} />
            <button className="btn btn-ghost minibtn" onClick={copyLink}>
              {t("Kopieren")}
            </button>
          </div>
          <div className="sect">{t("Teilnehmer")}</div>
          <ul className="plist" id="host-plist">
            <Participants />
          </ul>
        </div>
      )}

      {single && (
        <div id="host-singlehint" className="onehint">
          <svg viewBox="0 0 24 24">
            <rect x="9" y="2" width="6" height="11" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <path d="M12 17v4" />
          </svg>
          <div>
            <b>{t("Ein-Geräte-Meeting")}</b>
            <span id="host-singlesub">{m.singleHint || t("Alle sprechen über dieses Mikro. Starte die Aufnahme, wenn ihr bereit seid.")}</span>
          </div>
        </div>
      )}

      {m.deviceMode === "pod" && <HostEnroll />}

      {!m.recOn && !m.enrolling && (
        <>
          <button className="btn btn-primary" id="host-startbtn" disabled={starting} onClick={start}>
            {starting ? "Starte…" : m.resumeRecording ? "🔴 Aufnahme fortsetzen" : "🔴 Aufnahme starten"}
          </button>
        </>
      )}
      {m.recOn && (
        <button className="btn btn-danger" id="host-endbtn" onClick={m.hostEnd}>
          Meeting beenden &amp; auswerten
        </button>
      )}
      <div className="err" id="host-err">
        {err}
      </div>
    </div>
  );
}

/** Pod voice check-in roster (host) — guided auto-enrollment (TJ 2026-06-10): the host's
 *  "Aufnahme starten" drives it; clips are captured automatically via the Jabra, and the
 *  "✓ erkannt" button stays as a fallback if a number isn't heard. */
function HostEnroll() {
  const { t } = useI18n();
  const m = useMeeting();
  const st = m.hostEnroll;
  const you = (st && st.you) || {};
  return (
    <div id="host-enroll">
      <div className="sect">{t("Stimm-Check-In")}</div>
      <div className="hint" style={{ marginBottom: 2 }}>
        {t("Jeder liest seine Zahl vor — der Pod erkennt die Stimme und ordnet den Namen automatisch zu.")}
      </div>
      {/* Host sits at the pod and reads a number too — show it prominently on their turn. */}
      {you.status === "active" && (
        <div id="host-enrollme" className="enr-active" style={{ margin: "8px 0" }}>
          <div className="enr-prompt">
            🎙️ {t("Du bist dran")} — {t("Lies deine Zahl laut vor:")}
          </div>
          <div className="enr-code">
            {String(you.code || "")
              .split("")
              .map((d, i) => (
                <span className="enr-digit" key={i}>
                  {d}
                </span>
              ))}
          </div>
        </div>
      )}
      {you.status === "done" && (
        <div id="host-enrollme" style={{ color: "var(--ok)", fontWeight: 600, margin: "8px 0" }}>
          ✓ Deine Stimme ist erfasst.
        </div>
      )}
      {st ? (
        <ul className="plist" id="host-enrolllist">
          {(st.roster || []).map((p: any, i: number) => (
            <li key={p.token || i} className={"enr-row" + (p.status === "active" ? " cur" : "")}>
              <span className="enr-rn">{p.self ? p.name + " (" + t("du") + ")" : p.name}</span>
              {(p.status === "active" || p.status === "waiting") && <span className="enr-rc">{p.code}</span>}
              {p.status === "done" && <span className="enr-st d">✓</span>}
              {p.status === "active" && (
                <>
                  <span className="enr-listen" style={{ marginRight: 6 }}>
                    <span className="dot"></span>
                    {t("Der Pod hört zu…")}
                  </span>
                  <button className="btn ok minibtn" title={t("Test-Trigger (bis das echte Jabra die Zahl hört)")} onClick={() => m.hostEnrollMark(p.token, "done")}>
                    {t("✓ erkannt")}
                  </button>
                  <button className="btn rej minibtn" title={t("Überspringen")} onClick={() => m.hostEnrollMark(p.token, "skipped")}>
                    ›
                  </button>
                </>
              )}
              {p.status === "skipped" && <span className="enr-st w">{t("übersprungen")}</span>}
              {p.status !== "active" && p.status !== "done" && p.status !== "skipped" && <span className="enr-st w">{t("wartet")}</span>}
            </li>
          ))}
          {st.finished && <li className="enr-fin">{t("Alle eingecheckt ✓ — Aufnahme starten")}</li>}
        </ul>
      ) : (
        <div className="hint" style={{ marginTop: 4 }}>
          Sobald du unten auf „🔴 Aufnahme starten" tippst, läuft der Stimm-Check-In automatisch — danach startet die Aufnahme von selbst.
        </div>
      )}
    </div>
  );
}

/** Participant rows — 1:1 port of renderParticipants. */
function Participants() {
  const m = useMeeting();
  const guests = (m.participants || []).filter((p: any) => p.source !== "host");
  if (!guests.length) {
    return (
      <li className="empty">
        <span className="nm" style={{ textAlign: "center", color: "var(--ink3)" }}>
          {"Noch niemand beigetreten…"}
        </span>
      </li>
    );
  }
  return (
    <>
      {guests.map((p: any, i: number) => (
        <li key={p.token || i}>
          <span className="nm">{p.name}</span>
          {p.email ? <span className="pmail">{p.email}</span> : <span className="pmail none">keine E-Mail</span>}
          {p.pending ? (
            <>
              <button className="btn ok minibtn" onClick={() => m.approve(p.token, true)}>
                Freigeben
              </button>
              <button className="btn rej minibtn" onClick={() => m.approve(p.token, false)}>
                ✕
              </button>
            </>
          ) : p.connected ? (
            <span className="pill live">● live</span>
          ) : p.left_at_relative ? (
            <span className="pill gone">
              ○ verlassen bei {p.left_at_elapsed != null ? fmtDur(p.left_at_elapsed) : p.left_at_relative || "—"}
            </span>
          ) : (
            <span className="pill wait">beigetreten</span>
          )}
        </li>
      ))}
    </>
  );
}
