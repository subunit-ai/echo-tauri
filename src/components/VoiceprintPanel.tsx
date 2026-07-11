import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "./ConfirmDialog";
import { Toggle } from "./Toggle";
import { VoiceprintFigure } from "./VoiceprintFigure";

/**
 * Stimmabdruck — Verwaltung + Visualisierung des persistenten Account-Voiceprints
 * (TJ 2026-07-10). Server ist die einzige Wahrheit (/v1/voiceprints/me liefert
 * `completeness` 0..1 + gelernte Anker); hier wird NUR gerendert + bedient.
 * Nicht zu verwechseln mit den ephemeren Meeting-Check-in-Voiceprints des
 * lokalen Meet-Backends (pro Meeting, nie gespeichert) — dieser hier ist der
 * OPT-IN Account-Abdruck mit expliziter Einwilligung.
 */

type Me = {
  has_voiceprint: boolean;
  quality?: number;
  updated_at?: number;
  model_match?: boolean;
  adaptive_available?: boolean;
  adaptive_consent?: boolean;
  completeness?: number;
  prototypes?: {
    count: number;
    nearfield: number;
    farfield: number;
    nearfield_samples?: number;
    farfield_samples?: number;
    last_learned_at: number | null;
  };
};

const MIN_S = 20;
const MAX_S = 90;
/** Sättigungs-Ziele der beiden Lern-Quellen — identisch zur Server-Formel in /me. */
const FAR_TARGET = 3;
const NEAR_TARGET = 3;

