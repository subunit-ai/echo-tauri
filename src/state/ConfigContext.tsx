import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getConfig, onConfigChanged, setConfig, type Config } from "../lib/ipc";
import { setLanguage } from "../i18n";

interface Ctx {
  config: Config | null;
  /** Merge a partial patch into the config and persist it to disk. */
  patch: (p: Partial<Config>) => Promise<void>;
  /** Re-fetch the config from Rust (e.g. after login changes tokens). */
  reload: () => Promise<void>;
  /** Explicitly re-persist the current config (the manual "Speichern" button —
   * additive on top of auto-save, just for the reassurance of clicking it). */
  save: () => Promise<void>;
  /** Timestamp of the last successful save — drives the "Gespeichert ✓" hint. */
  savedTick: number;
}

const ConfigCtx = createContext<Ctx>({
  config: null,
  patch: async () => {},
  reload: async () => {},
  save: async () => {},
  savedTick: 0,
});

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setLocal] = useState<Config | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  // Keep a live ref so the (stable) save() always persists the latest config.
  const configRef = useRef<Config | null>(null);
  configRef.current = config;

  useEffect(() => {
    getConfig()
      .then((c) => {
        setLocal(c);
        setLanguage(c.ui_language); // apply the saved UI language on startup
      })
      .catch((e) => console.error("getConfig failed", e));
  }, []);

  // Reflect the UI theme on <html data-theme> whenever it changes.
  useEffect(() => {
    if (config) {
      document.documentElement.setAttribute("data-theme", config.ui_theme);
    }
  }, [config?.ui_theme]);

  const patch = useCallback(
    async (p: Partial<Config>) => {
      setLocal((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...p };
        // Persist (fire-and-forget; surface errors in console). On success bump
        // savedTick so the UI can flash a "Gespeichert ✓" confirmation.
        setConfig(next)
          .then(() => setSavedTick(Date.now()))
          .catch((e) => console.error("setConfig failed", e));
        return next;
      });
    },
    [],
  );

  const reload = useCallback(async () => {
    try {
      setLocal(await getConfig());
    } catch (e) {
      console.error("reload failed", e);
    }
  }, []);

  const save = useCallback(async () => {
    const c = configRef.current;
    if (!c) return;
    try {
      await setConfig(c);
      setSavedTick(Date.now());
    } catch (e) {
      console.error("save failed", e);
    }
  }, []);

  // Orb-satellite cycles / drags mutate the config from the overlay window →
  // reload so the main window (mode switch, settings, position) stays in sync.
  useEffect(() => {
    const sub = onConfigChanged(() => {
      void reload();
    });
    return () => {
      sub.then((un) => un());
    };
  }, [reload]);

  return (
    <ConfigCtx.Provider value={{ config, patch, reload, save, savedTick }}>
      {children}
    </ConfigCtx.Provider>
  );
}

export const useConfig = () => useContext(ConfigCtx);
