import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { installUpdate, onUpdateAvailable, onUpdateProgress } from "../lib/ipc";

/**
 * Top-bar update affordance. The background check (lib.rs, on launch + every 3 h)
 * emits `echo://update-available`; this surfaces a glowing "Jetzt aktualisieren"
 * pill right in the header. One click installs silently (download → install →
 * relaunch) with inline progress. Hidden when no update is pending.
 */
export function HeaderUpdate() {
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

  const label = installing
    ? pct > 0
      ? t("update.installingPct", { pct: Math.round(pct) })
      : t("update.installing")
    : err
      ? t("update.failed")
      : t("update.updateNow");

  return (
    <button
      className={`hdr-update ${err ? "err" : ""}`}
      onClick={installing ? undefined : doInstall}
      disabled={installing}
      title={err || t("update.available", { version })}
    >
      {/* progress fill behind the label while installing */}
      {installing && <span className="hdr-update-fill" style={{ width: `${Math.max(6, pct)}%` }} />}
      <span className="hdr-update-dot" />
      <span className="hdr-update-label">
        {label}
        {!installing && !err && <b className="hdr-update-ver"> v{version}</b>}
      </span>
    </button>
  );
}