export function VoiceprintPanel() {
  const { t } = useTranslation();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"status" | "consent" | "record" | "uploading">("status");
  const [consent, setConsent] = useState(false);
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const timers = useRef<number[]>([]);

  const load = useCallback(async () => {
    try {
      setMe(await invoke<Me>("voiceprint_me"));
      setErr("");
    } catch (e) {
      setMe(null);
      setErr(String(e) === "not_logged_in" ? t("vp.errLogin") : t("vp.errLoad"));
    }
  }, [t]);
  useEffect(() => {
    load();
  }, [load]);

  const clearTimers = useCallback(() => {
    timers.current.forEach((x) => window.clearInterval(x));
    timers.current = [];
  }, []);
  useEffect(() => () => {
    clearTimers();
    if (mode === "record") invoke("voiceprint_record_cancel").catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRecord = useCallback(async () => {
    setErr("");
    try {
      await invoke("voiceprint_record_start");
    } catch (e) {
      setErr(String(e) === "busy" ? t("vp.errBusy") : t("vp.errMic"));
      return;
    }
    setSecs(0);
    setMode("record");
    const t0 = Date.now();
    timers.current.push(
      window.setInterval(async () => {
        try {
          setLevel(await invoke<number>("voiceprint_record_level"));
        } catch {
          /* Meter ist Kosmetik */
        }
      }, 80),
      window.setInterval(() => {
        const el = Math.floor((Date.now() - t0) / 1000);
        setSecs(el);
        if (el >= MAX_S) void finishRecord();
      }, 250),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  const finishRecord = useCallback(async () => {
    clearTimers();
    setMode("uploading");
    try {
      await invoke("voiceprint_record_enroll", { consent: true });
      setMode("status");
      setConsent(false);
      await load();
    } catch (e) {
      setErr(String(e));
      setMode("consent");
    }
  }, [clearTimers, load]);

  const cancelRecord = useCallback(async () => {
    clearTimers();
    await invoke("voiceprint_record_cancel").catch(() => undefined);
    setMode("consent");
  }, [clearTimers]);

  const toggleAdaptive = useCallback(
    async (on: boolean) => {
      setBusy(true);
      try {
        await invoke("voiceprint_adaptive", { enabled: on });
      } catch {
        setErr(t("vp.errChange"));
      }
      await load();
      setBusy(false);
    },
    [load, t],
  );

  const completeness = me?.completeness ?? 0;
  const protos = me?.prototypes;
  const fmtDate = (ts?: number | null) => (ts ? new Date(ts * 1000).toLocaleDateString() : "");
  // Spiegelt die Server-Formel (45 % Kern · 30 % Meeting · 25 % Diktat) — der Abdruck
  // zeigt damit dieselbe Zahl wie `completeness`, nur aufgeschlüsselt nach Quelle.
  const coreProg = me?.has_voiceprint ? (me.quality ?? 0) : 0;
  const farProg = Math.min(1, (protos?.farfield_samples ?? 0) / FAR_TARGET);
  const nearProg = Math.min(1, (protos?.nearfield_samples ?? 0) / NEAR_TARGET);

  return (
    <div className="vp-panel">
      <div className="vp-hero">
        <VoiceprintFigure
          progress={{ core: coreProg, far: farProg, near: nearProg }}
          live={level}
          recording={mode === "record"}
        />
        <div className="vp-hero-side">
          {me?.has_voiceprint ? (
            <>
              <div className="vp-pct">{Math.round(completeness * 100)}%</div>
              <div className="vp-pct-sub">{t("vp.completeSub")}</div>
              {me.model_match === false && <div className="vp-warn">{t("vp.reenrollHint")}</div>}
              <div className="vp-progress-legend">
                <div>
                  <span className="vp-dot vp-dot-core" /> {t("vp.legendCore")} ·{" "}
                  {Math.round(coreProg * 100)}%
                </div>
                <div>
                  <span className="vp-dot vp-dot-far" /> {t("vp.legendMeetings")} ·{" "}
                  {protos?.farfield_samples ?? 0}/{FAR_TARGET}
                </div>
                <div>
                  <span className="vp-dot vp-dot-near" /> {t("vp.legendDictation")} ·{" "}
                  {protos?.nearfield_samples ?? 0}/{NEAR_TARGET}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="vp-state-line">{t("vp.stateNone")}</div>
              <div className="hint">{t("vp.introHint")}</div>
            </>
          )}
        </div>
      </div>

      {err && <div className="vp-error">{err}</div>}

      {mode === "status" && (
        <>
          <div className="setting-row">
            <div className="meta">
              <div className="name">{me?.has_voiceprint ? t("vp.reenroll") : t("vp.setup")}</div>
              <div className="hint">{t("vp.setupHint")}</div>
            </div>
            <button onClick={() => setMode("consent")} disabled={!me && !!err}>
              {me?.has_voiceprint ? t("vp.reenrollBtn") : t("vp.setupBtn")}
            </button>
          </div>

          {me?.adaptive_available && me?.has_voiceprint && (
            <div className="setting-row">
              <div className="meta">
                <div className="name">{t("vp.adaptive")}</div>
                <div className="hint">{t("vp.adaptiveHint")}</div>
              </div>
              <Toggle checked={!!me.adaptive_consent} disabled={busy} onChange={toggleAdaptive} />
            </div>
          )}

          {me?.has_voiceprint && !!protos?.count && (
            <div className="setting-row">
              <div className="meta">
                <div className="name">{t("vp.learned")}</div>
                <div className="hint">
                  {t("vp.learnedDetail", {
                    meetings: protos.farfield,
                    dictations: protos.nearfield,
                  })}
                  {protos.last_learned_at ? ` · ${t("vp.lastLearned")} ${fmtDate(protos.last_learned_at)}` : ""}
                </div>
              </div>
              <button className="sub-tab" onClick={() => setConfirmReset(true)} disabled={busy}>
                {t("vp.resetBtn")}
              </button>
            </div>
          )}

          {me?.has_voiceprint && (
            <div className="setting-row">
              <div className="meta">
                <div className="name">{t("vp.delete")}</div>
                <div className="hint">{t("vp.deleteHint")}</div>
              </div>
              <button className="op-danger" onClick={() => setConfirmDel(true)} disabled={busy}>
                {t("vp.deleteBtn")}
              </button>
            </div>
          )}
        </>
      )}

      {mode === "consent" && (
        <div className="vp-flow">
          <p className="hint">{t("vp.consentText")}</p>
          <label className="vp-consent-row">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{t("vp.consentCheck")}</span>
          </label>
          <div className="vp-actions">
            <button className="op-save" disabled={!consent} onClick={startRecord}>
              {t("vp.startRecord")}
            </button>
            <button
              onClick={() => {
                setErr("");
                setMode("status");
              }}
            >
              {t("vp.back")}
            </button>
          </div>
        </div>
      )}

      {mode === "record" && (
        <div className="vp-flow">
          <p className="hint">{t("vp.readAloud")}</p>
          <div className="vp-read">
            <p>{t("vp.readText1")}</p>
            <p>{t("vp.readText2")}</p>
            <p>{t("vp.readText3")}</p>
          </div>
          <div className="vp-recline">
            <span className={"vp-live-dot" + (level > 0.06 ? " on" : "")} />
            <span className="hint">{level > 0.06 ? t("vp.hearing") : t("vp.speakUp")}</span>
            <span className="vp-secs">{secs}s</span>
          </div>
          <div className="vp-actions">
            <button className="op-save" disabled={secs < MIN_S} onClick={finishRecord}>
              {secs < MIN_S ? `${t("vp.doneIn")} ${MIN_S - secs}s…` : t("vp.finishSave")}
            </button>
            <button onClick={cancelRecord}>
              {t("vp.cancel")}
            </button>
          </div>
        </div>
      )}

      {mode === "uploading" && <p className="hint vp-upload">{t("vp.computing")}</p>}

      <ConfirmDialog
        open={confirmReset}
        title={t("vp.resetConfirmTitle")}
        message={t("vp.resetConfirmText")}
        confirmLabel={t("vp.resetBtn")}
        cancelLabel={t("vp.cancel")}
        onCancel={() => setConfirmReset(false)}
        onConfirm={async () => {
          setConfirmReset(false);
          setBusy(true);
          await invoke("voiceprint_reset_learned").catch(() => setErr(t("vp.errChange")));
          await load();
          setBusy(false);
        }}
      />
      <ConfirmDialog
        open={confirmDel}
        destructive
        title={t("vp.deleteConfirmTitle")}
        message={t("vp.deleteConfirmText")}
        confirmLabel={t("vp.deleteBtn")}
        cancelLabel={t("vp.cancel")}
        onCancel={() => setConfirmDel(false)}
        onConfirm={async () => {
          setConfirmDel(false);
          setBusy(true);
          await invoke("voiceprint_delete").catch(() => setErr(t("vp.errChange")));
          await load();
          setBusy(false);
        }}
      />
    </div>
  );
}
