import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  authSessionExpired,
  onSessionExpired,
  onSessionRestored,
} from "../lib/ipc";

/**
 * Live "is the cloud session dead?" signal. Seeds from the backend on mount (so it
 * survives a relaunch while expired) and then tracks the session-expired /
 * session-restored events, which Rust emits the instant a background refresh fails
 * or a fresh sign-in succeeds. Shared by the global banner and the Account tab.
 */
export function useSessionExpired(): boolean {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    let alive = true;
    authSessionExpired()
      .then((v) => {
        if (alive) setExpired(v);
      })
      .catch(() => {});
    const un1 = onSessionExpired(() => setExpired(true));
    const un2 = onSessionRestored(() => setExpired(false));
    return () => {
      alive = false;
      un1.then((f) => f());
      un2.then((f) => f());
    };
  }, []);
  return expired;
}

/**
 * Unmissable top bar shown when the saved cloud session has expired. Echo used to
 * just degrade silently — the account tab still read "signed in", and the only hint
 * was a transient 401 toast on the next dictate. This makes re-login obvious and
 * one click away; it vanishes automatically the moment the session is restored.
 */
export function SessionBanner() {
  const { t } = useTranslation();
  const expired = useSessionExpired();
  const [busy, setBusy] = useState(false);

  if (!expired) return null;

  const reLogin = async () => {
    setBusy(true);
    try {
      // On success Rust emits session-restored → the banner hides itself.
      await invoke("login");
    } catch {
      // Login cancelled/failed: leave the banner up so the user can retry.
    }
    setBusy(false);
  };

  return (
    <div className="session-banner" role="alert">
      <span className="session-banner-dot" />
      <span className="session-banner-text">{t("session.expired")}</span>
      <button
        className="session-banner-btn"
        onClick={busy ? undefined : reLogin}
        disabled={busy}
      >
        {busy ? t("session.opening") : t("session.signInAgain")}
      </button>
    </div>
  );
}
