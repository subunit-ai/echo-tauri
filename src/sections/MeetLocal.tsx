// Lokales Meeting (Pro): die komplette Pod-Pipeline läuft auf diesem Gerät —
// Aufnahme, Stimm-Check-In, Transkription, Sprecher-Trennung. Audio verlässt
// das Gerät nie. Konsumiert die meet_local_* IPC-Commands; Live-Status kommt
// per Event (echo://meet-local) + Polling-Fallback.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MicIcon } from "../components/icons";
import {
  getConfig,
  hardwareInfo,
  meetLocalAddParticipant,
  meetLocalAvailable,
  meetLocalCheckin,
  meetLocalDismiss,
  meetLocalGet,
  meetLocalStart,
  meetLocalStop,
  onMeetLocal,
  meetLocalStatus,
  type HardwareInfo,
  type MeetLocalAvailability,
  type MeetLocalSnapshot,
} from "../lib/ipc";

/** Clean stroke icons for the device-scan checklist — cyan check (accent, not
 *  traffic-light green) / neutral cross, both glass-styled. */
function GateIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--cyan)"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ filter: "drop-shadow(0 0 6px rgba(34,211,238,0.5))" }}
    >
      <path d="M4.5 12.5l5 5 10-11" />
    </svg>
  ) : (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--ink3)"
      strokeWidth="2.4"
      strokeLinecap="round"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function fmtDur(s: number) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** Person-Icon (Stroke) für noch nicht eingecheckte Teilnehmer — kein Emoji (Enterprise). */
function PersonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ink3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}

