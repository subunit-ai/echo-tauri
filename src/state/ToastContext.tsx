import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "info" | "success" | "error";
interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}
interface ToastApi {
  /** Show a transient toast (auto-dismisses; click to dismiss early). */
  toast: (message: string, kind?: ToastKind) => void;
}

const ToastCtx = createContext<ToastApi>({ toast: () => {} });

const LIFETIME_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const id = ++idRef.current;
      setToasts((list) => [...list, { id, message, kind }]);
      window.setTimeout(() => dismiss(id), LIFETIME_MS);
    },
    [dismiss],
  );

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            role="status"
            onClick={() => dismiss(t.id)}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx).toast;
