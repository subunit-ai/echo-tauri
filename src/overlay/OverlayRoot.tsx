import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { Bubble } from "./Bubble";
import { Orb } from "./Orb";
import { setLanguage } from "../i18n";

/**
 * The overlay window renders ONE of two indicators: the interactive orb, or —
 * when the orb is off but "Bubble anzeigen" is on — the compact bubble. The
 * Rust side only opens this window when one of them is enabled and pushes
 * `orbEnabled` on config changes so we switch live without a reload.
 */
export function OverlayRoot() {
  const [orbEnabled, setOrbEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    invoke<Record<string, unknown>>("get_config")
      .then((c) => {
        setOrbEnabled(c.use_orb_overlay !== false);
        setLanguage(typeof c.ui_language === "string" ? c.ui_language : "de");
      })
      .catch(() => setOrbEnabled(true));
    const un = listen<{ orbEnabled?: boolean }>("echo://orb-config", (e) => {
      if (typeof e.payload.orbEnabled === "boolean") setOrbEnabled(e.payload.orbEnabled);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  if (orbEnabled === null) return null;
  return orbEnabled ? <Orb /> : <Bubble />;
}