export function MeetLocal({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const { t } = useTranslation();
  const [avail, setAvail] = useState<MeetLocalAvailability | null>(null);
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [plan, setPlan] = useState<string>("");
  // Staged "device scan": the checklist rows reveal one by one so the user
  // SEES the probe happen (0..rows, then +1 for the verdict).
  const [scanStep, setScanStep] = useState(0);
  const [snap, setSnap] = useState<MeetLocalSnapshot | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [transcript, setTranscript] = useState<string | null>(null);
  // Während des Check-Ins: die Zahl GROSS anzeigen (Host-Schirm = Anzeige).
  const checkinCode = snap?.checkin_active
    ? snap.participants.find((p) => p.name === snap.checkin_active)?.code ?? null
    : null;
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(() => {
    meetLocalAvailable().then(setAvail).catch(() => {});
    meetLocalStatus().then(setSnap).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    hardwareInfo().then(setHw).catch(() => {});
    getConfig()
      .then((c) => setPlan(c.plan || "free"))
      .catch(() => {});
    const un = onMeetLocal(setSnap);
    // Polling-Fallback (1 s): duration/level laufen auch ohne Events weiter.
    pollRef.current = window.setInterval(() => {
      meetLocalStatus().then((s) => s && setSnap(s)).catch(() => {});
    }, 1000);
    return () => {
      un.then((f) => f());
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  // Scan-Inszenierung: sobald Probe-Daten da sind, Zeilen nacheinander zeigen.
  useEffect(() => {
    if (snap || !avail || !hw) return;
    setScanStep(0);
    const iv = window.setInterval(() => {
      setScanStep((s) => (s >= 4 ? (window.clearInterval(iv), s) : s + 1));
    }, 280);
    return () => window.clearInterval(iv);
  }, [snap, avail, hw]);

  // Fertiges Meeting → Transkript nachladen.
  useEffect(() => {
    if (snap?.phase === "done" && !transcript) {
      meetLocalGet(snap.meeting_id)
        .then((r) => setTranscript(r.transcript))
        .catch(() => {});
    }
  }, [snap?.phase, snap?.meeting_id, transcript]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await meetLocalStart(); // lädt fehlende Modelle beim ersten Mal (dauert!)
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  };

  const addParticipant = async () => {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      await meetLocalAddParticipant(name);
      setNewName("");
    } catch (e) {
      setError(String(e));
    }
  };

  const checkin = async (name: string) => {
    setError(null);
    try {
      await meetLocalCheckin(name);
    } catch (e) {
      setError(String(e));
    }
  };

  const close = async () => {
    await meetLocalDismiss().catch(() => {});
    onClose();
  };

  // ── Gate-/Start-Ansicht: Geräte-Scan ──
  if (!snap) {
    const appleSilicon = hw?.os === "macos" && hw?.arch === "aarch64";
    const hwDetail = hw
      ? `${hw.os === "macos" ? "macOS" : hw.os} · ${hw.arch} · ${hw.cpu_cores} ${t("meetLocal.scanCores")} · ${Math.round(hw.ram_gb)} GB RAM`
      : "…";
    const gates = avail && [
      {
        key: "built",
        ok: avail.built,
        label: t("meetLocal.gateBuilt"),
        detail: avail.built ? t("meetLocal.gateBuiltOk") : t("meetLocal.gateBuiltFail"),
      },
      {
        key: "plan",
        ok: avail.plan_ok,
        label: t("meetLocal.gatePlan"),
        detail: avail.plan_ok
          ? t("meetLocal.gatePlanOk", { plan })
          : t("meetLocal.gatePlanFail", { plan: plan || "free" }),
      },
      {
        key: "hw",
        ok: avail.hw_ok,
        label: t("meetLocal.gateHw"),
        detail: hwDetail,
        why: avail.hw_ok
          ? appleSilicon
            ? t("meetLocal.hwWhySilicon")
            : t("meetLocal.hwWhyRam", { ram: Math.round(hw?.ram_gb ?? 0) })
          : t("meetLocal.hwWhyFail", { ram: Math.round(hw?.ram_gb ?? 0) }),
      },
    ];
    const ready = !!avail && avail.built && avail.plan_ok && avail.hw_ok;
    return (
      <div>
        {!embedded && <h1 className="section-title">{t("meetLocal.title")}</h1>}
        <p className="section-sub" style={{ maxWidth: 560 }}>{t("meetLocal.pitch")}</p>
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="ml-scan-head">
            <span className="ml-scan-title">{t("meetLocal.scanTitle")}</span>
            <span className={`ml-scan-sub ${scanStep < 3 ? "scanning" : ""}`}>
              {scanStep < 3 ? t("meetLocal.scanning") : hwDetail}
            </span>
          </div>
          {gates && (
            <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
              {gates.map((g, i) => (
                <div key={g.key} className={`ml-gate ${scanStep > i ? "show" : ""} ${g.ok ? "" : "fail"}`}>
                  <span className="ml-gate-ico">
                    <GateIcon ok={g.ok} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="ml-gate-label">{g.label}</div>
                    <div className="ml-gate-detail">{g.detail}</div>
                    {g.why && <div className="ml-gate-why">{g.why}</div>}
                  </div>
                </div>
              ))}
              <div className={`ml-verdict ${scanStep >= 4 ? "show" : ""} ${ready ? "" : "fail"}`}>
                {ready ? t("meetLocal.verdictOk") : t("meetLocal.verdictFail")}
              </div>
            </div>
          )}
          {avail && !avail.speaker_model && (
            <p className="section-sub" style={{ margin: "0 0 14px" }}>
              {t("meetLocal.modelHint")}
            </p>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <button
              className="sub-tab onb-primary"
              style={{
                padding: "10px 18px",
                fontSize: 14,
                opacity: ready && !starting ? 1 : 0.45,
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
              }}
              disabled={!ready || starting}
              onClick={start}
            >
              <MicIcon />
              {starting ? t("meetLocal.starting") : t("meetLocal.start")}
            </button>
            {!embedded && (
              <button className="sub-tab" style={{ padding: "10px 18px" }} onClick={onClose}>
                {t("common.back")}
              </button>
            )}
          </div>
          {error && <p style={{ color: "var(--danger, #f66)", marginTop: 12 }}>{error}</p>}
        </div>
      </div>
    );
  }

  // ── Check-In-Overlay: Zahl GROSS für den Raum ──
  if (checkinCode && snap.phase === "recording") {
    return (
      <div style={{ textAlign: "center", paddingTop: 40 }}>
        <p className="section-sub" style={{ fontSize: 16 }}>
          {t("meetLocal.checkinPrompt", { name: snap.checkin_active })}
        </p>
        <div
          style={{
            fontSize: 110,
            fontWeight: 800,
            letterSpacing: "0.18em",
            fontVariantNumeric: "tabular-nums",
            margin: "24px 0 8px",
            lineHeight: 1.1,
          }}
        >
          {checkinCode.split("").join(" ")}
        </div>
        <p className="section-sub">{t("meetLocal.checkinHint")}</p>
      </div>
    );
  }

  // ── Live- / Processing- / Done-Ansicht ──
  const phaseLabel: Record<string, string> = {
    recording: t("meetLocal.phaseRecording"),
    processing: t("meetLocal.phaseProcessing"),
    done: t("meetLocal.phaseDone"),
    error: snap.message ?? t("meetLocal.phaseError"),
  };
  const lastResult = snap.checkin_result?.split(":") ?? null; // ["ok"|"failed", name]

  return (
    <div>
      {embedded ? (
        <div style={{ margin: "0 0 14px" }}>
          <span className="tier-badge">{phaseLabel[snap.phase]}</span>
        </div>
      ) : (
        <h1 className="section-title" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {t("meetLocal.title")}
          <span className="tier-badge">{phaseLabel[snap.phase]}</span>
        </h1>
      )}

      <div className="card" style={{ maxWidth: 640 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
          {snap.phase === "recording" && (
            <span
              aria-hidden
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: "#f55",
                transform: `scale(${1 + Math.min(snap.level, 1) * 0.9})`,
                transition: "transform 120ms ease-out",
              }}
            />
          )}
          <span style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            {fmtDur(snap.duration_s)}
          </span>
          <span className="section-sub" style={{ margin: 0 }}>
            {t("meetLocal.segments", { count: snap.segments_done })}
          </span>
        </div>

        {snap.phase === "recording" && (
          <>
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: "12px 0 8px" }}>
              {t("meetLocal.participants")}
            </h3>
            {snap.participants.length === 0 && (
              <p className="section-sub" style={{ marginTop: 0 }}>
                {t("meetLocal.participantsEmpty")}
              </p>
            )}
            {snap.participants.map((p) => (
              <div
                key={p.name}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: "1px solid var(--border, rgba(255,255,255,0.06))" }}
              >
                <span style={{ display: "grid", placeItems: "center", width: 18 }}>
                  {p.enrolled ? <GateIcon ok /> : <PersonIcon />}
                </span>
                <span style={{ fontWeight: 600, flex: 1 }}>{p.name}</span>
                {!p.enrolled && (
                  <button className="sub-tab" onClick={() => checkin(p.name)}>
                    {t("meetLocal.checkinStart")}
                  </button>
                )}
              </div>
            ))}
            {lastResult && lastResult[0] === "failed" && (
              <p style={{ color: "var(--danger, #f66)", margin: "8px 0" }}>
                {t("meetLocal.checkinFailed", { name: lastResult[1] })}
              </p>
            )}
            <div style={{ display: "flex", gap: 8, margin: "10px 0 18px" }}>
              <input
                type="text"
                style={{ flex: 1 }}
                placeholder={t("meetLocal.namePlaceholder")}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addParticipant()}
              />
              <button className="sub-tab" onClick={addParticipant}>
                {t("meetLocal.addParticipant")}
              </button>
            </div>
            <button
              className="sub-tab onb-primary"
              style={{ padding: "10px 18px", fontSize: 14 }}
              onClick={() => meetLocalStop().catch((e) => setError(String(e)))}
            >
              {t("meetLocal.stop")}
            </button>
          </>
        )}

        {snap.phase === "processing" && (
          <p className="section-sub">{t("meetLocal.processingHint")}</p>
        )}

        {snap.phase === "done" && (
          <>
            {transcript ? (
              <pre
                className="text"
                style={{ whiteSpace: "pre-wrap", maxHeight: 420, overflow: "auto" }}
              >
                {transcript}
              </pre>
            ) : (
              <p className="section-sub">{t("common.loading")}</p>
            )}
            <button
              className="sub-tab onb-primary"
              style={{ padding: "10px 18px", marginTop: 12 }}
              onClick={close}
            >
              {t("common.close")}
            </button>
          </>
        )}

        {snap.phase === "error" && (
          <>
            <p style={{ color: "var(--danger, #f66)" }}>{snap.message}</p>
            <button className="sub-tab" style={{ padding: "10px 18px" }} onClick={close}>
              {t("common.close")}
            </button>
          </>
        )}

        {error && <p style={{ color: "var(--danger, #f66)", marginTop: 12 }}>{error}</p>}
      </div>
    </div>
  );
}
