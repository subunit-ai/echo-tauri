import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { XpBannerHost } from "../components/XpBanner";
import { getConfig, onConfigChanged, type Config } from "../lib/ipc";

/** Root of the system-wide achievement toast window.
 *
 *  This webview is a transparent, click-through hole that floats above every
 *  app, so an unlocked word or level-up is seen where the user actually is —
 *  not buried in a backgrounded Echo window.
 *
 *  It reuses the very same `XpBannerHost` as the app (identical look, identical
 *  reward/​find handling — the events are broadcast to every window), with two
 *  satellite-window adjustments: there is no ConfigProvider here, so the config
 *  is fetched directly, and the OS window is only shown while a banner is
 *  actually on screen. */
export function ToastRoot() {
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    getConfig().then(setConfig).catch(() => {});
    // Keep the sound preference live without a restart of this window.
    const un = onConfigChanged(() => {
      getConfig().then(setConfig).catch(() => {});
    });
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  // Show the window only while something is on screen; hiding again means it
  // never sits over another app doing nothing. Failures are swallowed: a toast
  // is never important enough to surface an error to the user.
  const onActive = useCallback((active: boolean) => {
    invoke(active ? "toast_show" : "toast_hide").catch(() => {});
  }, []);

  return <XpBannerHost config={config} onActive={onActive} />;
}
