import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { installUpdate, onUpdateAvailable, onUpdateProgress } from "../lib/ipc";

/**
 * Auto-update banner. The startup check emits `echo://update-available` when a
 * newer signed release exists; this shows a one-click prompt. Clicking installs
 * silently (download → install → relaunch) — no installer wizard, no manual steps.
 */
export function UpdatePrompt() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState("");

  useEffect(() => {
    const un = onUpdateAvailable((v) => setVersion(v));
    const unp = onUpdateProgress((p) => setPct(p));
    return () => {
      un.then((f) => f());
      unp.then((f) => f());
    };
  }, []);

  if (!version) return null;

  const doInstall = async () => {
    setInstalling(true);
    setErr("");
    try {
      const did = await installUpdate(); // on success the app restarts (never resolves)
      if (!did) setVersion(null);
    } catch (e) {
      setErr(String(e));
      setInstalling(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 14,
        maxWidth: 680,
        width: "calc(100% - 32px)",
        padding: "11px 14px",
        borderRadius: 12,
        background: "rgba(11,22,38,0.96)",
        border: "1px solid rgba(34,211,238,0.4)",
        boxShadow: "0 14px 40px -12px rgba(0,0,0,0.6)",
        backdropFilter: "blur(8px)",
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: "#22d3ee",
          boxShadow: "0 0 10px #22d3ee",
          flex: "none",
        }}
      />
      <div style={{ flex: 1, fontSize: "0.85rem", color: "#e6eefb", lineHeight: 1.35 }}>
        {installing ? (
          <>
            <b>
              {pct > 0
                ? t("update.installingPct", { pct: Math.round(pct) })
                : t("update.installing")}
            </b>
            <span style={{ color: "#93a4bd" }}> {t("update.restartHint")}</span>
          </>
        ) : err ? (
          <>
            <b style={{ color: "#ffb4b4" }}>{t("update.failed")}</b>{" "}
            <span style={{ color: "#93a4bd" }}>{err}</span>
          </>
        ) : (
          <>
            <b>{t("update.available", { version })}</b>
            <span style={{ color: "#93a4bd" }}> {t("update.oneClickHint")}</span>
          </>
        )}
        {installing && (
          <div
            style={{
              marginTop: 8,
              height: 5,
              borderRadius: 999,
              background: "rgba(255,255,255,0.1)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.max(4, pct)}%`,
                background: "#22d3ee",
                borderRadius: 999,
                transition: "width 0.2s ease",
              }}
            />
          </div>
        )}
      </div>
      {!installing && (
        <div style={{ display: "flex", gap: 8, flex: "none" }}>
          {!err && (
            <button
              onClick={doInstall}
              style={{
                border: "none",
                background: "#22d3ee",
                color: "#04222a",
                fontWeight: 700,
                fontSize: "0.82rem",
                padding: "8px 16px",
                borderRadius: 9,
                cursor: "pointer",
              }}
            >
              {t("update.updateNow")}
            </button>
          )}
          <button
            onClick={() => setVersion(null)}
            style={{
              border: "1px solid rgba(255,255,255,0.18)",
              background: "transparent",
              color: "#93a4bd",
              fontSize: "0.82rem",
              padding: "8px 14px",
              borderRadius: 9,
              cursor: "pointer",
            }}
          >
            {t("update.later")}
          </button>
        </div>
      )}
    </div>
  );
}
