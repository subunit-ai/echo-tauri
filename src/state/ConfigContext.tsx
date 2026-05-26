import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getConfig, setConfig, type Config } from "../lib/ipc";

interface Ctx {
  config: Config | null;
  /** Merge a partial patch into the config and persist it to disk. */
  patch: (p: Partial<Config>) => Promise<void>;
}

const ConfigCtx = createContext<Ctx>({ config: null, patch: async () => {} });

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setLocal] = useState<Config | null>(null);

  useEffect(() => {
    getConfig()
      .then(setLocal)
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
        // Persist (fire-and-forget; surface errors in console).
        setConfig(next).catch((e) => console.error("setConfig failed", e));
        return next;
      });
    },
    [],
  );

  return <ConfigCtx.Provider value={{ config, patch }}>{children}</ConfigCtx.Provider>;
}

export const useConfig = () => useContext(ConfigCtx);
